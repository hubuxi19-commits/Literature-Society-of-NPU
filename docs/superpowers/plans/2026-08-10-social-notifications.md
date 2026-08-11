# 发布四：私密社交与站内通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加入关注（follow）、收藏（bookmark）、评论点赞（comment_like）三种私密社交交互，并为六类事件生成按同类聚合（+N）的站内通知。

**Architecture:** 方案 A——所有交互写入走受保护 `SECURITY DEFINER` RPC（事务内完成「写交互 + 聚合通知 + 去重 + 禁止自我通知 + 计数」），读侧私密列表走 owner 作用域 RPC、聚合计数走公开读 RPC；既有 `likes`/`comments` 两条直接表写路径迁移进 RPC 通知引擎。数据服务（demo + supabase 双模式）镜像 RPC 面；前端新增通知页与「我的」三页。

**Tech Stack:** Postgres/Supabase（SECURITY DEFINER RPC、RLS、pglite 测试）、原生 ES modules（`js/utils.mjs`/`js/data-service.mjs`/`js/app.js`）、Node test runner、Playwright。

**依赖关系：** 迁移与 RPC（Phase 1）→ 数据服务（Phase 2）→ 前端（Phase 3）→ 浏览器测试与回归（Phase 4）。Phase 3 依赖 Phase 2 的方法签名；Phase 2 的 demo 服务必须与 SQL 语义一致（聚合 +N、撤销收缩、禁止自我通知）。

---
### Task 1: 迁移完整 SQL（新表 + 通知 helper + 全部 RPC + 授权收口）

**Files:**
- Create: `supabase/migrations/20260810_social_and_notifications.sql`

本任务是发布四的数据库骨架，单独交付（一个文件、一份提交）。所有函数为 `security definer`、`set search_path = public`；写 RPC 开头统一 `auth.uid() is null → '请先登录'` + `not is_account_write_allowed() → '请先验证找回邮箱后再进行此操作'`（该函数已在 `20260802_account_recovery_security.sql` 定义）。

- [ ] **Step 1: 写迁移文件**

Run: 用 Write 创建 `supabase/migrations/20260810_social_and_notifications.sql`，内容如下（完整）：

```sql
-- SOCIAL_NOTIFICATIONS_START
-- 发布四：私密社交与站内通知。
-- 新表 follows/bookmarks/comment_likes/notifications 全部 revoke 直接授权、仅经受保护 RPC 访问；
-- 私密列表仅 owner 作用域 RPC 可读，聚合计数经公开读 RPC 暴露。
-- 依赖：is_account_write_allowed() 来自 20260802_account_recovery_security.sql。

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create index if not exists follows_following_id_idx
  on public.follows (following_id);

create table if not exists public.bookmarks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_id uuid not null references public.works(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

create index if not exists bookmarks_work_id_idx
  on public.bookmarks (work_id);

create table if not exists public.comment_likes (
  user_id uuid not null references public.profiles(id) on delete cascade,
  comment_id uuid not null references public.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

create index if not exists comment_likes_comment_id_idx
  on public.comment_likes (comment_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (event_type in (
    'work_comment', 'comment_reply', 'work_like', 'follow', 'work_bookmark', 'comment_like'
  )),
  target_work_id uuid references public.works(id) on delete cascade,
  target_comment_id uuid references public.comments(id) on delete cascade,
  actor_ids uuid[] not null default '{}',
  actor_count integer not null default 0 check (actor_count >= 1),
  last_event_at timestamptz not null default now(),
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  agg_key text not null
);

create unique index if not exists notifications_user_agg_key_idx
  on public.notifications (user_id, agg_key);

create index if not exists notifications_user_read_idx
  on public.notifications (user_id, is_read);

create index if not exists notifications_user_event_idx
  on public.notifications (user_id, last_event_at desc);

alter table public.follows enable row level security;
alter table public.bookmarks enable row level security;
alter table public.comment_likes enable row level security;
alter table public.notifications enable row level security;

-- 防御性 owner-only 读策略：revoke 之后本无授权，若未来误加 grant 仍受 RLS 约束
drop policy if exists "follows_owner_select" on public.follows;
create policy "follows_owner_select" on public.follows
  for select to authenticated using (follower_id = auth.uid());

drop policy if exists "bookmarks_owner_select" on public.bookmarks;
create policy "bookmarks_owner_select" on public.bookmarks
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "comment_likes_owner_select" on public.comment_likes;
create policy "comment_likes_owner_select" on public.comment_likes
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "notifications_owner_select" on public.notifications;
create policy "notifications_owner_select" on public.notifications
  for select to authenticated using (user_id = auth.uid());

revoke all on table public.follows from anon, authenticated;
revoke all on table public.bookmarks from anon, authenticated;
revoke all on table public.comment_likes from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;

-- ============================================================
-- 通知聚合 helper（仅内部可调，客户端角色无执行权）
-- agg_key = event_type + 目标复合串；follow 无目标时以尾部 ':' 占位，
-- 使无目标通知也能在 (user_id, agg_key) 上唯一聚合。
-- actor_ids 数组头部为最近事件者，cap 3（预览「A、B、C 等 N 人」）。
-- ============================================================

create or replace function public.upsert_notification(
  p_recipient uuid,
  p_event_type text,
  p_target_work_id uuid,
  p_target_comment_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_row public.notifications;
begin
  if p_recipient is null or p_actor is null or p_recipient = p_actor then
    return;
  end if;
  v_key := p_event_type
    || coalesce(':' || nullif(p_target_work_id::text, ''), '')
    || coalesce(':' || nullif(p_target_comment_id::text, ''), '')
    || case when p_target_work_id is null and p_target_comment_id is null then ':' else '' end;

  select *
  into v_row
  from public.notifications
  where user_id = p_recipient and agg_key = v_key
  for update;

  if v_row.id is null then
    insert into public.notifications (
      user_id, event_type, target_work_id, target_comment_id,
      actor_ids, actor_count, last_event_at, is_read, agg_key
    ) values (
      p_recipient, p_event_type, p_target_work_id, p_target_comment_id,
      array[p_actor], 1, now(), false, v_key
    );
    return;
  end if;

  if p_actor = any(v_row.actor_ids) then
    update public.notifications
    set last_event_at = now(), updated_at = now()
    where id = v_row.id;
    return;
  end if;

  update public.notifications
  set
    actor_ids = array[p_actor]
      || (select coalesce(array_agg(u), '{}')
          from (select unnest(v_row.actor_ids) u limit 2) s),
    actor_count = v_row.actor_count + 1,
    last_event_at = now(),
    updated_at = now()
  where id = v_row.id;
end;
$$;

create or replace function public.remove_notification_actor(
  p_recipient uuid,
  p_event_type text,
  p_target_work_id uuid,
  p_target_comment_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_row public.notifications;
begin
  if p_recipient is null or p_actor is null or p_recipient = p_actor then
    return;
  end if;
  v_key := p_event_type
    || coalesce(':' || nullif(p_target_work_id::text, ''), '')
    || coalesce(':' || nullif(p_target_comment_id::text, ''), '')
    || case when p_target_work_id is null and p_target_comment_id is null then ':' else '' end;

  select *
  into v_row
  from public.notifications
  where user_id = p_recipient and agg_key = v_key
  for update;

  if v_row.id is null then
    return;
  end if;
  if not (p_actor = any(v_row.actor_ids)) then
    return;
  end if;

  if v_row.actor_count <= 1 then
    delete from public.notifications where id = v_row.id;
    return;
  end if;

  update public.notifications
  set
    actor_ids = (select coalesce(array_agg(u), '{}') from unnest(v_row.actor_ids) u where u <> p_actor),
    actor_count = v_row.actor_count - 1,
    updated_at = now()
  where id = v_row.id;
end;
$$;

revoke all on function public.upsert_notification(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_notification_actor(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 写 RPC
-- ============================================================

-- 关注：单向公开，无需对方同意；禁止自我关注；幂等（重复关注不重复计数）。
create or replace function public.follow_user(p_target_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.follows;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if p_target_user_id is null then
    raise exception '关注对象不存在';
  end if;
  if p_target_user_id = auth.uid() then
    raise exception '不能关注自己';
  end if;
  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    raise exception '关注对象不存在';
  end if;

  insert into public.follows (follower_id, following_id)
  values (auth.uid(), p_target_user_id)
  on conflict (follower_id, following_id) do nothing
  returning * into v_row;

  perform public.upsert_notification(p_target_user_id, 'follow', null, null, auth.uid());
  return jsonb_build_object('follower_id', v_row.follower_id, 'following_id', v_row.following_id);
end;
$$;

-- 取关：不产生通知，把本人从对方的 follow 聚合中移除。
create or replace function public.unfollow_user(p_target_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  delete from public.follows
  where follower_id = auth.uid() and following_id = p_target_user_id;

  perform public.remove_notification_actor(p_target_user_id, 'follow', null, null, auth.uid());
end;
$$;

create or replace function public.bookmark_work(p_work_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_row public.bookmarks;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.status <> 'published' and v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  insert into public.bookmarks (user_id, work_id)
  values (auth.uid(), p_work_id)
  on conflict (user_id, work_id) do nothing
  returning * into v_row;

  perform public.upsert_notification(v_work.author_id, 'work_bookmark', p_work_id, null, auth.uid());
  return jsonb_build_object('user_id', v_row.user_id, 'work_id', v_row.work_id);
end;
$$;

-- 取消收藏：不产生通知，把本人从作者的 work_bookmark 聚合中移除。
create or replace function public.unbookmark_work(p_work_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  delete from public.bookmarks
  where user_id = auth.uid() and work_id = p_work_id;

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is not null then
    perform public.remove_notification_actor(v_work.author_id, 'work_bookmark', p_work_id, null, auth.uid());
  end if;
end;
$$;

create or replace function public.like_comment(p_comment_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_comment public.comments;
  v_row public.comment_likes;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  select *
  into v_comment
  from public.comments
  where id = p_comment_id;

  if v_comment.id is null then
    raise exception '评论不存在';
  end if;
  if v_comment.user_id = auth.uid() then
    raise exception '不能赞自己的评论';
  end if;

  insert into public.comment_likes (user_id, comment_id)
  values (auth.uid(), p_comment_id)
  on conflict (user_id, comment_id) do nothing
  returning * into v_row;

  perform public.upsert_notification(v_comment.user_id, 'comment_like', null, p_comment_id, auth.uid());
  return jsonb_build_object('user_id', v_row.user_id, 'comment_id', v_row.comment_id);
end;
$$;

create or replace function public.unlike_comment(p_comment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_comment public.comments;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  delete from public.comment_likes
  where user_id = auth.uid() and comment_id = p_comment_id;

  select *
  into v_comment
  from public.comments
  where id = p_comment_id;

  if v_comment.id is not null then
    perform public.remove_notification_actor(v_comment.user_id, 'comment_like', null, p_comment_id, auth.uid());
  end if;
end;
$$;

-- 作品点赞：从直接 likes 表操作迁移为 RPC，同一事务内发/撤 work_like 通知。
create or replace function public.toggle_like_work(p_work_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_liked boolean;
  v_like_count bigint;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.status <> 'published' and v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  if exists (
    select 1 from public.likes where work_id = p_work_id and user_id = auth.uid()
  ) then
    delete from public.likes where work_id = p_work_id and user_id = auth.uid();
    v_liked := false;
    perform public.remove_notification_actor(v_work.author_id, 'work_like', p_work_id, null, auth.uid());
  else
    insert into public.likes (work_id, user_id) values (p_work_id, auth.uid());
    v_liked := true;
    perform public.upsert_notification(v_work.author_id, 'work_like', p_work_id, null, auth.uid());
  end if;

  select count(*) into v_like_count from public.likes where work_id = p_work_id;
  return jsonb_build_object('liked', v_liked, 'like_count', v_like_count);
end;
$$;

-- 评论/回复：顶层 → work_comment（通知作品作者），回复 → comment_reply（通知被回复者）。
create or replace function public.create_comment(
  p_work_id uuid,
  p_content text,
  p_parent_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_parent public.comments;
  v_content text := btrim(coalesce(p_content, ''));
  v_comment public.comments;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if char_length(v_content) not between 1 and 2000 then
    raise exception '评论必须为 1 至 2000 个字符';
  end if;

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.status <> 'published' and v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  if p_parent_id is not null then
    select *
    into v_parent
    from public.comments
    where id = p_parent_id;

    if v_parent.id is null or v_parent.work_id <> p_work_id then
      raise exception '回复必须属于同一篇作品';
    end if;
  end if;

  insert into public.comments (work_id, user_id, parent_id, content, is_deleted)
  values (p_work_id, auth.uid(), p_parent_id, v_content, false)
  returning * into v_comment;

  if p_parent_id is null then
    perform public.upsert_notification(v_work.author_id, 'work_comment', p_work_id, null, auth.uid());
  else
    perform public.upsert_notification(v_parent.user_id, 'comment_reply', null, p_parent_id, auth.uid());
  end if;

  return jsonb_build_object(
    'id', v_comment.id,
    'work_id', v_comment.work_id,
    'user_id', v_comment.user_id,
    'parent_id', v_comment.parent_id,
    'content', v_comment.content,
    'is_deleted', v_comment.is_deleted,
    'created_at', v_comment.created_at
  );
end;
$$;

-- ============================================================
-- 既有函数改造：create_quoted_comment 追加 work_comment 通知；
-- soft_delete_comment 撤销对应聚合并清理该评论的 comment_like 通知。
-- ============================================================

create or replace function public.create_quoted_comment(
  p_work_id uuid,
  p_work_version_id uuid,
  p_quote_text text,
  p_start_offset integer,
  p_end_offset integer,
  p_content text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_version public.work_versions;
  v_quote text := btrim(coalesce(p_quote_text, ''));
  v_content text := btrim(coalesce(p_content, ''));
  v_display text := '';
  v_seg text;
  v_comment public.comments;
  v_quote_record public.comment_quotes;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if char_length(v_content) not between 1 and 2000 then
    raise exception '评论必须为 1 至 2000 个字符';
  end if;

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.status <> 'published' and v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  select *
  into v_version
  from public.work_versions
  where id = p_work_version_id
    and work_id = p_work_id;

  if v_version.id is null then
    raise exception '批注对应的作品版本不存在';
  end if;

  if char_length(v_quote) < 1 or char_length(v_quote) > 500 then
    raise exception '引用原文必须为 1 至 500 个字符';
  end if;
  if p_start_offset is null or p_end_offset is null
    or p_start_offset < 0 or p_end_offset <= p_start_offset then
    raise exception '引用位置无效';
  end if;

  for v_seg in select regexp_split_to_table(v_version.content, E'\n[ \t\r\n\v\f　]*\n') loop
    v_seg := btrim(v_seg, E' \t\r\n\v\f　');
    if v_seg <> '' then
      if v_display <> '' then
        v_display := v_display || E'\n';
      end if;
      v_display := v_display || v_seg;
    end if;
  end loop;

  if p_end_offset > char_length(v_display)
    or substr(v_display, p_start_offset + 1, p_end_offset - p_start_offset) <> v_quote then
    raise exception '引用原文与所选位置不符，请重新选择';
  end if;

  insert into public.comments (work_id, user_id, content, is_deleted)
  values (p_work_id, auth.uid(), v_content, false)
  returning * into v_comment;

  insert into public.comment_quotes (
    comment_id, work_version_id, quote_text, start_offset, end_offset
  ) values (
    v_comment.id, p_work_version_id, v_quote, p_start_offset, p_end_offset
  )
  returning * into v_quote_record;

  perform public.upsert_notification(v_work.author_id, 'work_comment', p_work_id, null, auth.uid());

  return jsonb_build_object(
    'comment', jsonb_build_object(
      'id', v_comment.id,
      'work_id', v_comment.work_id,
      'user_id', v_comment.user_id,
      'content', v_comment.content,
      'is_deleted', v_comment.is_deleted,
      'created_at', v_comment.created_at
    ),
    'quote', jsonb_build_object(
      'id', v_quote_record.id,
      'work_version_id', v_quote_record.work_version_id,
      'quote_text', v_quote_record.quote_text,
      'start_offset', v_quote_record.start_offset,
      'end_offset', v_quote_record.end_offset
    )
  );
end;
$$;

create or replace function public.soft_delete_comment(target_comment_id uuid)
returns public.comments
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_comment public.comments;
  v_work_author uuid;
  v_parent_author uuid;
begin
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  select *
  into v_comment
  from public.comments
  where id = target_comment_id;

  if v_comment.id is null then
    raise exception '评论不存在';
  end if;

  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  if v_comment.user_id <> auth.uid() and not public.is_admin() then
    raise exception '没有权限删除这条评论';
  end if;

  update public.comments
  set
    content = '',
    is_deleted = true,
    updated_at = now()
  where id = target_comment_id
  returning * into v_comment;

  -- 通知维护：顶层评论撤销 work_comment；回复撤销 comment_reply；
  -- 无论顶层还是回复，都清除该评论收到的 comment_like 通知。
  if v_comment.parent_id is null then
    select author_id into v_work_author from public.works where id = v_comment.work_id;
    perform public.remove_notification_actor(v_work_author, 'work_comment', v_comment.work_id, null, v_comment.user_id);
  else
    select user_id into v_parent_author from public.comments where id = v_comment.parent_id;
    perform public.remove_notification_actor(v_parent_author, 'comment_reply', null, v_comment.parent_id, v_comment.user_id);
  end if;

  delete from public.notifications
  where event_type = 'comment_like'
    and public.notifications.target_comment_id = v_comment.id;

  return v_comment;
end;
$$;

-- ============================================================
-- 读 / owner 状态 RPC
-- ============================================================

create or replace function public.list_notifications(
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_page_size, 20), 1), 20);
  v_uid uuid := auth.uid();
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_has_cursor boolean := false;
  v_sql text;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_at timestamptz;
  v_last_id uuid;
  v_next text := null;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select
        (payload ->> 'last_event_at')::timestamptz,
        (payload ->> 'id')::uuid
      into v_cursor_at, v_cursor_id
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    select
      n.id, n.event_type, n.target_work_id, n.target_comment_id,
      n.actor_ids, n.actor_count, n.last_event_at, n.is_read,
      coalesce(
        (select array_agg(p.pen_name order by a.ord)
         from unnest(n.actor_ids) with ordinality a(id, ord)
         join public.profiles p on p.id = a.id),
        '{}'::text[]
      ) as actor_pen_names,
      (select w.title from public.works w where w.id = n.target_work_id) as work_title,
      (select cm.work_id from public.comments cm where cm.id = n.target_comment_id) as comment_work_id
    from public.notifications n
    where n.user_id = %L
      and %s
    order by n.last_event_at desc, n.id desc
    limit %s
    $query$,
    v_uid,
    case when v_has_cursor
      then format('(n.last_event_at, n.id) < (%L::timestamptz, %L::uuid)', v_cursor_at, v_cursor_id)
      else 'true'
    end,
    v_limit + 1
  );

  for v_row in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_items := v_items || jsonb_build_object(
        'id', v_row.id,
        'event_type', v_row.event_type,
        'target_work_id', v_row.target_work_id,
        'target_comment_id', v_row.target_comment_id,
        'actor_pen_names', v_row.actor_pen_names,
        'actor_count', v_row.actor_count,
        'last_event_at', v_row.last_event_at,
        'is_read', v_row.is_read,
        'work_title', v_row.work_title,
        'comment_work_id', v_row.comment_work_id
      );
      v_last_at := v_row.last_event_at;
      v_last_id := v_row.id;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(
        jsonb_build_object('last_event_at', v_last_at, 'id', v_last_id)::text,
        'utf8'
      ),
      'base64'
    );
  end if;

  return jsonb_build_object('notifications', v_items, 'next_cursor', v_next);
end;
$$;

create or replace function public.get_notification_unread_count()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'unread_count', count(*)::int
  )
  from public.notifications
  where user_id = auth.uid()
    and is_read = false;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  update public.notifications
  set is_read = true
  where id = p_notification_id
    and user_id = auth.uid();
end;
$$;

create or replace function public.mark_all_notifications_read()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  update public.notifications
  set is_read = true
  where user_id = auth.uid();
end;
$$;

create or replace function public.list_my_following(
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_page_size, 20), 1), 20);
  v_uid uuid := auth.uid();
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_has_cursor boolean := false;
  v_sql text;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_at timestamptz;
  v_last_id uuid;
  v_next text := null;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select (payload ->> 'created_at')::timestamptz, (payload ->> 'id')::uuid
      into v_cursor_at, v_cursor_id
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    select f.following_id as id, p.pen_name, p.bio, f.created_at
    from public.follows f
    join public.profiles p on p.id = f.following_id
    where f.follower_id = %L
      and %s
    order by f.created_at desc, f.following_id desc
    limit %s
    $query$,
    v_uid,
    case when v_has_cursor
      then format('(f.created_at, f.following_id) < (%L::timestamptz, %L::uuid)', v_cursor_at, v_cursor_id)
      else 'true'
    end,
    v_limit + 1
  );

  for v_row in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_items := v_items || jsonb_build_object(
        'id', v_row.id,
        'pen_name', v_row.pen_name,
        'bio', v_row.bio,
        'created_at', v_row.created_at
      );
      v_last_at := v_row.created_at;
      v_last_id := v_row.id;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(jsonb_build_object('created_at', v_last_at, 'id', v_last_id)::text, 'utf8'),
      'base64'
    );
  end if;

  return jsonb_build_object('following', v_items, 'next_cursor', v_next);
end;
$$;

create or replace function public.list_my_followers(
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_page_size, 20), 1), 20);
  v_uid uuid := auth.uid();
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_has_cursor boolean := false;
  v_sql text;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_at timestamptz;
  v_last_id uuid;
  v_next text := null;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select (payload ->> 'created_at')::timestamptz, (payload ->> 'id')::uuid
      into v_cursor_at, v_cursor_id
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    select f.follower_id as id, p.pen_name, p.bio, f.created_at
    from public.follows f
    join public.profiles p on p.id = f.follower_id
    where f.following_id = %L
      and %s
    order by f.created_at desc, f.follower_id desc
    limit %s
    $query$,
    v_uid,
    case when v_has_cursor
      then format('(f.created_at, f.follower_id) < (%L::timestamptz, %L::uuid)', v_cursor_at, v_cursor_id)
      else 'true'
    end,
    v_limit + 1
  );

  for v_row in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_items := v_items || jsonb_build_object(
        'id', v_row.id,
        'pen_name', v_row.pen_name,
        'bio', v_row.bio,
        'created_at', v_row.created_at
      );
      v_last_at := v_row.created_at;
      v_last_id := v_row.id;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(jsonb_build_object('created_at', v_last_at, 'id', v_last_id)::text, 'utf8'),
      'base64'
    );
  end if;

  return jsonb_build_object('followers', v_items, 'next_cursor', v_next);
end;
$$;

create or replace function public.list_my_bookmarks(
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_page_size, 20), 1), 20);
  v_uid uuid := auth.uid();
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_has_cursor boolean := false;
  v_sql text;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_at timestamptz;
  v_last_id uuid;
  v_next text := null;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select (payload ->> 'created_at')::timestamptz, (payload ->> 'id')::uuid
      into v_cursor_at, v_cursor_id
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    select
      b.work_id as id, w.title, w.excerpt, w.category,
      p.pen_name as author_pen_name, b.created_at
    from public.bookmarks b
    join public.works w on w.id = b.work_id and w.status = 'published'
    join public.profiles p on p.id = w.author_id
    where b.user_id = %L
      and %s
    order by b.created_at desc, b.work_id desc
    limit %s
    $query$,
    v_uid,
    case when v_has_cursor
      then format('(b.created_at, b.work_id) < (%L::timestamptz, %L::uuid)', v_cursor_at, v_cursor_id)
      else 'true'
    end,
    v_limit + 1
  );

  for v_row in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_items := v_items || jsonb_build_object(
        'id', v_row.id,
        'title', v_row.title,
        'excerpt', v_row.excerpt,
        'category', v_row.category,
        'author_pen_name', v_row.author_pen_name,
        'created_at', v_row.created_at
      );
      v_last_at := v_row.created_at;
      v_last_id := v_row.id;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(jsonb_build_object('created_at', v_last_at, 'id', v_last_id)::text, 'utf8'),
      'base64'
    );
  end if;

  return jsonb_build_object('bookmarks', v_items, 'next_cursor', v_next);
end;
$$;

-- 聚合计数公开（作品页：收藏数 + 我的收藏态；like/comment 计数沿用 browse_works/getWork）
create or replace function public.get_work_social_counts(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_bookmark_count bigint;
  v_bookmarked boolean;
begin
  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.status <> 'published' and v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  select count(*) into v_bookmark_count from public.bookmarks where work_id = p_work_id;
  v_bookmarked := auth.uid() is not null and exists (
    select 1 from public.bookmarks where work_id = p_work_id and user_id = auth.uid()
  );

  return jsonb_build_object(
    'bookmark_count', v_bookmark_count,
    'bookmarked_by_current_user', v_bookmarked
  );
end;
$$;

-- 聚合计数公开（作者页：关注数/粉丝数 + 我的关注态）
create or replace function public.get_profile_social_counts(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'following_count', (select count(*) from public.follows where follower_id = p_profile_id),
    'followers_count', (select count(*) from public.follows where following_id = p_profile_id),
    'followed_by_current_user', (
      auth.uid() is not null
        and exists (
          select 1 from public.follows
          where follower_id = auth.uid() and following_id = p_profile_id
        )
    )
  );
$$;

-- 评论点赞态（公开计数 + 我的点赞态）
create or replace function public.get_comment_like_state(p_comment_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_row record;
begin
  if p_comment_ids is null or cardinality(p_comment_ids) = 0 then
    return jsonb_build_object('comments', '[]'::jsonb);
  end if;

  for v_row in
    select
      ids.comment_id,
      count(cl.comment_id)::bigint as like_count,
      bool_or(cl.user_id = auth.uid()) as liked_by_current_user
    from unnest(p_comment_ids) as ids(comment_id)
    left join public.comment_likes cl on cl.comment_id = ids.comment_id
    group by ids.comment_id
    order by ids.comment_id
  loop
    v_items := v_items || jsonb_build_object(
      'comment_id', v_row.comment_id,
      'like_count', v_row.like_count,
      'liked_by_current_user', coalesce(v_row.liked_by_current_user, false)
    );
  end loop;

  return jsonb_build_object('comments', v_items);
end;
$$;

-- ============================================================
-- 授权收口
-- ============================================================

-- 既有写路径迁入 RPC：作品点赞 / 评论只经受保护 RPC
revoke insert, update, delete on table public.likes from authenticated;
revoke insert, update, delete on table public.comments from authenticated;

revoke all on function public.follow_user(uuid) from public;
grant execute on function public.follow_user(uuid) to authenticated;
revoke all on function public.unfollow_user(uuid) from public;
grant execute on function public.unfollow_user(uuid) to authenticated;
revoke all on function public.bookmark_work(uuid) from public;
grant execute on function public.bookmark_work(uuid) to authenticated;
revoke all on function public.unbookmark_work(uuid) from public;
grant execute on function public.unbookmark_work(uuid) to authenticated;
revoke all on function public.like_comment(uuid) from public;
grant execute on function public.like_comment(uuid) to authenticated;
revoke all on function public.unlike_comment(uuid) from public;
grant execute on function public.unlike_comment(uuid) to authenticated;
revoke all on function public.toggle_like_work(uuid) from public;
grant execute on function public.toggle_like_work(uuid) to authenticated;
revoke all on function public.create_comment(uuid, text, uuid) from public;
grant execute on function public.create_comment(uuid, text, uuid) to authenticated;
revoke all on function public.create_quoted_comment(uuid, uuid, text, integer, integer, text) from public;
grant execute on function public.create_quoted_comment(uuid, uuid, text, integer, integer, text) to authenticated;
revoke all on function public.soft_delete_comment(uuid) from public;
grant execute on function public.soft_delete_comment(uuid) to authenticated;

revoke all on function public.list_notifications(text, integer) from public;
grant execute on function public.list_notifications(text, integer) to authenticated;
revoke all on function public.get_notification_unread_count() from public;
grant execute on function public.get_notification_unread_count() to authenticated;
revoke all on function public.mark_notification_read(uuid) from public;
grant execute on function public.mark_notification_read(uuid) to authenticated;
revoke all on function public.mark_all_notifications_read() from public;
grant execute on function public.mark_all_notifications_read() to authenticated;
revoke all on function public.list_my_following(text, integer) from public;
grant execute on function public.list_my_following(text, integer) to authenticated;
revoke all on function public.list_my_followers(text, integer) from public;
grant execute on function public.list_my_followers(text, integer) to authenticated;
revoke all on function public.list_my_bookmarks(text, integer) from public;
grant execute on function public.list_my_bookmarks(text, integer) to authenticated;

revoke all on function public.get_work_social_counts(uuid) from public;
grant execute on function public.get_work_social_counts(uuid) to anon, authenticated;
revoke all on function public.get_profile_social_counts(uuid) from public;
grant execute on function public.get_profile_social_counts(uuid) to anon, authenticated;
revoke all on function public.get_comment_like_state(uuid[]) from public;
grant execute on function public.get_comment_like_state(uuid[]) to anon, authenticated;

-- SOCIAL_NOTIFICATIONS_END
```

- [ ] **Step 2: 语法校验（pglite 冒烟）**

用 Node 一次性把 schema.sql + 本迁移装入 pglite，确认无语法/依赖错误：

Run:
```bash
node -e "
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
(async () => {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(\"create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()); create function auth.uid() returns uuid language sql stable as \\\$\\\$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; \\\$\\\$; grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;\");
  await db.exec(readFileSync('supabase/schema.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260810_social_and_notifications.sql', 'utf8'));
  const { rows } = await db.query(\"select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('follow_user','bookmark_work','like_comment','toggle_like_work','create_comment','list_notifications','get_comment_like_state')\");
  console.log('OK functions:', rows[0].n);
  await db.close();
})();
"
```
Expected: 输出 `OK functions: 7`，无异常。

- [ ] **Step 3: 提交**

```bash
git add supabase/migrations/20260810_social_and_notifications.sql
git commit -m "feat: social layer — follows, bookmarks, comment likes, aggregated notifications (SQL)"
```

### Task 2: DB 测试骨架 + 表/授权/聚合 helper 语义

**Files:**
- Create: `tests/social-notifications-db.test.mjs`

本任务建测试文件骨架与第一批用例。`createDatabase` 直接加载**完整** `schema.sql`（不剥离 block）+ `20260810` 迁移；seed 含 A/B/C/D/E 五用户、两篇作品、一条顶层评论与一条回复。本批覆盖：表结构与授权收口、follow 聚合（+N/去重/归零删行/预览 cap 3）、禁止自我通知、agg_key 唯一。

- [ ] **Step 1: 写测试文件**

Run: 用 Write 创建 `tests/social-notifications-db.test.mjs`，内容如下（完整）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const socialMigrationUrl = new URL(
  "../supabase/migrations/20260810_social_and_notifications.sql",
  import.meta.url,
);

const USER_A = "10000000-0000-4000-8000-000000000001"; // 松声
const USER_B = "10000000-0000-4000-8000-000000000002"; // 白露
const USER_C = "10000000-0000-4000-8000-000000000003"; // 杏雨
const ADMIN_D = "10000000-0000-4000-8000-000000000004"; // 编辑部
const USER_E = "10000000-0000-4000-8000-000000000005"; // 星野
const WORK_1 = "20000000-0000-4000-8000-000000000001"; // 作者 A
const WORK_2 = "20000000-0000-4000-8000-000000000002"; // 作者 B
const COMMENT_1 = "30000000-0000-4000-8000-000000000001"; // B 在 WORK_1 的顶层评论
const COMMENT_2 = "30000000-0000-4000-8000-000000000002"; // C 对 COMMENT_1 的回复

async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create function auth.uid()
    returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  await db.exec(await readFile(schemaUrl, "utf8"));
  await db.exec(await readFile(socialMigrationUrl, "utf8"));
  return db;
}

async function seed(db) {
  for (const [id, email, penName] of [
    [USER_A, "a@x.test", "松声"],
    [USER_B, "b@x.test", "白露"],
    [USER_C, "c@x.test", "杏雨"],
    [ADMIN_D, "d@x.test", "编辑部"],
    [USER_E, "e@x.test", "星野"],
  ]) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, jsonb_build_object('pen_name', $3::text))`,
      [id, email, penName],
    );
  }
  await db.exec(`update public.profiles set role = 'admin' where id = '${ADMIN_D}'`);
  await db.exec(`
    insert into public.works (id, author_id, title, excerpt, content, category, status, created_at)
    values
      ('${WORK_1}', '${USER_A}', '末班车', '友谊校区', '第一段正文。\n\n第二段正文。', '散文', 'published', now() - '10 minutes'::interval),
      ('${WORK_2}', '${USER_B}', '白露集', '白露', '白露的正文。', '新诗', 'published', now() - '5 minutes'::interval)
  `);
  await db.exec(`
    insert into public.comments (id, work_id, user_id, parent_id, content, created_at)
    values
      ('${COMMENT_1}', '${WORK_1}', '${USER_B}', null, '评论一', now() - '3 minutes'::interval),
      ('${COMMENT_2}', '${WORK_1}', '${USER_C}', '${COMMENT_1}', '回复一', now() - '2 minutes'::interval)
  `);
}

async function asRole(db, role, userId, sql, params = []) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function expectError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("应当抛出异常但未抛出");
}

async function notificationsFor(db, userId) {
  const { rows } = await db.query(
    "select * from public.notifications where user_id = $1 order by last_event_at desc",
    [userId],
  );
  return rows;
}

test("四张新表结构与授权收口（revoke 直接表访问）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: tables } = await db.query(`
      select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public'
        and c.relname in ('follows', 'bookmarks', 'comment_likes', 'notifications')
      order by c.relname, a.attnum
    `);
    const byTable = {};
    for (const row of tables) {
      byTable[row.tbl] = byTable[row.tbl] ?? [];
      byTable[row.tbl].push(row.col);
    }
    for (const col of ["follower_id", "following_id", "created_at"]) {
      assert.ok(byTable.follows.includes(col), `follows.${col}`);
    }
    for (const col of ["user_id", "work_id", "created_at"]) {
      assert.ok(byTable.bookmarks.includes(col), `bookmarks.${col}`);
    }
    for (const col of ["user_id", "comment_id", "created_at"]) {
      assert.ok(byTable.comment_likes.includes(col), `comment_likes.${col}`);
    }
    for (const col of [
      "id", "user_id", "event_type", "target_work_id", "target_comment_id",
      "actor_ids", "actor_count", "last_event_at", "is_read", "agg_key",
    ]) {
      assert.ok(byTable.notifications.includes(col), `notifications.${col}`);
    }
    const insertError = await expectError(asRole(db, "authenticated", USER_A, `
      insert into public.follows (follower_id, following_id)
      values ('${USER_A}', '${USER_B}')
    `));
    assert.match(insertError.message, /permission denied/);
    const selectError = await expectError(asRole(db, "authenticated", USER_B, `
      select * from public.follows
    `));
    assert.match(selectError.message, /permission denied/);
  } finally {
    await db.close();
  }
});

test("follow 聚合：同目标 +N 折叠、最近者居前、去重幂等、预览 cap 3", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", ADMIN_D, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_E, "select public.follow_user($1)", [USER_A]);
    let rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1, "同目标同类型只聚合一条");
    assert.equal(rows[0].event_type, "follow");
    assert.equal(rows[0].actor_count, 4, "4 个不同 actor 计数正确");
    assert.deepEqual(rows[0].actor_ids, [USER_E, ADMIN_D, USER_B], "最近事件者居前，预览 cap 3");
    assert.equal(rows[0].agg_key, "follow:");
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_count, 4, "重复关注不重复计数");
  } finally {
    await db.close();
  }
});

test("follow 撤销：逐人收缩、归零删行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.unfollow_user($1)", [USER_A]);
    let rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_count, 1);
    assert.deepEqual(rows[0].actor_ids, [USER_C]);
    await asRole(db, "authenticated", USER_C, "select public.unfollow_user($1)", [USER_A]);
    rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 0, "count 归零后删除整行");
  } finally {
    await db.close();
  }
});

test("禁止自我通知：作者点赞/评论自己的作品不产生通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: likeRows } = await asRole(db, "authenticated", USER_A,
      "select public.toggle_like_work($1) as payload", [WORK_1]);
    assert.equal(likeRows[0].payload.liked, true);
    await asRole(db, "authenticated", USER_A,
      "select public.create_comment($1, $2, null)", [WORK_1, "自评"]);
    assert.equal((await notificationsFor(db, USER_A)).length, 0, "自我通知被短路");
    const selfFollow = await expectError(asRole(db, "authenticated", USER_A,
      "select public.follow_user($1)", [USER_A]));
    assert.match(selfFollow.message, /不能关注自己/);
  } finally {
    await db.close();
  }
});

test("不同目标独立聚合（agg_key 唯一）：同一 actor 点赞/收藏不同作品各自成条", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_B,
      "select public.toggle_like_work($1)", [WORK_1]);
    await asRole(db, "authenticated", USER_B, "select public.bookmark_work($1)", [WORK_1]);
    await asRole(db, "authenticated", USER_C,
      "select public.toggle_like_work($1)", [WORK_2]);
    const aRows = await notificationsFor(db, USER_A);
    assert.equal(aRows.length, 2, "work_like 与 work_bookmark 各自聚合");
    assert.deepEqual(aRows.map((r) => r.event_type).sort(), ["work_bookmark", "work_like"]);
    const bRows = await notificationsFor(db, USER_B);
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].event_type, "work_like");
    assert.equal(bRows[0].target_work_id, WORK_2);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test tests/social-notifications-db.test.mjs`
Expected: `5` 个测试全部 pass（`pass 5 / fail 0`）。

- [ ] **Step 3: 提交**

```bash
git add tests/social-notifications-db.test.mjs
git commit -m "test: social layer DB tests — tables/RLS auth, follow aggregation, self-notification short-circuit"
```

### Task 3: DB 测试 — 关注/收藏/评论点赞往返 + 幂等 + gate + 计数公开

**Files:**
- Modify: `tests/social-notifications-db.test.mjs`（文件末尾追加 4 个测试）

本任务在 Task 2 的测试文件末尾追加往返用例：owner 列表可见/公开计数（含 anon 视角）、取消归零、幂等不重复计数、`write_gate=enforce` 门禁。

- [ ] **Step 1: 追加测试用例**

Run: 在 `tests/social-notifications-db.test.mjs` 的最后一个 `});` 之后追加以下 4 个测试（完整）：

```js
test("关注往返：列表 owner 可见、计数公开、取关归零", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // A 关注 B
    const { rows: followRows } = await asRole(db, "authenticated", USER_A,
      "select public.follow_user($1) as payload", [USER_B]);
    assert.equal(followRows[0].payload.following_id, USER_B);
    // A 的关注列表（owner）
    const { rows: following } = await asRole(db, "authenticated", USER_A,
      "select public.list_my_following(null, 20) as payload");
    assert.equal(following[0].payload.following.length, 1);
    assert.equal(following[0].payload.following[0].pen_name, "白露");
    // B 的粉丝列表（owner 侧）
    const { rows: followers } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_followers(null, 20) as payload");
    assert.equal(followers[0].payload.followers.length, 1);
    assert.equal(followers[0].payload.followers[0].id, USER_A);
    // 公开计数：B 的 followers_count=1，A 视角 followed_by_current_user=true
    const { rows: counts } = await asRole(db, "authenticated", USER_A,
      "select public.get_profile_social_counts($1) as payload", [USER_B]);
    assert.equal(counts[0].payload.followers_count, 1);
    assert.equal(counts[0].payload.following_count, 0);
    assert.equal(counts[0].payload.followed_by_current_user, true);
    // anon 也能读公开计数（无登录态 → followed_by_current_user=false）
    const { rows: anonCounts } = await asRole(db, "anon", null,
      "select public.get_profile_social_counts($1) as payload", [USER_B]);
    assert.equal(anonCounts[0].payload.followers_count, 1);
    assert.equal(anonCounts[0].payload.followed_by_current_user, false);
    // 取关 → 计数归零、B 粉丝列表空
    await asRole(db, "authenticated", USER_A, "select public.unfollow_user($1)", [USER_B]);
    const { rows: after } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_followers(null, 20) as payload");
    assert.equal(after[0].payload.followers.length, 0);
  } finally {
    await db.close();
  }
});

test("收藏往返：计数公开 + 我的收藏态、列表私密、取消归零", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // B 收藏 WORK_1（作者 A）
    const { rows: bm } = await asRole(db, "authenticated", USER_B,
      "select public.bookmark_work($1) as payload", [WORK_1]);
    assert.equal(bm[0].payload.work_id, WORK_1);
    // 公开计数：bookmark_count=1，B 视角 bookmarked_by_current_user=true
    const { rows: counts } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(counts[0].payload.bookmark_count, 1);
    assert.equal(counts[0].payload.bookmarked_by_current_user, true);
    // anon 视角：计数可见、态为 false
    const { rows: anonCounts } = await asRole(db, "anon", null,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(anonCounts[0].payload.bookmark_count, 1);
    assert.equal(anonCounts[0].payload.bookmarked_by_current_user, false);
    // B 的收藏列表（owner）
    const { rows: list } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_bookmarks(null, 20) as payload");
    assert.equal(list[0].payload.bookmarks.length, 1);
    assert.equal(list[0].payload.bookmarks[0].title, "末班车");
    assert.equal(list[0].payload.bookmarks[0].author_pen_name, "松声");
    // 幂等：重复收藏不重复计数
    await asRole(db, "authenticated", USER_B, "select public.bookmark_work($1)", [WORK_1]);
    const { rows: after } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(after[0].payload.bookmark_count, 1);
    // 取消收藏 → 计数归零
    await asRole(db, "authenticated", USER_B, "select public.unbookmark_work($1)", [WORK_1]);
    const { rows: zero } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(zero[0].payload.bookmark_count, 0);
  } finally {
    await db.close();
  }
});

test("评论点赞往返：计数公开 + 我的点赞态、取消归零、禁止赞自己", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // A 点赞 B 的顶层评论 COMMENT_1
    const { rows: liked } = await asRole(db, "authenticated", USER_A,
      "select public.like_comment($1) as payload", [COMMENT_1]);
    assert.equal(liked[0].payload.comment_id, COMMENT_1);
    // 公开态：like_count=1，A 视角 liked_by_current_user=true
    const { rows: state } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(state[0].payload.comments[0].like_count, 1);
    assert.equal(state[0].payload.comments[0].liked_by_current_user, true);
    // anon 视角：计数可见、态为 false
    const { rows: anonState } = await asRole(db, "anon", null,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(anonState[0].payload.comments[0].like_count, 1);
    assert.equal(anonState[0].payload.comments[0].liked_by_current_user, false);
    // 幂等：重复点赞不重复计数
    await asRole(db, "authenticated", USER_A, "select public.like_comment($1)", [COMMENT_1]);
    const { rows: after } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(after[0].payload.comments[0].like_count, 1);
    // 取消点赞 → 归零，且 comment_id 仍在返回中（零赞评论不并入 NULL 组）
    await asRole(db, "authenticated", USER_A, "select public.unlike_comment($1)", [COMMENT_1]);
    const { rows: zero } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(zero[0].payload.comments[0].comment_id, COMMENT_1);
    assert.equal(zero[0].payload.comments[0].like_count, 0);
    assert.equal(zero[0].payload.comments[0].liked_by_current_user, false);
    // 禁止赞自己的评论：C 评论了 COMMENT_1 的回复（COMMENT_2 属 C），C 赞自己的 COMMENT_2 → 被拒
    const selfLikeError = await expectError(asRole(db, "authenticated", USER_C,
      "select public.like_comment($1)", [COMMENT_2]));
    assert.match(selfLikeError.message, /不能赞自己的评论/);
    assert.equal((await notificationsFor(db, USER_C)).length, 0, "赞自己评论不产生通知");
  } finally {
    await db.close();
  }
});

test("write_gate=enforce 时未验证邮箱的写交互被拒，绑定后放行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    // USER_B 未绑定找回邮箱 → 所有写交互被拒
    const followError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.follow_user($1)", [USER_A]));
    assert.match(followError.message, /找回邮箱/);
    const bookmarkError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.bookmark_work($1)", [WORK_1]));
    assert.match(bookmarkError.message, /找回邮箱/);
    // USER_B 绑定后放行
    await db.exec(`
      insert into public.account_recovery_emails (user_id, email_normalized, verified_at)
      values ('${USER_B}', 'b-recovery@x.test', now())
    `);
    const { rows } = await asRole(db, "authenticated", USER_B,
      "select public.follow_user($1) as payload", [USER_A]);
    assert.equal(rows[0].payload.following_id, USER_A);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test tests/social-notifications-db.test.mjs`
Expected: `9` 个测试全部 pass（`pass 9 / fail 0`）。

- [ ] **Step 3: 提交**

```bash
git add tests/social-notifications-db.test.mjs
git commit -m "test: social layer DB tests — follow/bookmark/comment-like round trips, idempotency, gate"
```

### Task 4: DB 测试 — 作品点赞/评论/批注通知 + 软删撤销 + 通知读 RPC

**Files:**
- Modify: `tests/social-notifications-db.test.mjs`（文件末尾追加 5 个测试）

本任务在 Task 2/3 基础上追加通知引擎用例：`toggle_like_work` 发/撤 work_like、顶层评论 work_comment 聚合 + 回复 comment_reply、批注产生 work_comment、软删撤销聚合与清理 comment_like 通知、`list_notifications`（笔名按 actor_ids 顺序解析）+ 未读数 + 标记已读/全部已读。

- [ ] **Step 1: 追加测试用例**

Run: 在 `tests/social-notifications-db.test.mjs` 的最后一个 `});` 之后追加以下 5 个测试（完整）：

```js
test("作品点赞 toggle 往返：发/撤 work_like 通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: on } = await asRole(db, "authenticated", USER_B,
      "select public.toggle_like_work($1) as payload", [WORK_1]);
    assert.equal(on[0].payload.liked, true);
    assert.equal(on[0].payload.like_count, 1);
    let aRows = await notificationsFor(db, USER_A);
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0].event_type, "work_like");
    assert.equal(aRows[0].target_work_id, WORK_1);
    assert.deepEqual(aRows[0].actor_ids, [USER_B]);
    // 取消赞 → work_like 通知删除（count 归零删行）
    const { rows: off } = await asRole(db, "authenticated", USER_B,
      "select public.toggle_like_work($1) as payload", [WORK_1]);
    assert.equal(off[0].payload.liked, false);
    assert.equal(off[0].payload.like_count, 0);
    aRows = await notificationsFor(db, USER_A);
    assert.equal(aRows.length, 0, "取消赞后 work_like 通知删除");
  } finally {
    await db.close();
  }
});

test("评论/回复产生通知：顶层 work_comment 聚合、回复 comment_reply", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // C 顶层评论 WORK_1 → A 收 work_comment
    await asRole(db, "authenticated", USER_C,
      "select public.create_comment($1, $2, null)", [WORK_1, "C 的顶层评论"]);
    // D 顶层评论 WORK_1 → work_comment 聚合 +N
    await asRole(db, "authenticated", ADMIN_D,
      "select public.create_comment($1, $2, null)", [WORK_1, "D 的顶层评论"]);
    const aRows = await notificationsFor(db, USER_A);
    const wc = aRows.find((r) => r.event_type === "work_comment");
    assert.ok(wc, "A 收到 work_comment");
    assert.equal(wc.actor_count, 2);
    assert.equal(wc.target_work_id, WORK_1);
    // D 回复 COMMENT_1（作者 B）→ B 收 comment_reply
    await asRole(db, "authenticated", ADMIN_D,
      "select public.create_comment($1, $2, $3)", [WORK_1, "回复评论一", COMMENT_1]);
    const bRows = await notificationsFor(db, USER_B);
    const cr = bRows.find((r) => r.event_type === "comment_reply");
    assert.ok(cr, "B 收到 comment_reply");
    assert.equal(cr.target_comment_id, COMMENT_1);
    assert.deepEqual(cr.actor_ids, [ADMIN_D]);
  } finally {
    await db.close();
  }
});

test("批注（quoted comment）产生 work_comment 通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // 为 WORK_1 建一个版本（full-schema 加载不回填版本）
    const { rows: ver } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version($1, null, '末班车', '友谊校区', '散文',
        E'第一段正文。\n\n第二段正文。', '初次发布') as payload
    `, [WORK_1]);
    const versionId = ver[0].payload.version_id;
    // C 批注 WORK_1 → A 收 work_comment
    await asRole(db, "authenticated", USER_C, `
      select public.create_quoted_comment($1, $2, '第一段正文。', 0, 6, '批注内容') as payload
    `, [WORK_1, versionId]);
    const aRows = await notificationsFor(db, USER_A);
    const wc = aRows.find((r) => r.event_type === "work_comment");
    assert.ok(wc, "A 收到 work_comment");
    assert.deepEqual(wc.actor_ids, [USER_C]);
  } finally {
    await db.close();
  }
});

test("soft_delete_comment 撤销 work_comment 聚合并清理该评论的 comment_like 通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // C 顶层评论 WORK_1 → A 收 work_comment
    const { rows: created } = await asRole(db, "authenticated", USER_C,
      "select public.create_comment($1, $2, null) as payload", [WORK_1, "待删评论"]);
    const newCommentId = created[0].payload.id;
    // B 点赞该评论 → C 收 comment_like
    await asRole(db, "authenticated", USER_B, "select public.like_comment($1)", [newCommentId]);
    assert.equal((await notificationsFor(db, USER_C)).length, 1);
    // C 软删自己的评论
    await asRole(db, "authenticated", USER_C, "select public.soft_delete_comment($1)", [newCommentId]);
    // A 的 work_comment 聚合撤销（唯一 actor → 删行）
    const aRows = await notificationsFor(db, USER_A);
    assert.equal(aRows.find((r) => r.event_type === "work_comment"), undefined, "work_comment 撤销");
    // C 的 comment_like 通知被清理
    assert.equal((await notificationsFor(db, USER_C)).length, 0, "comment_like 通知清理");
    // 评论本身已软删
    const { rows: cm } = await db.query(
      "select is_deleted from public.comments where id = $1", [newCommentId]);
    assert.equal(cm[0].is_deleted, true);
  } finally {
    await db.close();
  }
});

test("通知读 RPC：list 笔名解析 + 未读数 + 标记已读/全部已读", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // B 关注 A、C 关注 A → A follow 通知（聚合 2）
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_C, "select public.follow_user($1)", [USER_A]);
    // B 点赞 WORK_1 → A work_like
    await asRole(db, "authenticated", USER_B, "select public.toggle_like_work($1)", [WORK_1]);
    // 未读数 = 2
    const { rows: unread } = await asRole(db, "authenticated", USER_A,
      "select public.get_notification_unread_count() as payload");
    assert.equal(unread[0].payload.unread_count, 2);
    // list：两条，按 event_type 定位
    const { rows: list } = await asRole(db, "authenticated", USER_A,
      "select public.list_notifications(null, 20) as payload");
    const items = list[0].payload.notifications;
    assert.equal(items.length, 2);
    const follow = items.find((n) => n.event_type === "follow");
    const like = items.find((n) => n.event_type === "work_like");
    assert.ok(follow && like, "两种通知都在");
    assert.deepEqual(follow.actor_pen_names, ["杏雨", "白露"], "最近者居前");
    assert.equal(follow.actor_count, 2);
    assert.equal(like.actor_pen_names[0], "白露");
    assert.equal(like.work_title, "末班车");
    // 标记单条已读 → 未读 1
    await asRole(db, "authenticated", USER_A,
      "select public.mark_notification_read($1)", [follow.id]);
    const { rows: afterOne } = await asRole(db, "authenticated", USER_A,
      "select public.get_notification_unread_count() as payload");
    assert.equal(afterOne[0].payload.unread_count, 1);
    // 全部已读 → 0
    await asRole(db, "authenticated", USER_A, "select public.mark_all_notifications_read()");
    const { rows: allRead } = await asRole(db, "authenticated", USER_A,
      "select public.get_notification_unread_count() as payload");
    assert.equal(allRead[0].payload.unread_count, 0);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test tests/social-notifications-db.test.mjs`
Expected: `14` 个测试全部 pass（`pass 14 / fail 0`）。

- [ ] **Step 3: 提交**

```bash
git add tests/social-notifications-db.test.mjs
git commit -m "test: social layer DB tests — like/comment/quoted notifications, soft-delete undo, read RPCs"
```

### Task 5: DB 测试 — 迁移完整性结构断言

**Files:**
- Modify: `tests/social-notifications-db.test.mjs`（文件末尾追加 1 个结构性测试）

本任务追加迁移完整性断言：22 个函数齐全、公开计数 RPC 对 anon 可执行、私密列表 RPC 仅 authenticated、写 RPC 仅 authenticated、helper 无执行权、4 张新表 RLS 开启且 authenticated 无表级权限。该测试把「迁移不完整」类回归变成测试失败。

- [ ] **Step 1: 追加完整性测试**

Run: 在 `tests/social-notifications-db.test.mjs` 的最后一个 `});` 之后追加以下测试（完整）：

```js
test("迁移完整性：22 函数齐全 + 授权面 + RLS + 直接表访问已 revoke", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: funcs } = await db.query(`
      select proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and proname in (
          'upsert_notification','remove_notification_actor','follow_user','unfollow_user',
          'bookmark_work','unbookmark_work','like_comment','unlike_comment',
          'toggle_like_work','create_comment','create_quoted_comment','soft_delete_comment',
          'list_notifications','get_notification_unread_count','mark_notification_read',
          'mark_all_notifications_read','list_my_following','list_my_followers',
          'list_my_bookmarks','get_work_social_counts','get_profile_social_counts',
          'get_comment_like_state'
        )
    `);
    assert.equal(funcs.length, 22, "22 个函数齐全");
    // 公开计数 RPC：anon 可执行
    assert.equal(
      (await db.query("select has_function_privilege('anon', 'public.get_work_social_counts(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('anon', 'public.get_profile_social_counts(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('anon', 'public.get_comment_like_state(uuid[])', 'EXECUTE') as ok")).rows[0].ok, true);
    // 私密列表 RPC：anon 不可执行、authenticated 可执行
    for (const fn of ["list_notifications", "list_my_following", "list_my_followers", "list_my_bookmarks"]) {
      assert.equal(
        (await db.query(`select has_function_privilege('anon', 'public.${fn}(text, integer)', 'EXECUTE') as ok`)).rows[0].ok,
        false, `${fn} anon 不可执行`);
      assert.equal(
        (await db.query(`select has_function_privilege('authenticated', 'public.${fn}(text, integer)', 'EXECUTE') as ok`)).rows[0].ok,
        true, `${fn} authenticated 可执行`);
    }
    // 写 RPC：authenticated 可执行
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.follow_user(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.bookmark_work(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.like_comment(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.toggle_like_work(uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.create_comment(uuid, text, uuid)', 'EXECUTE') as ok")).rows[0].ok, true);
    // helper：无人可执行
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.upsert_notification(uuid, text, uuid, uuid, uuid)', 'EXECUTE') as ok")).rows[0].ok, false);
    assert.equal(
      (await db.query("select has_function_privilege('authenticated', 'public.remove_notification_actor(uuid, text, uuid, uuid, uuid)', 'EXECUTE') as ok")).rows[0].ok, false);
    // 4 张新表 RLS 开启 + authenticated 无表级权限
    for (const tbl of ["follows", "bookmarks", "comment_likes", "notifications"]) {
      const { rows } = await db.query(
        `select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`, [tbl]);
      assert.equal(rows[0].relrowsecurity, true, `${tbl} RLS 开启`);
      assert.equal(
        (await db.query(`select has_table_privilege('authenticated', 'public.${tbl}', 'SELECT') as ok`)).rows[0].ok,
        false, `${tbl} authenticated SELECT 被 revoke`);
      assert.equal(
        (await db.query(`select has_table_privilege('authenticated', 'public.${tbl}', 'INSERT') as ok`)).rows[0].ok,
        false, `${tbl} authenticated INSERT 被 revoke`);
    }
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test tests/social-notifications-db.test.mjs`
Expected: `15` 个测试全部 pass（`pass 15 / fail 0`）。

- [ ] **Step 3: 提交**

```bash
git add tests/social-notifications-db.test.mjs
git commit -m "test: social layer DB tests — migration completeness (functions, grants, RLS, revokes)"
```

### Task 6: 演示模式数据服务 — 私密社交 + 通知方法

**Files:**
- Create: `tests/social-notifications-service.test.mjs`
- Modify: `js/demo-data.mjs`（在 `comments` 数组后追加 `follows`/`bookmarks`/`commentLikes`/`notifications` 种子数据）
- Modify: `js/data-service.mjs`（`createDemoService` 内：状态默认值、通知聚合 helper、改造 toggleLike/addComment/createQuotedComment/deleteComment、追加 16 个社交方法）

演示服务是单会话内存态：多用户交互通过同一实例内 `signIn` 切换会话模拟（签名会覆盖会话）。测试用 `freshSeed()` 清空种子社交状态后从零构建；需要验证「预置计数公开」的用例直接使用默认种子。

- [ ] **Step 1: 写失败测试**

创建 `tests/social-notifications-service.test.mjs`（完整内容）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
import { demoSeed } from "../js/demo-data.mjs";

const SIGN = {
  pine: { studentNumber: "2023123456", password: "wenyuan88" }, // 松声
  editor: { studentNumber: "2023000001", password: "editor88" }, // 编辑部
  dew: { studentNumber: "2022111111", password: "reader88" }, // 白露
};

// 清空演示社交状态，让测试从零构建（不依赖 demo-data 的种子社交数据）。
// 演示服务是单会话内存态，多用户交互通过切换登录（signIn 覆盖会话）模拟。
function freshSeed() {
  const seed = structuredClone(demoSeed);
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  return seed;
}

function demoService() {
  return createDataService({ mode: "demo", seed: freshSeed() });
}

const ofType = (serviceItems, eventType) =>
  serviceItems.notifications.filter((n) => n.event_type === eventType);

test("演示模式：关注往返产生聚合通知，取关撤销通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  const followed = await service.followUser("profile-dew");
  assert.deepEqual(followed, {
    follower_id: "profile-pine",
    following_id: "profile-dew",
  });
  // 幂等：重复关注返回相同结果，不重复计数
  const again = await service.followUser("profile-dew");
  assert.equal(again.following_id, "profile-dew");

  // 松声关注列表
  assert.equal((await service.listMyFollowing()).following.length, 1);
  assert.equal(
    (await service.listMyFollowing()).following[0].pen_name,
    "白露",
  );

  // 切到白露：收到一条 follow 聚合通知 + 粉丝列表可见
  await service.signIn(SIGN.dew);
  const dewNotifs = ofType(await service.listNotifications(), "follow");
  assert.equal(dewNotifs.length, 1);
  assert.equal(dewNotifs[0].actor_count, 1);
  assert.deepEqual(dewNotifs[0].actor_pen_names, ["松声"]);
  assert.equal((await service.listMyFollowers()).followers.length, 1);
  assert.equal(
    (await service.listMyFollowers()).followers[0].id,
    "profile-pine",
  );

  // 切回松声取关 → 白露的 follow 通知消失
  await service.signIn(SIGN.pine);
  await service.unfollowUser("profile-dew");
  assert.equal((await service.listMyFollowing()).following.length, 0);
  await service.signIn(SIGN.dew);
  assert.equal(ofType(await service.listNotifications(), "follow").length, 0);
});

test("演示模式：禁止自我关注", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(() => service.followUser("profile-pine"), /不能关注自己/);
  await assert.rejects(() => service.followUser("no-such-user"), /关注对象不存在/);
});

test("演示模式：收藏往返产生 work_bookmark 通知，取消撤销", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声收藏白露的《河流向北》
  const bookmarked = await service.bookmarkWork("work-river");
  assert.deepEqual(bookmarked, {
    user_id: "profile-pine",
    work_id: "work-river",
  });
  const counts = await service.getWorkSocialCounts("work-river");
  assert.equal(counts.bookmark_count, 1);
  assert.equal(counts.bookmarked_by_current_user, true);
  const list = await service.listMyBookmarks();
  assert.equal(list.bookmarks.length, 1);
  assert.equal(list.bookmarks[0].title, "河流向北");
  assert.equal(list.bookmarks[0].author_pen_name, "白露");

  // 切到白露：收到 work_bookmark 通知
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_bookmark").length,
    1,
  );

  // 切回松声取消收藏 → 通知撤销
  await service.signIn(SIGN.pine);
  await service.unbookmarkWork("work-river");
  assert.equal((await service.listMyBookmarks()).bookmarks.length, 0);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_bookmark").length,
    0,
  );
});

test("演示模式：评论点赞往返产生 comment_like 通知，禁止赞自己", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声赞白露的评论 comment-1
  const liked = await service.likeComment("comment-1");
  assert.deepEqual(liked, {
    user_id: "profile-pine",
    comment_id: "comment-1",
  });
  const state = await service.getCommentLikeState(["comment-1", "comment-3"]);
  const byId = new Map(state.comments.map((c) => [c.comment_id, c]));
  assert.equal(byId.get("comment-1").like_count, 1);
  assert.equal(byId.get("comment-1").liked_by_current_user, true);
  assert.equal(byId.get("comment-3").like_count, 0);
  assert.equal(byId.get("comment-3").liked_by_current_user, false);

  // 切到白露：收到 comment_like 通知
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    1,
  );

  // 切回松声取消点赞 → 归零、通知撤销
  await service.signIn(SIGN.pine);
  await service.unlikeComment("comment-1");
  assert.equal(
    (await service.getCommentLikeState(["comment-1"])).comments[0].like_count,
    0,
  );
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    0,
  );

  // 禁止赞自己：白露赞自己的 comment-1 → 被拒
  await assert.rejects(() => service.likeComment("comment-1"), /不能赞自己的评论/);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    0,
  );
});

test("演示模式：作品点赞 toggle 发/撤 work_like 通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声点赞白露的《小事记》（松声此前未点赞，作者是白露）
  const on = await service.toggleLike("work-small-things");
  assert.equal(on.liked, true);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    0, // 松声是点赞者而非作者，自己不该收到
  );
  // 切到白露确认收到 work_like，切回松声取消
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    1,
  );
  await service.signIn(SIGN.pine);
  const off = await service.toggleLike("work-small-things");
  assert.equal(off.liked, false);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    0,
  );
});

test("演示模式：评论/回复产生通知，删除评论撤销 work_comment", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声在《河流向北》下发顶层评论 → 白露收 work_comment
  const comment = await service.addComment(
    "work-river",
    "读完了，想去河边走走。",
  );
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_comment").length,
    1,
  );
  // 白露回复松声 → 松声收 comment_reply
  await service.addComment("work-river", "欢迎来。", comment.id);
  await service.signIn(SIGN.pine);
  assert.equal(
    ofType(await service.listNotifications(), "comment_reply").length,
    1,
  );
  // 松声删除顶层评论 → 白露的 work_comment 撤销（回复通知不受影响）
  await service.deleteComment(comment.id);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_comment").length,
    0,
  );
  await service.signIn(SIGN.pine);
  assert.equal(
    ofType(await service.listNotifications(), "comment_reply").length,
    1,
  );
});

test("演示模式：同类事件折叠 +N，actor 头为最近者且按序解析笔名", async () => {
  const service = demoService();
  // 白露、编辑部都收藏《末班车经过友谊校区》（作者松声）
  await service.signIn(SIGN.dew);
  await service.bookmarkWork("work-night-bus");
  await service.signIn(SIGN.editor);
  await service.bookmarkWork("work-night-bus");
  // 切到松声：只收到一条折叠后的 work_bookmark 通知
  await service.signIn(SIGN.pine);
  const items = ofType(await service.listNotifications(), "work_bookmark");
  assert.equal(items.length, 1);
  assert.equal(items[0].actor_count, 2);
  assert.deepEqual(items[0].actor_pen_names, ["编辑部", "白露"]);
  assert.equal(items[0].target_work_id, "work-night-bus");
  assert.equal(items[0].work_title, "末班车经过友谊校区");
});

test("演示模式：cap-3 聚合 —— 4 个 actor 折叠为 3，头部为最近者", async () => {
  // 默认种子只有 3 个可登录账号，达不到 cap-3；注入杏雨、原上两个账号做 4 人聚合。
  const seed = structuredClone(demoSeed);
  seed.accounts.push(
    { studentNumber: "2024000001", password: "apricot88", profileId: "profile-apricot" },
    { studentNumber: "2024000002", password: "wild88", profileId: "profile-wild" },
  );
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  const service = createDataService({ mode: "demo", seed });
  const SIGN_APRICOT = { studentNumber: "2024000001", password: "apricot88" };
  const SIGN_WILD = { studentNumber: "2024000002", password: "wild88" };
  // 4 个不同用户依次关注白露：editor → wild → apricot → pine（越晚者越“近”）
  await service.signIn(SIGN.editor);
  await service.followUser("profile-dew");
  await service.signIn(SIGN_WILD);
  await service.followUser("profile-dew");
  await service.signIn(SIGN_APRICOT);
  await service.followUser("profile-dew");
  await service.signIn(SIGN.pine);
  await service.followUser("profile-dew");
  // 白露视角：一条 follow 通知，actor 折叠为 3，头为最近者（松声），计数为 4
  await service.signIn(SIGN.dew);
  const items = ofType(await service.listNotifications(), "follow");
  assert.equal(items.length, 1);
  assert.equal(items[0].actor_count, 4);
  assert.equal(items[0].actor_pen_names.length, 3);
  assert.deepEqual(items[0].actor_pen_names, ["松声", "杏雨", "原上"]);
});

test("演示模式：markNotificationRead 只能标记本人通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  // 松声收藏《河流向北》、点赞《小事记》→ 白露收 2 条未读
  await service.bookmarkWork("work-river");
  await service.toggleLike("work-small-things");
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
  const dewNotifs = (await service.listNotifications()).notifications;
  // 松声尝试标记白露的通知 → 白露未读数不变（与 SQL mark_notification_read 的 user_id 过滤一致）
  await service.signIn(SIGN.pine);
  await service.markNotificationRead(dewNotifs[0].id);
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
});

test("演示模式：通知未读数与标记已读", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  // 松声收藏《河流向北》、点赞《小事记》→ 白露收 2 条通知
  await service.bookmarkWork("work-river");
  await service.toggleLike("work-small-things");
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
  const list = (await service.listNotifications()).notifications;
  assert.equal(list.length, 2);
  await service.markNotificationRead(list[0].id);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 1);
  await service.markAllNotificationsRead();
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 0);
});

test("演示模式：getProfileSocialCounts 计数公开 + 我的关注态", async () => {
  // 用默认演示种子（含预置关注关系：松声、杏雨关注白露），匿名视角计数公开
  const anon = createDataService({ mode: "demo" });
  const anonCounts = await anon.getProfileSocialCounts("profile-dew");
  assert.equal(anonCounts.followers_count, 2);
  assert.equal(anonCounts.followed_by_current_user, false);

  const service = createDataService({ mode: "demo" });
  await service.signIn(SIGN.pine);
  // 松声视角：种子中松声已关注白露 → followed_by_current_user 为 true
  const counts = await service.getProfileSocialCounts("profile-dew");
  assert.equal(counts.followers_count, 2);
  assert.equal(counts.following_count, 1);
  assert.equal(counts.followed_by_current_user, true);
  // 动作：松声再关注杏雨 → 杏雨粉丝数 +1
  await service.followUser("profile-apricot");
  assert.equal(
    (await service.getProfileSocialCounts("profile-apricot")).followers_count,
    1,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/social-notifications-service.test.mjs`
Expected: FAIL —— `service.followUser is not a function`（或 `service.listNotifications is not a function`），社交方法尚不存在。

- [ ] **Step 3: demo-data.mjs 追加社交种子数据**

在 `js/demo-data.mjs` 的 `comments` 数组结束（`];` 之后）、`accountSecurityByUserId: {` 之前插入：

```js
  follows: [
    { follower_id: "profile-dew", following_id: "profile-pine", created_at: "2026-07-25T09:00:00+08:00" },
    { follower_id: "profile-pine", following_id: "profile-dew", created_at: "2026-07-26T10:00:00+08:00" },
    { follower_id: "profile-apricot", following_id: "profile-dew", created_at: "2026-07-27T11:00:00+08:00" },
    { follower_id: "profile-editor", following_id: "profile-pine", created_at: "2026-07-28T12:00:00+08:00" },
  ],
  bookmarks: [
    { user_id: "profile-dew", work_id: "work-night-bus", created_at: "2026-07-25T13:00:00+08:00" },
    { user_id: "profile-pine", work_id: "work-river", created_at: "2026-07-26T14:00:00+08:00" },
    { user_id: "profile-apricot", work_id: "work-river", created_at: "2026-07-27T15:00:00+08:00" },
  ],
  commentLikes: [
    { user_id: "profile-pine", comment_id: "comment-1", created_at: "2026-07-25T16:00:00+08:00" },
    { user_id: "profile-dew", comment_id: "comment-2", created_at: "2026-07-26T17:00:00+08:00" },
    { user_id: "profile-editor", comment_id: "comment-3", created_at: "2026-07-27T18:00:00+08:00" },
  ],
  notifications: [
    {
      id: "notif-1",
      user_id: "profile-pine",
      event_type: "work_comment",
      target_work_id: "work-night-bus",
      target_comment_id: null,
      actor_ids: ["profile-dew"],
      actor_count: 1,
      last_event_at: "2026-07-29T23:00:00+08:00",
      is_read: false,
      agg_key: "work_comment:work-night-bus",
    },
    {
      id: "notif-2",
      user_id: "profile-pine",
      event_type: "work_like",
      target_work_id: "work-night-bus",
      target_comment_id: null,
      actor_ids: ["profile-editor", "profile-dew"],
      actor_count: 2,
      last_event_at: "2026-07-29T22:30:00+08:00",
      is_read: false,
      agg_key: "work_like:work-night-bus",
    },
    {
      id: "notif-3",
      user_id: "profile-pine",
      event_type: "follow",
      target_work_id: null,
      target_comment_id: null,
      actor_ids: ["profile-dew"],
      actor_count: 1,
      last_event_at: "2026-07-28T20:00:00+08:00",
      is_read: true,
      agg_key: "follow:",
    },
    {
      id: "notif-4",
      user_id: "profile-dew",
      event_type: "work_comment",
      target_work_id: "work-river",
      target_comment_id: null,
      actor_ids: ["profile-apricot"],
      actor_count: 1,
      last_event_at: "2026-07-28T20:18:00+08:00",
      is_read: false,
      agg_key: "work_comment:work-river",
    },
    {
      id: "notif-5",
      user_id: "profile-dew",
      event_type: "work_like",
      target_work_id: "work-river",
      target_comment_id: null,
      actor_ids: ["profile-apricot", "profile-editor", "profile-pine"],
      actor_count: 3,
      last_event_at: "2026-07-28T19:00:00+08:00",
      is_read: false,
      agg_key: "work_like:work-river",
    },
  ],
```

- [ ] **Step 4: data-service.mjs 加状态默认值 + 通知聚合 helper**

在 `createDemoService` 内（`state.commentQuotes = state.commentQuotes ?? [];` 之后）追加状态默认值：

```js
  state.follows = state.follows ?? [];
  state.bookmarks = state.bookmarks ?? [];
  state.commentLikes = state.commentLikes ?? [];
  state.notifications = state.notifications ?? [];
```

在 `displayStringDemo` 定义之后、`state.works.forEach(ensureVersion1);` 之前插入 helper（与 SQL `upsert_notification`/`remove_notification_actor` 口径一致：agg_key = event_type + 目标复合串，follow 无目标以尾部 `:` 占位；actor_ids 头为最近事件者、cap 3）：

```js
  // 通知聚合（与 SQL upsert_notification 口径一致）：
  // agg_key = event_type + 目标复合串；follow 无目标时以尾部 ':' 占位。
  // actor_ids 数组头部为最近事件者，cap 3（预览「A、B、C 等 N 人」）。
  const notificationAggKey = (eventType, targetWorkId, targetCommentId) =>
    `${eventType}${targetWorkId ? `:${targetWorkId}` : ""}${
      targetCommentId ? `:${targetCommentId}` : ""
    }${!targetWorkId && !targetCommentId ? ":" : ""}`;

  const upsertNotification = (
    recipient,
    eventType,
    targetWorkId,
    targetCommentId,
    actor,
  ) => {
    if (!recipient || !actor || recipient === actor) return;
    const aggKey = notificationAggKey(
      eventType,
      targetWorkId,
      targetCommentId,
    );
    const row = state.notifications.find(
      (item) => item.user_id === recipient && item.agg_key === aggKey,
    );
    const nowIso = now().toISOString();
    if (!row) {
      state.notifications.push({
        id: makeId("notif"),
        user_id: recipient,
        event_type: eventType,
        target_work_id: targetWorkId ?? null,
        target_comment_id: targetCommentId ?? null,
        actor_ids: [actor],
        actor_count: 1,
        last_event_at: nowIso,
        is_read: false,
        agg_key: aggKey,
      });
      return;
    }
    if (row.actor_ids.includes(actor)) {
      row.last_event_at = nowIso;
      return;
    }
    row.actor_ids = [actor, ...row.actor_ids.slice(0, 2)];
    row.actor_count += 1;
    row.last_event_at = nowIso;
  };

  const removeNotificationActor = (
    recipient,
    eventType,
    targetWorkId,
    targetCommentId,
    actor,
  ) => {
    if (!recipient || !actor || recipient === actor) return;
    const aggKey = notificationAggKey(
      eventType,
      targetWorkId,
      targetCommentId,
    );
    const index = state.notifications.findIndex(
      (item) => item.user_id === recipient && item.agg_key === aggKey,
    );
    if (index < 0) return;
    const row = state.notifications[index];
    if (!row.actor_ids.includes(actor)) return;
    if (row.actor_count <= 1) {
      state.notifications.splice(index, 1);
      return;
    }
    row.actor_ids = row.actor_ids.filter((item) => item !== actor);
    row.actor_count -= 1;
  };
```

- [ ] **Step 5: 改造 toggleLike / addComment / createQuotedComment / deleteComment 收发通知**

**toggleLike**：把整个 `async toggleLike(workId) { ... }` 方法替换为（点赞发 `work_like`、取消撤 `work_like`）：

```js
    async toggleLike(workId) {
      const current = requireVerifiedSession();
      if (!state.works.some((work) => work.id === workId)) {
        throw new Error("作品不存在");
      }
      const work = state.works.find((item) => item.id === workId);
      const index = state.likes.findIndex(
        (like) =>
          like.work_id === workId && like.user_id === current.profile.id,
      );
      let liked;
      if (index >= 0) {
        state.likes.splice(index, 1);
        liked = false;
        removeNotificationActor(
          work.author_id,
          "work_like",
          workId,
          null,
          current.profile.id,
        );
      } else {
        state.likes.push({
          work_id: workId,
          user_id: current.profile.id,
        });
        liked = true;
        upsertNotification(
          work.author_id,
          "work_like",
          workId,
          null,
          current.profile.id,
        );
      }
      return {
        liked,
        likeCount: state.likes.filter((like) => like.work_id === workId)
          .length,
      };
    },
```

**addComment**：在 `state.comments.push(comment);` 之后、`return enrichComment(comment);` 之前插入（顶层发 `work_comment` 给作品作者、回复发 `comment_reply` 给被回复者）：

```js
      const work = state.works.find((item) => item.id === workId);
      if (parentId) {
        const parent = state.comments.find((item) => item.id === parentId);
        upsertNotification(
          parent.user_id,
          "comment_reply",
          null,
          parentId,
          current.profile.id,
        );
      } else {
        upsertNotification(
          work.author_id,
          "work_comment",
          workId,
          null,
          current.profile.id,
        );
      }
```

**deleteComment**：在 `comment.updated_at = new Date().toISOString();` 之后、`return enrichComment(comment);` 之前插入（顶层撤销 `work_comment`、回复撤销 `comment_reply`、清除该评论的 `comment_like` 通知）：

```js
      // 通知维护：顶层评论撤销 work_comment；回复撤销 comment_reply；清除该评论的 comment_like 通知
      const work = state.works.find((item) => item.id === comment.work_id);
      if (comment.parent_id) {
        const parent = state.comments.find((item) => item.id === comment.parent_id);
        removeNotificationActor(
          parent?.user_id ?? null,
          "comment_reply",
          null,
          comment.parent_id,
          comment.user_id,
        );
      } else {
        removeNotificationActor(
          work?.author_id ?? null,
          "work_comment",
          comment.work_id,
          null,
          comment.user_id,
        );
      }
      state.notifications = state.notifications.filter(
        (item) =>
          !(
            item.event_type === "comment_like" &&
            item.target_comment_id === comment.id
          ),
      );
```

**createQuotedComment**：在 `state.commentQuotes.push(quote);` 之后、`return { comment: enrichComment(comment), quote };` 之前插入：

```js
      upsertNotification(
        work.author_id,
        "work_comment",
        work.id,
        null,
        current.profile.id,
      );
```

- [ ] **Step 6: 追加 16 个社交方法**

在 `async setFeatured(workId, featured) { ... },` 方法之后、`async getAccountSecurityStatus() {` 之前插入完整方法块：

```js
    // ---- 私密社交（发布四）----

    async followUser(targetUserId) {
      const current = requireVerifiedSession();
      if (targetUserId === current.profile.id) throw new Error("不能关注自己");
      if (!getProfileRecord(targetUserId)) throw new Error("关注对象不存在");
      const existing = state.follows.find(
        (item) =>
          item.follower_id === current.profile.id &&
          item.following_id === targetUserId,
      );
      if (!existing) {
        state.follows.push({
          follower_id: current.profile.id,
          following_id: targetUserId,
          created_at: now().toISOString(),
        });
      }
      upsertNotification(targetUserId, "follow", null, null, current.profile.id);
      const row = existing ?? {
        follower_id: current.profile.id,
        following_id: targetUserId,
      };
      return { follower_id: row.follower_id, following_id: row.following_id };
    },

    async unfollowUser(targetUserId) {
      const current = requireVerifiedSession();
      state.follows = state.follows.filter(
        (item) =>
          !(
            item.follower_id === current.profile.id &&
            item.following_id === targetUserId
          ),
      );
      removeNotificationActor(
        targetUserId,
        "follow",
        null,
        null,
        current.profile.id,
      );
    },

    async bookmarkWork(workId) {
      const current = requireVerifiedSession();
      const work = state.works.find((item) => item.id === workId);
      if (!work) throw new Error("作品不存在");
      if (
        work.status !== "published" &&
        work.author_id !== current.profile.id &&
        !isAdmin()
      ) {
        throw new Error("作品不存在");
      }
      const existing = state.bookmarks.some(
        (item) =>
          item.user_id === current.profile.id && item.work_id === workId,
      );
      if (!existing) {
        state.bookmarks.push({
          user_id: current.profile.id,
          work_id: workId,
          created_at: now().toISOString(),
        });
      }
      upsertNotification(
        work.author_id,
        "work_bookmark",
        workId,
        null,
        current.profile.id,
      );
      return { user_id: current.profile.id, work_id: workId };
    },

    async unbookmarkWork(workId) {
      const current = requireVerifiedSession();
      state.bookmarks = state.bookmarks.filter(
        (item) =>
          !(item.user_id === current.profile.id && item.work_id === workId),
      );
      const work = state.works.find((item) => item.id === workId);
      if (work) {
        removeNotificationActor(
          work.author_id,
          "work_bookmark",
          workId,
          null,
          current.profile.id,
        );
      }
    },

    async likeComment(commentId) {
      const current = requireVerifiedSession();
      const comment = state.comments.find((item) => item.id === commentId);
      if (!comment) throw new Error("评论不存在");
      if (comment.user_id === current.profile.id) throw new Error("不能赞自己的评论");
      const existing = state.commentLikes.some(
        (item) =>
          item.user_id === current.profile.id && item.comment_id === commentId,
      );
      if (!existing) {
        state.commentLikes.push({
          user_id: current.profile.id,
          comment_id: commentId,
          created_at: now().toISOString(),
        });
      }
      upsertNotification(
        comment.user_id,
        "comment_like",
        null,
        commentId,
        current.profile.id,
      );
      return { user_id: current.profile.id, comment_id: commentId };
    },

    async unlikeComment(commentId) {
      const current = requireVerifiedSession();
      state.commentLikes = state.commentLikes.filter(
        (item) =>
          !(item.user_id === current.profile.id && item.comment_id === commentId),
      );
      const comment = state.comments.find((item) => item.id === commentId);
      if (comment) {
        removeNotificationActor(
          comment.user_id,
          "comment_like",
          null,
          commentId,
          current.profile.id,
        );
      }
    },

    async listNotifications(cursor, pageSize = 20) {
      const current = requireSession();
      const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 20);
      const rows = state.notifications
        .filter((item) => item.user_id === current.profile.id)
        .map((item) => {
          const work = state.works.find(
            (w) => w.id === item.target_work_id,
          );
          const comment = state.comments.find(
            (c) => c.id === item.target_comment_id,
          );
          return {
            id: item.id,
            event_type: item.event_type,
            target_work_id: item.target_work_id,
            target_comment_id: item.target_comment_id,
            actor_pen_names: item.actor_ids.map(
              (actorId) => getProfileRecord(actorId)?.pen_name ?? "佚名",
            ),
            actor_count: item.actor_count,
            last_event_at: item.last_event_at,
            is_read: item.is_read,
            work_title: work?.title ?? null,
            comment_work_id: comment?.work_id ?? null,
          };
        })
        .sort(
          (left, right) =>
            new Date(right.last_event_at) - new Date(left.last_event_at) ||
            String(left.id).localeCompare(String(right.id)),
        );
      const start = decodeCursor(cursor);
      const page = rows.slice(start, start + limit);
      return {
        notifications: page,
        nextCursor:
          start + page.length < rows.length
            ? encodeCursor(start + page.length)
            : null,
      };
    },

    async getNotificationUnreadCount() {
      const current = requireSession();
      return {
        unread_count: state.notifications.filter(
          (item) =>
            item.user_id === current.profile.id && item.is_read === false,
        ).length,
      };
    },

    async markNotificationRead(notificationId) {
      // 与 SQL mark_notification_read 一致：只允许本人标记自己的通知
      const current = requireSession();
      const row = state.notifications.find(
        (item) =>
          item.id === notificationId && item.user_id === current.profile.id,
      );
      if (row) row.is_read = true;
    },

    async markAllNotificationsRead() {
      const current = requireSession();
      state.notifications
        .filter((item) => item.user_id === current.profile.id)
        .forEach((item) => {
          item.is_read = true;
        });
    },

    async listMyFollowing(cursor, pageSize = 20) {
      const current = requireSession();
      const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 20);
      const rows = state.follows
        .filter((item) => item.follower_id === current.profile.id)
        .map((item) => {
          const profile = getProfileRecord(item.following_id);
          return {
            id: item.following_id,
            pen_name: profile?.pen_name ?? "佚名",
            bio: profile?.bio ?? "",
            created_at: item.created_at,
          };
        })
        .sort(
          (left, right) =>
            new Date(right.created_at) - new Date(left.created_at) ||
            String(right.id).localeCompare(String(left.id)),
        );
      const start = decodeCursor(cursor);
      const page = rows.slice(start, start + limit);
      return {
        following: page,
        nextCursor:
          start + page.length < rows.length
            ? encodeCursor(start + page.length)
            : null,
      };
    },

    async listMyFollowers(cursor, pageSize = 20) {
      const current = requireSession();
      const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 20);
      const rows = state.follows
        .filter((item) => item.following_id === current.profile.id)
        .map((item) => {
          const profile = getProfileRecord(item.follower_id);
          return {
            id: item.follower_id,
            pen_name: profile?.pen_name ?? "佚名",
            bio: profile?.bio ?? "",
            created_at: item.created_at,
          };
        })
        .sort(
          (left, right) =>
            new Date(right.created_at) - new Date(left.created_at) ||
            String(right.id).localeCompare(String(left.id)),
        );
      const start = decodeCursor(cursor);
      const page = rows.slice(start, start + limit);
      return {
        followers: page,
        nextCursor:
          start + page.length < rows.length
            ? encodeCursor(start + page.length)
            : null,
      };
    },

    async listMyBookmarks(cursor, pageSize = 20) {
      const current = requireSession();
      const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 20);
      // 与 SQL list_my_bookmarks 一致：只列已发布作品，未发布/已删除的收藏不展示
      const rows = state.bookmarks
        .filter((item) => item.user_id === current.profile.id)
        .map((item) => {
          const work = state.works.find((w) => w.id === item.work_id);
          if (work?.status !== "published") return null;
          const author = getProfileRecord(work.author_id);
          return {
            id: item.work_id,
            title: work.title,
            excerpt: work.excerpt,
            category: work.category,
            author_pen_name: author?.pen_name ?? "佚名",
            created_at: item.created_at,
          };
        })
        .filter(Boolean)
        .sort(
          (left, right) =>
            new Date(right.created_at) - new Date(left.created_at) ||
            String(right.id).localeCompare(String(left.id)),
        );
      const start = decodeCursor(cursor);
      const page = rows.slice(start, start + limit);
      return {
        bookmarks: page,
        nextCursor:
          start + page.length < rows.length
            ? encodeCursor(start + page.length)
            : null,
      };
    },

    async getWorkSocialCounts(workId) {
      const work = state.works.find((item) => item.id === workId);
      if (!work) throw new Error("作品不存在");
      if (
        work.status !== "published" &&
        work.author_id !== session?.profile?.id &&
        !isAdmin()
      ) {
        throw new Error("作品不存在");
      }
      return {
        bookmark_count: state.bookmarks.filter(
          (item) => item.work_id === workId,
        ).length,
        bookmarked_by_current_user: Boolean(
          session &&
            state.bookmarks.some(
              (item) =>
                item.user_id === session.profile.id && item.work_id === workId,
            ),
        ),
      };
    },

    async getProfileSocialCounts(profileId) {
      const profile = getProfileRecord(profileId);
      if (!profile) throw new Error("作者不存在");
      return {
        following_count: state.follows.filter(
          (item) => item.follower_id === profileId,
        ).length,
        followers_count: state.follows.filter(
          (item) => item.following_id === profileId,
        ).length,
        followed_by_current_user: Boolean(
          session &&
            state.follows.some(
              (item) =>
                item.follower_id === session.profile.id &&
                item.following_id === profileId,
            ),
        ),
      };
    },

    async getCommentLikeState(commentIds) {
      const ids = Array.isArray(commentIds) ? commentIds : [];
      const comments = ids
        .map((commentId) => {
          const likes = state.commentLikes.filter(
            (item) => item.comment_id === commentId,
          );
          return {
            comment_id: commentId,
            like_count: likes.length,
            liked_by_current_user: Boolean(
              session &&
                likes.some((item) => item.user_id === session.profile.id),
            ),
          };
        })
        .sort((left, right) =>
          String(left.comment_id).localeCompare(String(right.comment_id)),
        );
      return { comments };
    },
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test tests/social-notifications-service.test.mjs`
Expected: `11` 个测试全部 pass（`pass 11 / fail 0`）。

- [ ] **Step 8: 全量单测确认无回归**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs tests/static-checks.mjs`
Expected: `89` 个测试全部 pass（`pass 89 / fail 0`）。

- [ ] **Step 9: 提交**

```bash
git add tests/social-notifications-service.test.mjs js/demo-data.mjs js/data-service.mjs
git commit -m "feat: demo data-service social layer — follow/bookmark/comment-like/notifications + unit tests"
```

### Task 7: Supabase 数据服务 — 社交 RPC 镜像 + 既有写路径迁移

**Files:**
- Create: `tests/social-notifications-supabase.test.mjs`
- Modify: `js/data-service.mjs`（`createSupabaseService` 内：`toggleLike` 迁移 `toggle_like_work`、`addComment` 迁移 `create_comment`；在 `getAccountSecurityStatus` 之前插入 16 个社交方法）

Supabase 服务是 RPC 转发薄壳：通知聚合/撤销/禁止自我通知语义由 DB 测试（Task 2-5）与演示服务测试（Task 6）覆盖。本任务通过 `clientOverride` fake client 单测验证「方法 → RPC 名/参数」映射与字段重命名（`next_cursor`→`nextCursor`、`like_count`→`likeCount`、`user_pen_name`/`user_role` 补全）。改造前 `toggleLike`/`addComment` 直连 `likes`/`comments` 表，fake client 对非 `profiles` 表一律返回「直接表访问已撤销」，因此测试在改造前失败。

- [ ] **Step 1: 写失败测试**

创建 `tests/social-notifications-supabase.test.mjs`（完整内容）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";

// Supabase 服务是 RPC 转发薄壳：通知聚合/撤销/禁止自我通知语义由 DB 测试
// （social-notifications-db.test.mjs）与演示服务测试（social-notifications-service.test.mjs）
// 覆盖。本文件用 clientOverride fake client 验证「方法 → RPC 名/参数」映射与字段重命名
// （next_cursor→nextCursor、like_count→likeCount、user_pen_name/user_role 补全）。
// 改造前 toggleLike/addComment 直连 likes/comments 表，fake 对非 profiles 表一律
// 返回「直接表访问已撤销」，因此改造前这些用例会失败。
function makeFakeClient({ failSession = false } = {}) {
  const invoked = [];
  const errorResult = {
    data: null,
    error: { message: "direct table access revoked" },
  };
  const profile = { id: "u-1", pen_name: "松声", bio: "", role: "member" };
  const iso = "2026-08-10T12:00:00+08:00";
  const responses = {
    follow_user: { follower_id: "u-1", following_id: "u-2" },
    unfollow_user: null,
    bookmark_work: { user_id: "u-1", work_id: "work-1" },
    unbookmark_work: null,
    like_comment: { user_id: "u-1", comment_id: "c-1" },
    unlike_comment: null,
    toggle_like_work: { liked: true, like_count: 3 },
    create_comment: {
      id: "c-9",
      work_id: "work-1",
      user_id: "u-1",
      parent_id: null,
      content: "好文",
      is_deleted: false,
      created_at: iso,
    },
    list_notifications: {
      notifications: [
        {
          id: "n-1",
          event_type: "follow",
          target_work_id: null,
          target_comment_id: null,
          actor_pen_names: ["白露"],
          actor_count: 1,
          last_event_at: iso,
          is_read: false,
          work_title: null,
          comment_work_id: null,
        },
      ],
      next_cursor: "Y3Vycw",
    },
    get_notification_unread_count: { unread_count: 2 },
    mark_notification_read: null,
    mark_all_notifications_read: null,
    list_my_following: {
      following: [{ id: "u-2", pen_name: "白露", bio: "", created_at: iso }],
      next_cursor: null,
    },
    list_my_followers: {
      followers: [{ id: "u-3", pen_name: "杏雨", bio: "", created_at: iso }],
      next_cursor: null,
    },
    list_my_bookmarks: {
      bookmarks: [
        {
          id: "work-1",
          title: "河流向北",
          excerpt: "摘要",
          category: "散文",
          author_pen_name: "白露",
          created_at: iso,
        },
      ],
      next_cursor: null,
    },
    get_work_social_counts: { bookmark_count: 5, bookmarked_by_current_user: true },
    get_profile_social_counts: {
      following_count: 2,
      followers_count: 7,
      followed_by_current_user: true,
    },
    get_comment_like_state: {
      comments: [
        { comment_id: "c-1", like_count: 1, liked_by_current_user: true },
        { comment_id: "c-2", like_count: 0, liked_by_current_user: false },
      ],
    },
  };
  const fakeClient = {
    auth: {
      getSession: async () => {
        if (failSession) {
          return { data: null, error: { message: "session required" } };
        }
        return {
          data: {
            session: {
              user: {
                id: "u-1",
                email: "2023123456@accounts.wenyuan.invalid",
              },
            },
          },
          error: null,
        };
      },
    },
    from: (table) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: profile, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => errorResult,
            maybeSingle: async () => errorResult,
          }),
        }),
        insert: async () => errorResult,
        delete: async () => errorResult,
        update: async () => errorResult,
      };
    },
    functions: {
      invoke: async (name, { body }) => {
        invoked.push([name, body]);
        if (name === "account-email" && body.action === "status") {
          return {
            data: {
              state: "verified",
              maskedEmail: "s***g@e***e.com",
              nextSendAt: null,
            },
            error: null,
          };
        }
        return { data: {}, error: null };
      },
    },
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name in responses) {
        return { data: responses[name], error: null };
      }
      return { data: null, error: { message: "unknown rpc: " + name } };
    },
  };
  return { fakeClient, invoked };
}

function supabaseService(failSession = false) {
  const { fakeClient, invoked } = makeFakeClient({ failSession });
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  return { service, invoked };
}

test("Supabase 服务：关注/取关转发 follow_user/unfollow_user", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const followed = await service.followUser("u-2");
  assert.deepEqual(followed, { follower_id: "u-1", following_id: "u-2" });
  assert.deepEqual(invoked.at(-1), [
    "follow_user",
    { p_target_user_id: "u-2" },
  ]);

  await service.unfollowUser("u-2");
  assert.deepEqual(invoked.at(-1), [
    "unfollow_user",
    { p_target_user_id: "u-2" },
  ]);
});

test("Supabase 服务：收藏/取消转发 bookmark_work/unbookmark_work", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const bookmarked = await service.bookmarkWork("work-1");
  assert.deepEqual(bookmarked, { user_id: "u-1", work_id: "work-1" });
  assert.deepEqual(invoked.at(-1), ["bookmark_work", { p_work_id: "work-1" }]);

  await service.unbookmarkWork("work-1");
  assert.deepEqual(invoked.at(-1), ["unbookmark_work", { p_work_id: "work-1" }]);
});

test("Supabase 服务：评论点赞转发 like_comment/unlike_comment", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const liked = await service.likeComment("c-1");
  assert.deepEqual(liked, { user_id: "u-1", comment_id: "c-1" });
  assert.deepEqual(invoked.at(-1), ["like_comment", { p_comment_id: "c-1" }]);

  await service.unlikeComment("c-1");
  assert.deepEqual(invoked.at(-1), ["unlike_comment", { p_comment_id: "c-1" }]);
});

test("Supabase 服务：作品点赞迁移 toggle_like_work，like_count→likeCount", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const result = await service.toggleLike("work-1");
  assert.deepEqual(result, { liked: true, likeCount: 3 });
  assert.deepEqual(invoked.at(-1), ["toggle_like_work", { p_work_id: "work-1" }]);
});

test("Supabase 服务：评论迁移 create_comment，补全 user_pen_name/user_role", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const top = await service.addComment("work-1", "好文");
  assert.equal(top.id, "c-9");
  assert.equal(top.user_pen_name, "松声");
  assert.equal(top.user_role, "member");
  assert.deepEqual(invoked.at(-1), [
    "create_comment",
    { p_work_id: "work-1", p_content: "好文", p_parent_id: null },
  ]);

  await service.addComment("work-1", "回复", "c-1");
  assert.deepEqual(invoked.at(-1), [
    "create_comment",
    { p_work_id: "work-1", p_content: "回复", p_parent_id: "c-1" },
  ]);
});

test("Supabase 服务：通知列表 next_cursor→nextCursor", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const page = await service.listNotifications();
  assert.equal(page.notifications.length, 1);
  assert.equal(page.notifications[0].event_type, "follow");
  assert.deepEqual(page.notifications[0].actor_pen_names, ["白露"]);
  assert.equal(page.nextCursor, "Y3Vycw");
  assert.equal("next_cursor" in page, false);
  assert.deepEqual(invoked.at(-1), [
    "list_notifications",
    { p_cursor: null, p_page_size: 20 },
  ]);

  await service.listNotifications("cur", 5);
  assert.deepEqual(invoked.at(-1), [
    "list_notifications",
    { p_cursor: "cur", p_page_size: 5 },
  ]);
});

test("Supabase 服务：未读数与标记已读", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  assert.deepEqual(await service.getNotificationUnreadCount(), {
    unread_count: 2,
  });
  assert.deepEqual(invoked.at(-1), ["get_notification_unread_count", {}]);

  await service.markNotificationRead("n-1");
  assert.deepEqual(invoked.at(-1), [
    "mark_notification_read",
    { p_notification_id: "n-1" },
  ]);

  await service.markAllNotificationsRead();
  assert.deepEqual(invoked.at(-1), ["mark_all_notifications_read", {}]);
});

test("Supabase 服务：我的关注/粉丝/收藏列表 next_cursor→nextCursor", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const following = await service.listMyFollowing();
  assert.equal(following.following.length, 1);
  assert.equal(following.following[0].pen_name, "白露");
  assert.equal(following.nextCursor, null);
  assert.equal("next_cursor" in following, false);
  assert.deepEqual(invoked.at(-1), [
    "list_my_following",
    { p_cursor: null, p_page_size: 20 },
  ]);

  const followers = await service.listMyFollowers();
  assert.equal(followers.followers.length, 1);
  assert.equal(followers.followers[0].pen_name, "杏雨");
  assert.deepEqual(invoked.at(-1), [
    "list_my_followers",
    { p_cursor: null, p_page_size: 20 },
  ]);

  const bookmarks = await service.listMyBookmarks();
  assert.equal(bookmarks.bookmarks.length, 1);
  assert.equal(bookmarks.bookmarks[0].author_pen_name, "白露");
  assert.deepEqual(invoked.at(-1), [
    "list_my_bookmarks",
    { p_cursor: null, p_page_size: 20 },
  ]);
});

test("Supabase 服务：公开聚合计数与我的状态", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  assert.deepEqual(await service.getWorkSocialCounts("work-1"), {
    bookmark_count: 5,
    bookmarked_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_work_social_counts",
    { p_work_id: "work-1" },
  ]);

  assert.deepEqual(await service.getProfileSocialCounts("u-2"), {
    following_count: 2,
    followers_count: 7,
    followed_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_profile_social_counts",
    { p_profile_id: "u-2" },
  ]);

  const state = await service.getCommentLikeState(["c-1", "c-2"]);
  assert.equal(state.comments.length, 2);
  assert.deepEqual(state.comments[0], {
    comment_id: "c-1",
    like_count: 1,
    liked_by_current_user: true,
  });
  assert.deepEqual(state.comments[1], {
    comment_id: "c-2",
    like_count: 0,
    liked_by_current_user: false,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_comment_like_state",
    { p_comment_ids: ["c-1", "c-2"] },
  ]);
});

test("Supabase 服务：公开计数读取无需登录", async () => {
  const { service, invoked } = supabaseService(true);
  // failSession 让 auth.getSession 抛错：若未来给这三个公开读方法误加 requireRemoteSession，本测试即失败
  assert.deepEqual(await service.getWorkSocialCounts("work-1"), {
    bookmark_count: 5,
    bookmarked_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_work_social_counts",
    { p_work_id: "work-1" },
  ]);
  assert.deepEqual(await service.getProfileSocialCounts("u-2"), {
    following_count: 2,
    followers_count: 7,
    followed_by_current_user: true,
  });
  const state = await service.getCommentLikeState(["c-1", "c-2"]);
  assert.equal(state.comments.length, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/social-notifications-supabase.test.mjs`
Expected: `pass 0 / fail 9`——每个用例都因 `service.followUser is not a function` 等（新方法尚不存在）而失败。

- [ ] **Step 3: 迁移 toggleLike → toggle_like_work**

在 `js/data-service.mjs` 的 `createSupabaseService` 内，把现有 `toggleLike`（约 1712-1732 行）整体替换为：

```js
    async toggleLike(workId) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("toggle_like_work", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return { liked: Boolean(data?.liked), likeCount: data?.like_count ?? 0 };
    },
```

- [ ] **Step 4: 迁移 addComment → create_comment**

把现有 `addComment`（约 1722-1737 行）整体替换为：

```js
    async addComment(workId, content, parentId = null) {
      const current = await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("create_comment", {
        p_work_id: workId,
        p_content: requireText(content, "评论", 2000),
        p_parent_id: parentId ?? null,
      });
      if (error) throw new Error(error.message);
      return {
        ...data,
        user_pen_name: current.profile.pen_name,
        user_role: current.profile.role,
      };
    },
```

- [ ] **Step 5: 插入 16 个社交方法**

在 `getAccountSecurityStatus` 之前（紧跟 `setFeatured` 之后）插入完整代码块（与 Task 6 演示方法同名同签名，仅改为 RPC 转发；写方法只做 `requireRemoteSession + rpc`，读计数方法无需登录）：

```js
    // ---- 私密社交（发布四）----

    async followUser(targetUserId) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("follow_user", {
        p_target_user_id: targetUserId,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async unfollowUser(targetUserId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("unfollow_user", {
        p_target_user_id: targetUserId,
      });
      if (error) throw new Error(error.message);
    },

    async bookmarkWork(workId) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("bookmark_work", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async unbookmarkWork(workId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("unbookmark_work", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
    },

    async likeComment(commentId) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("like_comment", {
        p_comment_id: commentId,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async unlikeComment(commentId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("unlike_comment", {
        p_comment_id: commentId,
      });
      if (error) throw new Error(error.message);
    },

    async listNotifications(cursor, pageSize = 20) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_notifications", {
        p_cursor: cursor ?? null,
        p_page_size: pageSize,
      });
      if (error) throw new Error(error.message);
      return {
        notifications: data?.notifications ?? [],
        nextCursor: data?.next_cursor ?? null,
      };
    },

    async getNotificationUnreadCount() {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("get_notification_unread_count", {});
      if (error) throw new Error(error.message);
      return { unread_count: data?.unread_count ?? 0 };
    },

    async markNotificationRead(notificationId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("mark_notification_read", {
        p_notification_id: notificationId,
      });
      if (error) throw new Error(error.message);
    },

    async markAllNotificationsRead() {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("mark_all_notifications_read", {});
      if (error) throw new Error(error.message);
    },

    async listMyFollowing(cursor, pageSize = 20) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_my_following", {
        p_cursor: cursor ?? null,
        p_page_size: pageSize,
      });
      if (error) throw new Error(error.message);
      return {
        following: data?.following ?? [],
        nextCursor: data?.next_cursor ?? null,
      };
    },

    async listMyFollowers(cursor, pageSize = 20) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_my_followers", {
        p_cursor: cursor ?? null,
        p_page_size: pageSize,
      });
      if (error) throw new Error(error.message);
      return {
        followers: data?.followers ?? [],
        nextCursor: data?.next_cursor ?? null,
      };
    },

    async listMyBookmarks(cursor, pageSize = 20) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_my_bookmarks", {
        p_cursor: cursor ?? null,
        p_page_size: pageSize,
      });
      if (error) throw new Error(error.message);
      return {
        bookmarks: data?.bookmarks ?? [],
        nextCursor: data?.next_cursor ?? null,
      };
    },

    async getWorkSocialCounts(workId) {
      const client = await getClient();
      const { data, error } = await client.rpc("get_work_social_counts", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return {
        bookmark_count: data?.bookmark_count ?? 0,
        bookmarked_by_current_user: Boolean(data?.bookmarked_by_current_user),
      };
    },

    async getProfileSocialCounts(profileId) {
      const client = await getClient();
      const { data, error } = await client.rpc("get_profile_social_counts", {
        p_profile_id: profileId,
      });
      if (error) throw new Error(error.message);
      return {
        following_count: data?.following_count ?? 0,
        followers_count: data?.followers_count ?? 0,
        followed_by_current_user: Boolean(data?.followed_by_current_user),
      };
    },

    async getCommentLikeState(commentIds) {
      const client = await getClient();
      const ids = Array.isArray(commentIds) ? commentIds : [];
      const { data, error } = await client.rpc("get_comment_like_state", {
        p_comment_ids: ids,
      });
      if (error) throw new Error(error.message);
      return { comments: data?.comments ?? [] };
    },
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test tests/social-notifications-supabase.test.mjs`
Expected: `pass 10 / fail 0`。

- [ ] **Step 7: 全量单测确认无回归**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs tests/social-notifications-service.test.mjs tests/social-notifications-supabase.test.mjs tests/static-checks.mjs`
Expected: `110` 个测试全部 pass（`pass 110 / fail 0`）。

- [ ] **Step 8: 提交**

```bash
git add tests/social-notifications-supabase.test.mjs js/data-service.mjs
git commit -m "feat: supabase data-service social layer — migrate like/comment writes to RPC + follow/bookmark/comment-like/notifications + unit tests"
```

### Task 8: 前端基础 — utils（相对时间 + 通知文案）、路由、导航入口、样式、静态断言

**Files:**
- Modify: `js/utils.mjs`（追加 `formatRelativeTime`/`formatActors`/`buildNotificationText`；`parseRoute` 新增社交路由）
- Modify: `tests/utils.test.mjs`（新增相对时间、通知文案、社交路由测试）
- Modify: `index.html`（顶部账号菜单追加通知/收藏/关注入口；移动底部导航加「消息」第 5 项 + 未读角标）
- Modify: `assets/styles.css`（`.nav-badge`、移动导航改 5 列）
- Modify: `tests/static-checks.mjs`（移动导航断言 5 项 + 社交入口断言）

本任务只铺前端基础设施：路由解析、入口、文案/时间工具与静态断言；页面渲染（Task 10）与作品/作者页社交操作（Task 9）在后续任务接入。Task 8 自身由 utils 单测 + static-checks 全绿验证。

- [ ] **Step 1: 写失败测试**

在 `tests/utils.test.mjs` 的 import 块加入 `formatRelativeTime`/`formatActors`/`buildNotificationText`，并新增 4 个测试（相对时间、通知文案、actor 文案、社交路由）：

```js
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatActors,
  buildNotificationText,
} from "../js/utils.mjs";
```

在「作品版本与编辑路由解析到对应页面」测试之后追加：

```js
test("社交路由解析到通知与我的关注/粉丝/收藏", () => {
  assert.deepEqual(parseRoute("#/notifications"), { name: "notifications" });
  assert.deepEqual(parseRoute("#/my/following"), { name: "my-following" });
  assert.deepEqual(parseRoute("#/my/followers"), { name: "my-followers" });
  assert.deepEqual(parseRoute("#/my/bookmarks"), { name: "my-bookmarks" });
  assert.deepEqual(parseRoute("#/my/"), { name: "not-found" });
  assert.deepEqual(parseRoute("#/my/following/extra"), { name: "not-found" });
});

test("相对时间格式化：从刚发生到超过一年回退日期", () => {
  const now = new Date("2026-08-10T12:00:00+08:00").getTime();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  assert.equal(formatRelativeTime(at(0.1), now), "刚刚");
  assert.equal(formatRelativeTime(at(5), now), "5 分钟前");
  assert.equal(formatRelativeTime(at(59), now), "59 分钟前");
  assert.equal(formatRelativeTime(at(60), now), "1 小时前");
  assert.equal(formatRelativeTime(at(23 * 60), now), "23 小时前");
  assert.equal(formatRelativeTime(at(24 * 60), now), "昨天");
  assert.equal(formatRelativeTime(at(3 * 24 * 60), now), "3 天前");
  assert.equal(formatRelativeTime(at(14 * 24 * 60), now), "2 周前");
  assert.equal(formatRelativeTime(at(120 * 24 * 60), now), "4 个月前");
  assert.equal(formatRelativeTime("", now), "");
});

test("通知条目文案：单人、多人折叠 +N 与按事件类型拼接", () => {
  const singleFollow = {
    event_type: "follow",
    actor_pen_names: ["白露"],
    actor_count: 1,
    work_title: null,
  };
  assert.equal(buildNotificationText(singleFollow), "白露 关注了你");

  const multiLike = {
    event_type: "work_like",
    actor_pen_names: ["编辑部", "白露", "杏雨"],
    actor_count: 6,
    work_title: "末班车经过友谊校区",
  };
  assert.equal(
    buildNotificationText(multiLike),
    "编辑部、白露、杏雨 等 6 人 赞了你的作品《末班车经过友谊校区》",
  );

  const twoActors = {
    event_type: "work_bookmark",
    actor_pen_names: ["编辑部", "白露"],
    actor_count: 2,
    work_title: "河流向北",
  };
  assert.equal(buildNotificationText(twoActors), "编辑部、白露 收藏了你的作品《河流向北》");

  const reply = { event_type: "comment_reply", actor_pen_names: ["杏雨"], actor_count: 1, work_title: null };
  assert.equal(buildNotificationText(reply), "杏雨 回复了你的评论");

  const commentLike = { event_type: "comment_like", actor_pen_names: ["松声"], actor_count: 1, work_title: null };
  assert.equal(buildNotificationText(commentLike), "松声 赞了你的评论");

  const unknown = { event_type: "unknown", actor_pen_names: [], actor_count: 0, work_title: null };
  assert.equal(buildNotificationText(unknown), "有人 与你互动了");
});

test("通知 actor 文案：计数超过预览长度时追加等 N 人", () => {
  assert.equal(
    formatActors({ actor_pen_names: ["编辑部", "白露", "杏雨"], actor_count: 6 }),
    "编辑部、白露、杏雨 等 6 人",
  );
  assert.equal(
    formatActors({ actor_pen_names: ["编辑部", "白露"], actor_count: 2 }),
    "编辑部、白露",
  );
  assert.equal(formatActors({ actor_pen_names: ["白露"], actor_count: 1 }), "白露");
  assert.equal(formatActors({ actor_pen_names: [], actor_count: 0 }), "有人");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/utils.test.mjs`
Expected: `pass 30 / fail 4`（新导入的函数与路由尚未实现，用例全部失败）。

- [ ] **Step 3: 实现 utils 工具与路由**

在 `js/utils.mjs` 的 `formatDateTime` 之后追加相对时间：

```js
// 站内通知的相对时间：刚发生、N 分钟/小时/天前、昨天、N 周/月前，超过一年回退到具体日期。
export function formatRelativeTime(value, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = new Date(now).getTime();
  if (Number.isNaN(current)) return "";
  const diff = Math.max(0, current - date.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return formatDate(value);
}
```

在 `parseRoute` 的 `return { name: "not-found" };` 之前追加社交路由：

```js
  if (parts.length === 1 && parts[0] === "notifications") {
    return { name: "notifications" };
  }
  if (parts.length === 2 && parts[0] === "my") {
    if (parts[1] === "following") return { name: "my-following" };
    if (parts[1] === "followers") return { name: "my-followers" };
    if (parts[1] === "bookmarks") return { name: "my-bookmarks" };
  }
```

在 `parseRoute` 之后（`filterAndSortWorks` 之前）追加通知文案工具：

```js
// 通知条目的 actor 文案：单人为笔名；多人取最近预览（cap 3）顿号连接，
// 计数超过预览长度时追加「等 N 人」。与 RPC actor_pen_names + actor_count 契约对应。
export function formatActors(notification) {
  const names = Array.isArray(notification?.actor_pen_names)
    ? notification.actor_pen_names
    : [];
  const count = Number(notification?.actor_count) || names.length || 0;
  if (count <= 1) return names[0] ?? "有人";
  const preview = names.slice(0, 3).join("、");
  return count > names.length ? `${preview} 等 ${count} 人` : preview;
}

// 通知条目的展示文案（+N 折叠后的完整句子）。
export function buildNotificationText(notification) {
  const actor = formatActors(notification);
  const title = notification?.work_title ? `《${notification.work_title}》` : "";
  switch (notification?.event_type) {
    case "work_comment":
      return `${actor} 评论了你的作品${title}`;
    case "comment_reply":
      return `${actor} 回复了你的评论`;
    case "work_like":
      return `${actor} 赞了你的作品${title}`;
    case "follow":
      return `${actor} 关注了你`;
    case "work_bookmark":
      return `${actor} 收藏了你的作品${title}`;
    case "comment_like":
      return `${actor} 赞了你的评论`;
    default:
      return `${actor} 与你互动了`;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/utils.test.mjs`
Expected: `pass 34 / fail 0`。

- [ ] **Step 5: 更新顶部账号菜单与移动底部导航**

在 `index.html` 把账号菜单（`id="accountMenu"`）替换为含社交入口的版本：

```html
          <div class="account-menu" id="accountMenu" hidden>
            <a id="profileLink" href="#/">我的主页</a>
            <a href="#/notifications">
              通知
              <span class="nav-badge" id="menuNotificationsBadge" hidden></span>
            </a>
            <a href="#/my/bookmarks">我的收藏</a>
            <a href="#/my/following">我关注的人</a>
            <a href="#/my/followers">关注我的人</a>
            <a href="#/account/security">账号安全</a>
            <button type="button" data-action="logout">退出登录</button>
          </div>
```

把移动底部导航替换为含「消息」第 5 项（置于「我的」之前）的版本：

```html
    <nav class="mobile-bottom-nav" aria-label="移动端主要导航">
      <a href="#/" data-nav="home">翻阅</a>
      <a href="#/discussions" data-nav="discussions">讨论</a>
      <a href="#/write" data-nav="write">写作</a>
      <a href="#/notifications" data-nav="notifications">
        消息
        <span class="nav-badge" id="notificationsNavBadge" hidden></span>
      </a>
      <a
        id="mobileProfileLink"
        href="#/"
        data-nav="my"
        data-action="open-auth"
        data-return-hash="__current-profile__"
      >我的</a>
    </nav>
```

- [ ] **Step 6: 更新样式**

在 `assets/styles.css` 的 `.account-menu a:hover` 之后追加 `.nav-badge`；并把移动导航 `grid-template-columns` 从 `repeat(4, 1fr)` 改为 `repeat(5, 1fr)`、移动锚点加 `position: relative`：

```css
.nav-badge {
  display: inline-block;
  min-width: 1rem;
  margin-left: 0.35rem;
  padding: 0 0.28rem;
  border-radius: 999px;
  background: var(--vermilion);
  color: var(--paper);
  font-family: var(--utility);
  font-size: 0.7rem;
  line-height: 1.15rem;
  text-align: center;
  vertical-align: top;
}

.mobile-bottom-nav .nav-badge {
  position: absolute;
  top: 0.15rem;
  right: calc(50% - 1.7rem);
  margin-left: 0;
}
```

- [ ] **Step 7: 更新静态断言**

把 `tests/static-checks.mjs` 的移动导航断言从 4 项改为 5 项（锚点可能含嵌套角标 `<span>`，需在标签处截断文本节点），并新增社交入口断言：

```js
test("移动端底部导航使用五个已批准入口", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const navigation = html.match(
    /<nav[^>]+class="mobile-bottom-nav"[\s\S]*?<\/nav>/,
  )?.[0];

  assert.ok(navigation, "缺少移动端底部导航");
  assert.deepEqual(
    // 取每个锚点首个文本节点（消息入口含未读角标 <span>，需在标签处截断）
    [...navigation.matchAll(/<a[^>]*>\s*([^<]+?)\s*(?:<\/a>|<)/g)].map(
      (match) => match[1].trim(),
    ),
    ["翻阅", "讨论", "写作", "消息", "我的"],
  );
  assert.match(navigation, /data-return-hash="__current-profile__"/);
  assert.match(navigation, /#\/notifications/);
});

test("顶部账号菜单与移动底部导航提供私密社交入口", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const menu = html.match(/<div\s+class="account-menu"[\s\S]*?<\/div>/)?.[0];
  assert.ok(menu, "缺少顶部账号菜单");
  for (const href of ["#/notifications", "#/my/bookmarks", "#/my/following", "#/my/followers"]) {
    assert.match(menu, new RegExp(href.replace("#/", "#\\/")));
  }
  const mobileNav = html.match(
    /<nav[^>]+class="mobile-bottom-nav"[\s\S]*?<\/nav>/,
  )?.[0];
  assert.match(mobileNav, /id="notificationsNavBadge"/);
  assert.match(mobileNav, /data-nav="notifications"/);
});
```

- [ ] **Step 8: 运行静态断言确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: `pass 27 / fail 0`。

- [ ] **Step 9: 全量单测确认无回归**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs tests/social-notifications-service.test.mjs tests/social-notifications-supabase.test.mjs tests/static-checks.mjs`
Expected: `115` 个测试全部 pass（`pass 115 / fail 0`）。注：Task 7 实际回归为 110（含评审修复新增的 3 个测试），Task 8 新增 utils 4 + static-checks 1 = 5，故为 115；若实际计数与此不同，以实际为准并报告。

- [ ] **Step 10: 提交**

```bash
git add js/utils.mjs tests/utils.test.mjs index.html assets/styles.css tests/static-checks.mjs
git commit -m "feat: social nav foundation — relative time, notification text, parseRoute routes, nav entries, styles, static checks"
```

### Task 9: 作品页社交操作条 + 评论点赞 + 作者页关注

**Files:**
- Modify: `js/app.js`（`renderWork` 收藏/关注按钮、`createCommentItem` 评论点赞、`renderAuthor` 关注与公开计数、三个 handler、点击分发）
- Modify: `assets/styles.css`（`.work-reactions` 反应区、`.comment-like-button` 激活态）
- Modify: `tests/static-checks.mjs`（作品页/作者页/样式社交断言）

作品页把点赞/收藏/关注三个反应按钮放进 `work-reactions` 反应区；`getWorkSocialCounts`、`getProfileSocialCounts`、`getCommentLikeState` 均为公开读 RPC（无需登录），写操作才走 `requireVerifiedWrite` 守卫。关注按钮仅非本人时渲染；评论点赞按钮始终渲染（未登录点击走登录）。浏览器交互行为由 Task 11 的 demo 流程验证，本任务用 static-checks + 全量单测确认结构就位且无回归。

- [ ] **Step 1: 写失败静态断言**

在 `tests/static-checks.mjs` 的「阅读页支持选区批注」测试之前追加三个断言：

```js
test("作品页提供收藏与关注作者按钮，评论行提供点赞", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /service\.getWorkSocialCounts\(/);
  assert.match(app, /service\.getProfileSocialCounts\(/);
  assert.match(app, /service\.getCommentLikeState\(/);
  assert.match(app, /action:\s*"toggle-bookmark"/);
  assert.match(app, /action:\s*"toggle-follow-author"/);
  assert.match(app, /action:\s*"toggle-comment-like"/);
  assert.match(app, /handleBookmark\(/);
  assert.match(app, /handleFollowAuthor\(/);
  assert.match(app, /handleCommentLike\(/);
  assert.match(app, /已收藏/);
  assert.match(app, /已关注/);
  assert.match(app, /bookmarkLabel/);
  assert.match(app, /followLabel/);
  assert.match(app, /commentLikeMap\.get\(/);
  assert.match(app, /commentLiked \? "已赞" : "赞"/);
});

test("作者页展示关注与粉丝公开计数并允许关注他人", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /"关注",\s*profileSocial\.following_count/);
  assert.match(app, /"粉丝",\s*profileSocial\.followers_count/);
  assert.match(app, /toggle-follow-author/);
});

test("样式提供社交反应区与评论点赞激活态", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.work-reactions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(
    css,
    /\.comment-like-button\[aria-pressed="true"\]\s*\{[\s\S]*?color:\s*var\(--vermilion\)/,
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/static-checks.mjs`
Expected: 新断言 fail（`js/app.js` 尚无社交按钮、作者页计数与样式）。

- [ ] **Step 3: 实现 renderWork 社交数据与操作条**

把 `renderWork` 的数据加载扩展为「作品 + 批注 + 作品社交计数 + 作者社交计数 + 评论点赞状态」三组并行读：

```js
    const [work, quotes] = await Promise.all([
      service.getWork(workId),
      service.listWorkQuotes(workId),
    ]);
    state.currentWork = work;
    const [socialCounts, profileSocial, commentLikeState] = await Promise.all([
      service.getWorkSocialCounts(workId),
      service.getProfileSocialCounts(work.author_id),
      work.comments.length
        ? service.getCommentLikeState(
            work.comments.map((comment) => comment.id),
          )
        : Promise.resolve({ comments: [] }),
    ]);
    const commentLikeMap = new Map(
      commentLikeState.comments.map((item) => [item.comment_id, item]),
    );
```

把点赞按钮之后追加收藏按钮，并把三个反应按钮包进 `.work-reactions`：

```js
    const bookmarkButton = element("button", {
      className: "like-button",
      type: "button",
      dataset: { action: "toggle-bookmark", workId: work.id },
      attrs: {
        "aria-pressed": String(socialCounts.bookmarked_by_current_user),
        "aria-label": socialCounts.bookmarked_by_current_user
          ? "取消收藏"
          : "收藏这篇作品",
      },
    });
    bookmarkButton.append(
      element("span", {
        text: socialCounts.bookmarked_by_current_user ? "已收藏" : "收藏",
        dataset: { bookmarkLabel: work.id },
      }),
      element("span", {
        text: String(socialCounts.bookmark_count),
        dataset: { bookmarkCount: work.id },
      }),
    );
    const reactions = element("div", { className: "work-reactions" }, [
      likeButton,
      bookmarkButton,
    ]);
    if (state.session?.profile.id !== work.author_id) {
      const followButton = element("button", {
        className: "like-button",
        type: "button",
        dataset: { action: "toggle-follow-author", authorId: work.author_id },
        attrs: {
          "aria-pressed": String(profileSocial.followed_by_current_user),
          "aria-label": profileSocial.followed_by_current_user
            ? "取消关注作者"
            : "关注作者",
        },
      });
      followButton.append(
        element("span", {
          text: profileSocial.followed_by_current_user ? "已关注" : "关注",
          dataset: { followLabel: work.author_id },
        }),
        element("span", {
          text: String(profileSocial.followers_count),
          dataset: { followCount: work.author_id },
        }),
      );
      reactions.append(followButton);
    }
    actionBar.append(reactions);
```

把评论树渲染传入 `commentLikeMap`：

```js
    const commentTree = element("ol", { className: "comment-thread" });
    const roots = buildCommentTree(work.comments);
    if (roots.length) {
      roots.forEach((comment) =>
        commentTree.append(createCommentItem(comment, work.id, commentLikeMap)),
      );
    } else {
```

- [ ] **Step 4: 实现 createCommentItem 评论点赞**

改 `createCommentItem` 签名（追加 `commentLikeMap`，默认空 Map）并递归透传；在「回复/删除」之前给每条未删除评论加「赞」按钮：

```js
function createCommentItem(comment, workId, commentLikeMap = new Map(), depth = 0) {
```

```js
  if (!comment.is_deleted) {
    const actions = element("div", { className: "comment-actions" });
    const likeState = commentLikeMap.get(comment.id);
    const commentLiked = Boolean(likeState?.liked_by_current_user);
    actions.append(
      element("button", {
        className: "comment-like-button",
        type: "button",
        text: `${commentLiked ? "已赞" : "赞"} ${likeState?.like_count ?? 0}`,
        dataset: { action: "toggle-comment-like", commentId: comment.id },
        attrs: { "aria-pressed": String(commentLiked) },
      }),
    );
    if (state.session) {
```

递归调用处改为透传 `commentLikeMap`：

```js
    comment.replies.forEach((reply) => {
      replies.append(
        createCommentItem(reply, workId, commentLikeMap, depth + 1),
      );
    });
```

- [ ] **Step 5: 实现 renderAuthor 关注与公开计数**

把作者资料加载扩展为并行的资料 + 社交计数，非本人时渲染关注按钮并展示关注/粉丝公开计数：

```js
    const [profile, profileSocial] = await Promise.all([
      service.getProfile(profileId),
      service.getProfileSocialCounts(profileId),
    ]);
```

```js
    } else {
      const followButton = element("button", {
        className: "like-button",
        type: "button",
        dataset: { action: "toggle-follow-author", authorId: profile.id },
        attrs: {
          "aria-pressed": String(profileSocial.followed_by_current_user),
          "aria-label": profileSocial.followed_by_current_user
            ? "取消关注"
            : "关注该作者",
        },
      });
      followButton.append(
        element("span", {
          text: profileSocial.followed_by_current_user ? "已关注" : "关注",
          dataset: { followLabel: profile.id },
        }),
        element("span", {
          text: String(profileSocial.followers_count),
          dataset: { followCount: profile.id },
        }),
      );
      identity.append(
        element("div", { className: "profile-actions" }, [followButton]),
      );
    }
    const stats = element("dl", { className: "profile-stats" });
    [
      ["作品", profile.work_count],
      ["获赞", profile.total_likes],
      ["评论", profile.comment_count],
      ["关注", profileSocial.following_count],
      ["粉丝", profileSocial.followers_count],
    ].forEach(([label, value]) => {
```

（原 `if (state.session?.profile.id === profile.id) { ... 编辑资料 ... }` 分支保留，else 分支替换为上面的关注按钮。）

- [ ] **Step 6: 实现三个 handler 与点击分发**

在 `handleLike` 之后追加收藏/关注/评论点赞 handler（乐观更新 + 服务端结果回填 + 失败回滚）：

```js
// 收藏与关注的乐观更新结构一致：aria-pressed 切换激活态、计数 ±1，
// 服务端返回后以实际结果为准，失败回滚原状态。
async function handleBookmark(button) {
  if (!requireVerifiedWrite(window.location.hash)) return;
  const workId = button.dataset.workId;
  const countNode = button.querySelector(
    `[data-bookmark-count="${CSS.escape(workId)}"]`,
  );
  const labelNode = button.querySelector(
    `[data-bookmark-label="${CSS.escape(workId)}"]`,
  );
  const originalPressed = button.getAttribute("aria-pressed") === "true";
  const originalCount = Number(countNode.textContent);
  const optimisticPressed = !originalPressed;
  button.setAttribute("aria-pressed", String(optimisticPressed));
  labelNode.textContent = optimisticPressed ? "已收藏" : "收藏";
  countNode.textContent = String(
    Math.max(0, originalCount + (optimisticPressed ? 1 : -1)),
  );
  button.disabled = true;
  try {
    if (optimisticPressed) {
      await service.bookmarkWork(workId);
    } else {
      await service.unbookmarkWork(workId);
    }
  } catch (error) {
    button.setAttribute("aria-pressed", String(originalPressed));
    labelNode.textContent = originalPressed ? "已收藏" : "收藏";
    countNode.textContent = String(originalCount);
    showToast(`收藏状态没有保存：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function handleFollowAuthor(button) {
  if (!requireVerifiedWrite(window.location.hash)) return;
  const authorId = button.dataset.authorId;
  const countNode = button.querySelector(
    `[data-follow-count="${CSS.escape(authorId)}"]`,
  );
  const labelNode = button.querySelector(
    `[data-follow-label="${CSS.escape(authorId)}"]`,
  );
  const originalPressed = button.getAttribute("aria-pressed") === "true";
  const originalCount = Number(countNode.textContent);
  const optimisticPressed = !originalPressed;
  button.setAttribute("aria-pressed", String(optimisticPressed));
  labelNode.textContent = optimisticPressed ? "已关注" : "关注";
  countNode.textContent = String(
    Math.max(0, originalCount + (optimisticPressed ? 1 : -1)),
  );
  button.disabled = true;
  try {
    if (optimisticPressed) {
      await service.followUser(authorId);
    } else {
      await service.unfollowUser(authorId);
    }
  } catch (error) {
    button.setAttribute("aria-pressed", String(originalPressed));
    labelNode.textContent = originalPressed ? "已关注" : "关注";
    countNode.textContent = String(originalCount);
    showToast(`关注状态没有保存：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function handleCommentLike(button) {
  if (!requireVerifiedWrite(window.location.hash)) return;
  const commentId = button.dataset.commentId;
  const originalPressed = button.getAttribute("aria-pressed") === "true";
  const originalText = button.textContent;
  const originalCount = Number(
    (button.textContent.match(/(\d+)/) ?? [])[1] ?? 0,
  );
  const optimisticPressed = !originalPressed;
  const optimisticCount = Math.max(
    0,
    originalCount + (optimisticPressed ? 1 : -1),
  );
  button.setAttribute("aria-pressed", String(optimisticPressed));
  button.textContent = `${optimisticPressed ? "已赞" : "赞"} ${optimisticCount}`;
  button.disabled = true;
  try {
    if (optimisticPressed) {
      await service.likeComment(commentId);
    } else {
      await service.unlikeComment(commentId);
    }
  } catch (error) {
    button.setAttribute("aria-pressed", String(originalPressed));
    button.textContent = originalText;
    showToast(`点赞状态没有保存：${error.message}`);
  } finally {
    button.disabled = false;
  }
}
```

在点击分发（`action === "toggle-like"` 之后）追加三个动作：

```js
  } else if (action === "toggle-like") {
    await handleLike(trigger);
  } else if (action === "toggle-bookmark") {
    await handleBookmark(trigger);
  } else if (action === "toggle-follow-author") {
    await handleFollowAuthor(trigger);
  } else if (action === "toggle-comment-like") {
    await handleCommentLike(trigger);
  } else if (action === "export-work") {
```

- [ ] **Step 7: 更新样式**

在 `assets/styles.css` 的 `.like-button[aria-pressed="true"]` 之后追加反应区；在 `.comment-actions button:hover` 之后追加评论点赞激活态：

```css
.work-reactions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
}
```

```css
.comment-like-button[aria-pressed="true"] {
  color: var(--vermilion);
  font-weight: 600;
}
```

- [ ] **Step 8: 运行静态断言确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: `pass 30 / fail 0`。

- [ ] **Step 9: 全量单测确认无回归**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs tests/social-notifications-service.test.mjs tests/social-notifications-supabase.test.mjs tests/static-checks.mjs`
Expected: `115` 个测试全部 pass（`pass 115 / fail 0`）。

- [ ] **Step 10: 语法检查**

Run: `node --check js/app.js`
Expected: 无输出（通过）。

- [ ] **Step 11: 提交**

```bash
git add js/app.js assets/styles.css tests/static-checks.mjs
git commit -m "feat: work social actions — bookmark/follow buttons, comment likes, author page follow"
```

### Task 10: 通知页 + 我的关注/粉丝/收藏页 + 未读角标

**Files:**
- Modify: `js/app.js`（状态、utils import、updateHeader 高亮、未读角标、通知页、我的列表、路由分发、点击分发、登录后角标刷新）
- Modify: `assets/styles.css`（通知列表 + 成员列表样式）
- Modify: `tests/static-checks.mjs`（新增 3 个静态断言）
- Modify: `tests/browser-check.cjs`（Step 14 修复移动底栏 5 项过期断言）

本任务完成发布四的前端收口页面：站内通知页（聚合文案、未读高亮、单条已读/全部已读、分页加载）、我的关注/粉丝/收藏页（owner 作用域 RPC 分页、成员与收藏条目渲染）、桌面账号菜单与移动底栏两处未读角标（登录、退出、路由切换、已读操作后刷新）。作品页收藏/关注作者/评论点赞已在 Task 9 接入；浏览器端完整社交流程由 Task 11 以 demo 模式固化进 browser-check。本任务由 static-checks 33 条 + 前端相关单测子集 118 条 + browser-check 双流回归验证。

- [ ] **Step 1: 写失败静态断言**

在 `tests/static-checks.mjs` 的「样式提供社交反应区与评论点赞激活态」测试之后追加 3 个测试：

```js
test("通知页渲染、未读角标、已读与跳转目标齐备", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /function\s+renderNotifications\s*\(/);
  assert.match(app, /renderNotificationsList\s*\(/);
  assert.match(app, /service\.listNotifications\(/);
  assert.match(app, /service\.getNotificationUnreadCount\(/);
  assert.match(app, /service\.markNotificationRead\(/);
  assert.match(app, /service\.markAllNotificationsRead\(/);
  assert.match(app, /refreshNotificationBadge\s*\(/);
  assert.match(app, /action:\s*"mark-all-notifications-read"/);
  assert.match(app, /action:\s*"load-more-notifications"/);
  assert.match(app, /action:\s*"open-notification"/);
  assert.match(app, /notificationTarget\s*\(/);
  assert.match(app, /formatRelativeTime\(notification\.last_event_at\)/);
  assert.match(app, /buildNotificationText\(notification\)/);
  assert.match(app, /notification-item unread/);
});

test("我的关注/粉丝/收藏页经 owner 作用域 RPC 分页加载", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /service\.listMyFollowing\(/);
  assert.match(app, /service\.listMyFollowers\(/);
  assert.match(app, /service\.listMyBookmarks\(/);
  assert.match(app, /renderMyListPageRoute\s*\(/);
  assert.match(app, /route\.name === "my-following"/);
  assert.match(app, /route\.name === "my-followers"/);
  assert.match(app, /route\.name === "my-bookmarks"/);
  assert.match(app, /"全部已读"/);
  assert.match(app, /member-list/);
  assert.match(app, /createBookmarkRow\s*\(/);
});

test("消息页与我的列表提供样式", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.notification-list\s*\{/);
  assert.match(css, /\.notification-row\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(css, /\.notification-item\.unread[\s\S]*?font-weight:\s*600/);
  assert.match(css, /\.member-list\s*\{/);
  assert.match(css, /\.member-name\s*\{/);
});
```

- [ ] **Step 2: 运行静态断言确认失败**

Run: `node --test tests/static-checks.mjs`
Expected: 新增 3 个测试 FAIL（app.js/CSS 尚无对应实现），总数 33 个测试中 3 个失败。

- [ ] **Step 3: app.js 状态与 utils import**

在 `state` 的 `discussionRequestId: 0,` 之后追加：

```js
  discussionRequestId: 0,
  notifications: {
    items: [],
    nextCursor: null,
    loading: false,
  },
  myList: {
    items: [],
    nextCursor: null,
    loading: false,
  },
  notificationsRequestId: 0,
  myListRequestId: 0,
```

在 `./utils.mjs` import 块加入 `buildNotificationText`（`buildCommentTree` 之后）与 `formatRelativeTime`（`formatDateTime` 之后）：

```js
import {
  buildCommentTree,
  buildNotificationText,
  CATEGORIES,
  codepointLength,
  codepointSlice,
  countChineseText,
  createExcerpt,
  filterAndSortWorks,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  getPenNameChangeAvailability,
  isPoetryCategory,
  normalizeCategory,
  parseRoute,
  PUBLISHABLE_CATEGORIES,
  splitDisplayParagraphs,
  splitQuoteUnits,
  validatePassword,
  validateStudentNumber,
} from "./utils.mjs";
```

- [ ] **Step 4: updateHeader 的「我的」导航高亮**

在 `updateHeader` 的移动导航 active 判断中，把 `link.dataset.nav === "my"` 分支替换为：

```js
        (link.dataset.nav === "my" &&
          (route.name === "author"
            ? route.id === state.session?.profile?.id
            : ["my-following", "my-followers", "my-bookmarks"].includes(
                route.name,
              )))
```

- [ ] **Step 5: 未读角标、跳转目标与通知加载**

在 `renderNotFound` 定义之前插入：

```js
async function refreshNotificationBadge() {
  const menuBadge = document.querySelector("#menuNotificationsBadge");
  const navBadge = document.querySelector("#notificationsNavBadge");
  let unread = 0;
  if (state.session) {
    try {
      const result = await service.getNotificationUnreadCount();
      unread = Number(result.unread_count) || 0;
    } catch {
      unread = 0;
    }
  }
  for (const badge of [menuBadge, navBadge]) {
    if (!badge) continue;
    if (unread === 0) {
      badge.hidden = true;
      badge.textContent = "";
      badge.removeAttribute("aria-label");
    } else {
      badge.hidden = false;
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.setAttribute("aria-label", `${unread} 条未读消息`);
    }
  }
}

// 通知条目的跳转目标：作品类事件指向作品页；评论类事件指向评论所在作品；
// follow 无目标（服务端不返回 actor id），仅标记已读，不跳转。
function notificationTarget(notification) {
  const workId =
    notification?.target_work_id || notification?.comment_work_id || null;
  if (workId) return `#/works/${encodeURIComponent(workId)}`;
  return null;
}

async function loadNotificationsPage({ reset = true } = {}) {
  const requestId = ++state.notificationsRequestId;
  if (reset) {
    state.notifications.items = [];
    state.notifications.nextCursor = null;
  }
  state.notifications.loading = true;
  try {
    const result = await service.listNotifications(
      reset ? null : state.notifications.nextCursor,
      20,
    );
    if (requestId !== state.notificationsRequestId) return;
    state.notifications.items = reset
      ? result.notifications
      : [...state.notifications.items, ...result.notifications];
    state.notifications.nextCursor = result.nextCursor;
    state.notifications.loading = false;
  } catch (error) {
    state.notifications.loading = false;
    if (reset) {
      showError("消息暂时无法加载", error.message, true);
    } else {
      showToast(error.message);
    }
    return;
  }
  if (parseRoute(window.location.hash).name === "notifications") {
    renderNotificationsList();
  }
}
```

- [ ] **Step 6: 通知页渲染**

在 `loadNotificationsPage` 之后插入：

```js
async function renderNotifications() {
  showLoading("正在整理消息");
  if (!state.session) {
    const shell = element("div", { className: "page-shell auth-gate" }, [
      element("p", { className: "eyebrow", text: "NOTIFICATIONS" }),
      element("h2", { text: "登录后查看消息" }),
      element("p", {
        text: "评论、回复、点赞、关注与收藏的动态会集中出现在这里。",
      }),
      element("button", {
        className: "primary-button",
        type: "button",
        text: "登录",
        dataset: { action: "open-auth", returnHash: "#/notifications" },
      }),
    ]);
    replaceContent(app, shell);
    return;
  }
  await loadNotificationsPage({ reset: true });
}

function renderNotificationsList() {
  const shell = element("div", { className: "page-shell" });
  const head = element(
    "header",
    { className: "page-header notification-head" },
    [
      element("div", {}, [
        element("p", { className: "eyebrow", text: "NOTIFICATIONS" }),
        element("h1", { text: "消息" }),
        element("p", {
          text: "与你作品和互动相关的动态，同类事件会合并为一条。",
        }),
      ]),
      state.notifications.items.some((item) => !item.is_read)
        ? element("button", {
            className: "secondary-button",
            type: "button",
            text: "全部已读",
            dataset: { action: "mark-all-notifications-read" },
          })
        : null,
    ],
  );
  const list = element("ol", { className: "notification-list" });
  state.notifications.items.forEach((notification) => {
    const unread = notification.is_read !== true;
    const item = element("li", {
      className: unread
        ? "notification-item unread"
        : "notification-item",
      dataset: { notificationId: notification.id },
    });
    item.append(
      element("button", {
        className: "notification-row",
        type: "button",
        dataset: {
          action: "open-notification",
          notificationId: notification.id,
        },
        attrs: {
          "aria-label": `${buildNotificationText(notification)}。${unread ? "未读" : "已读"}`,
        },
      }, [
        element("span", {
          className: "notification-text",
          text: buildNotificationText(notification),
        }),
        element("time", {
          className: "notification-time",
          text: formatRelativeTime(notification.last_event_at),
          attrs: { datetime: notification.last_event_at },
        }),
      ]),
    );
    list.append(item);
  });
  if (!state.notifications.items.length) {
    list.append(
      element("li", {
        className: "empty-state",
        text: "还没有消息。有人评论、回复、点赞或关注你时，会出现在这里。",
      }),
    );
  }
  shell.append(head, list);
  if (state.notifications.nextCursor) {
    shell.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "更多消息",
          dataset: { action: "load-more-notifications" },
        }),
      ]),
    );
  }
  replaceContent(app, shell);
}
```

- [ ] **Step 7: 已读处理**

在 `renderNotificationsList` 之后插入：

```js
async function handleOpenNotification(button) {
  const notificationId = button.dataset.notificationId;
  const notification = state.notifications.items.find(
    (item) => item.id === notificationId,
  );
  if (!notification) return;
  if (notification.is_read !== true) {
    try {
      await service.markNotificationRead(notificationId);
      notification.is_read = true;
    } catch (error) {
      showToast(`消息状态没有保存：${error.message}`);
      return;
    }
    await refreshNotificationBadge();
  }
  const target = notificationTarget(notification);
  if (target) {
    window.location.hash = target;
  } else {
    renderNotificationsList();
  }
}

async function handleMarkAllNotificationsRead() {
  if (!state.session) return;
  try {
    await service.markAllNotificationsRead();
    state.notifications.items.forEach((item) => {
      item.is_read = true;
    });
    await refreshNotificationBadge();
    if (parseRoute(window.location.hash).name === "notifications") {
      renderNotificationsList();
    }
  } catch (error) {
    showToast(`消息没有全部标为已读：${error.message}`);
  }
}
```

- [ ] **Step 8: 我的关注/粉丝/收藏页**

在 `handleMarkAllNotificationsRead` 之后插入：

```js
const MY_LIST_META = {
  following: {
    eyebrow: "FOLLOWING",
    title: "我关注的人",
    description: "你关注的人发布新作后，会出现在你的消息里。",
    empty: "还没有关注任何人。去作品页关注喜欢的作者。",
  },
  followers: {
    eyebrow: "FOLLOWERS",
    title: "关注我的人",
    description: "关注列表彼此保密，这里只展示对方的公开资料。",
    empty: "还没有人关注你。",
  },
  bookmarks: {
    eyebrow: "BOOKMARKS",
    title: "我的收藏",
    description: "只有你自己能看到收藏列表。",
    empty: "还没有收藏任何作品。",
  },
};

async function loadMyListPage(kind, { reset = true } = {}) {
  const requestId = ++state.myListRequestId;
  if (reset) {
    state.myList.items = [];
    state.myList.nextCursor = null;
  }
  state.myList.loading = true;
  try {
    const cursor = reset ? null : state.myList.nextCursor;
    const result =
      kind === "following"
        ? await service.listMyFollowing(cursor, 20)
        : kind === "followers"
          ? await service.listMyFollowers(cursor, 20)
          : await service.listMyBookmarks(cursor, 20);
    if (requestId !== state.myListRequestId) return;
    const rows = result[kind] ?? [];
    state.myList.items = reset ? rows : [...state.myList.items, ...rows];
    state.myList.nextCursor = result.nextCursor;
    state.myList.loading = false;
  } catch (error) {
    state.myList.loading = false;
    if (reset) {
      showError("列表暂时无法加载", error.message, true);
    } else {
      showToast(error.message);
    }
    return;
  }
  if (parseRoute(window.location.hash).name === `my-${kind}`) {
    renderMyListPage(kind);
  }
}

async function renderMyListPageRoute(kind) {
  showLoading("正在整理列表");
  const meta = MY_LIST_META[kind];
  if (!state.session) {
    const shell = element("div", { className: "page-shell auth-gate" }, [
      element("p", { className: "eyebrow", text: meta.eyebrow }),
      element("h2", { text: `登录后查看${meta.title}` }),
      element("button", {
        className: "primary-button",
        type: "button",
        text: "登录",
        dataset: { action: "open-auth", returnHash: `#/my/${kind}` },
      }),
    ]);
    replaceContent(app, shell);
    return;
  }
  await loadMyListPage(kind, { reset: true });
}

function createBookmarkRow(bookmark) {
  const article = element("article", {
    className: "work-row",
    dataset: { workId: bookmark.id },
  });
  const margin = element("aside", {
    className: "work-margin",
    attrs: { "aria-label": "作品分类" },
  });
  margin.append(
    element("span", { text: normalizeCategory(bookmark.category) }),
  );
  const body = element("div", { className: "work-body" });
  const title = element("h3");
  title.append(
    element("a", {
      href: `#/works/${encodeURIComponent(bookmark.id)}`,
      text: bookmark.title,
    }),
  );
  const meta = element("div", { className: "work-meta" }, [
    element("span", {
      className: "meta-link",
      text: bookmark.author_pen_name,
    }),
    element("time", {
      text: `收藏于 ${formatDate(bookmark.created_at)}`,
      attrs: { datetime: bookmark.created_at },
    }),
  ]);
  body.append(title, meta);
  // bookmark 来自 listMyBookmarks（已过滤未发表/已删除），excerpt 为空不代表已删除；
  // 仅在确有摘录时渲染，避免把无摘录的公开作品误标为「已删除作品」。
  if (bookmark.excerpt) {
    body.append(
      element("p", {
        className: "work-excerpt",
        text: bookmark.excerpt,
      }),
    );
  }
  article.append(margin, body);
  return article;
}

function renderMyListPage(kind) {
  const meta = MY_LIST_META[kind];
  const shell = element("div", { className: "page-shell" });
  shell.append(createPageHeader(meta.eyebrow, meta.title, meta.description));
  const list =
    kind === "bookmarks"
      ? element("div", { className: "author-work-list" })
      : element("ol", { className: "member-list" });
  if (kind === "bookmarks") {
    state.myList.items.forEach((bookmark) =>
      list.append(createBookmarkRow(bookmark)),
    );
  } else {
    state.myList.items.forEach((member) => {
      const row = element("li", { className: "member-row" });
      row.append(
        element("a", {
          className: "member-name",
          href: `#/authors/${encodeURIComponent(member.id)}`,
          text: member.pen_name,
        }),
        element("p", {
          className: "member-bio",
          text: member.bio || "这位作者还没有留下简介。",
        }),
        element("time", {
          className: "member-time",
          text:
            kind === "following"
              ? `关注于 ${formatDate(member.created_at)}`
              : formatDate(member.created_at),
          attrs: { datetime: member.created_at },
        }),
      );
      list.append(row);
    });
  }
  if (!state.myList.items.length) {
    // member-list 是 ol，空态用 li；author-work-list 是 div，空态用 div。
    list.append(
      element(
        kind === "bookmarks" ? "div" : "li",
        { className: "empty-state", text: meta.empty },
      ),
    );
  }
  shell.append(list);
  if (state.myList.nextCursor) {
    shell.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "更多",
          dataset: { action: "load-more-my-list", myListKind: kind },
        }),
      ]),
    );
  }
  replaceContent(app, shell);
}
```

- [ ] **Step 9: 路由分发、点击分发与登录后角标刷新**

在 `renderCurrentRoute` 中 `updateHeader();` 之后加入 `refreshNotificationBadge();`，并在 `route.name === "submissions"` 分支之后、`else renderNotFound();` 之前加入：

```js
    else if (route.name === "notifications") await renderNotifications();
    else if (route.name === "my-following") await renderMyListPageRoute("following");
    else if (route.name === "my-followers") await renderMyListPageRoute("followers");
    else if (route.name === "my-bookmarks") await renderMyListPageRoute("bookmarks");
```

在点击分发器的 `load-more-discussions` 分支之后加入：

```js
  } else if (action === "open-notification") {
    await handleOpenNotification(trigger);
  } else if (action === "mark-all-notifications-read") {
    await handleMarkAllNotificationsRead();
  } else if (action === "load-more-notifications") {
    if (state.notifications.loading) return;
    loadNotificationsPage({ reset: false });
  } else if (action === "load-more-my-list") {
    if (state.myList.loading) return;
    loadMyListPage(trigger.dataset.myListKind, { reset: false });
  }
```

在 `handleAuthSubmit` 中 `updateHeader();` 之后加入 `await refreshNotificationBadge();`。

- [ ] **Step 10: 通知与成员列表样式**

在 `assets/styles.css` 的 `.discussion-row blockquote` 规则之后追加：

```css
.notification-head {
  grid-template-columns: minmax(0, 1fr) auto;
}

.notification-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notification-item {
  border-top: 1px solid var(--rule);
}

.notification-item:last-child {
  border-bottom: 1px solid var(--rule);
}

.notification-item.unread .notification-row {
  background: rgb(140 47 43 / 6%);
}

.notification-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  width: 100%;
  padding: 1.4rem 0.5rem;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.notification-row:hover {
  color: var(--vermilion);
}

.notification-item.unread .notification-text {
  font-weight: 600;
}

.notification-text {
  color: var(--ink);
}

.notification-time {
  flex: 0 0 auto;
  color: var(--soft-ink);
  font-family: var(--utility);
  font-size: 0.72rem;
}

.member-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.member-row {
  padding: 1.8rem 0;
  border-top: 1px solid var(--rule);
}

.member-row:last-child {
  border-bottom: 1px solid var(--rule);
}

.member-name {
  display: inline-block;
  margin-bottom: 0.4rem;
  font-family: var(--serif-title);
  font-size: 1.25rem;
  color: var(--ink);
  text-decoration: none;
}

.member-name:hover {
  color: var(--vermilion);
}

.member-bio {
  margin: 0 0 0.4rem;
  color: var(--soft-ink);
}

.member-time {
  color: var(--soft-ink);
  font-family: var(--utility);
  font-size: 0.72rem;
}
```

- [ ] **Step 11: 运行静态断言确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: `pass 33 / fail 0`。

- [ ] **Step 12: 前端相关单测子集**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs tests/social-notifications-service.test.mjs tests/social-notifications-supabase.test.mjs tests/static-checks.mjs`
Expected: `pass 118 / fail 0`。

- [ ] **Step 13: 语法检查**

Run: `node --check js/app.js`
Expected: 无输出（通过）。

- [ ] **Step 14: 浏览器回归**

先修复 `tests/browser-check.cjs` 中移动底栏的过期断言：Task 8 已把移动底栏扩展为 5 项（加入「消息」），但 browser-check 第 749-753 行仍断言 4 项。把该处断言更新为 5 项。注意「消息」链接在 index.html 中为多行缩进，其 `textContent` 含空白，须先 `.trim()`（与文件既有 216/379 行的空白归一用法一致）：

```js
  assert.deepEqual(
    (await bottomLinks.allTextContents()).map((text) => text.trim()),
    ["翻阅", "讨论", "写作", "消息", "我的"],
  );
  assert.deepEqual(
    await bottomLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    ["#/", "#/discussions", "#/write", "#/notifications", "#/"],
  );
```

（与 Task 8 在 `tests/static-checks.mjs` 中新增的 5 项移动底栏断言一致；browser-check 在本任务前即失败，属 Task 8 引入的过期断言，本步一并修复。）

然后启动静态服务器（如未运行）：`node tests/static-server.cjs 4173 > /tmp/wenyuan-server.log 2>&1 &`
Run: `node tests/browser-check.cjs`
Expected: `Browser checks passed: desktop and mobile flows verified.`（既有双流无回归；通知/我的页的端到端社交流程在 Task 11 固化进 browser-check）。

- [ ] **Step 15: 提交**

```bash
git add js/app.js assets/styles.css tests/static-checks.mjs
git commit -m "feat: notification page, my lists (following/followers/bookmarks), unread badge"
```

### Task 11: 浏览器检查 — 私密社交与通知 demo 全流程

**Files:**
- Modify: `tests/browser-check.cjs`（新增 `socialFlow` 全流程 + 主入口接入）
- Modify: `tests/static-checks.mjs`（新增「浏览器检查固化私密社交 demo 全流程」断言）

本任务把发布四的社交 UI 全流程固化进 browser-check：登录松声 → 未读角标 2 → 通知页 3 条/2 未读/聚合文案/全部已读按钮 → 点击首条标记已读并跳转作品页 → 返回后 1 未读/角标 1 → 全部已读/角标隐藏 → 作品页评论点赞切换（已赞 1 → 赞 0 → 已赞 1）→ 白露作品页收藏/关注作者已激活 → 作者页公开粉丝数与关注按钮 → 我的关注/收藏页 → 退出登录后通知页登录门/角标隐藏。桌面视口下移动底栏 `display:none`，未读角标以 DOM 状态（`hidden` + `textContent`）断言。由 browser-check 双流 + socialFlow 全绿 + static-checks 34 条验证。

- [ ] **Step 1: 写失败静态断言**

在 `tests/static-checks.mjs` 的「浏览器检查保留预览断言但不写入内部导出预览截图」测试之后追加：

```js
test("浏览器检查固化私密社交 demo 全流程", async () => {
  const browserCheck = await readFile(
    new URL("./browser-check.cjs", import.meta.url),
    "utf8",
  );
  assert.match(browserCheck, /async function socialFlow/);
  assert.match(browserCheck, /#\/notifications/);
  assert.match(browserCheck, /comment-like-button/);
  assert.match(browserCheck, /member-list/);
  assert.match(browserCheck, /未读角标应为 2/);
});
```

- [ ] **Step 2: 运行静态断言确认失败**

Run: `node --test tests/static-checks.mjs`
Expected: 新增测试 FAIL（browser-check.cjs 尚无 `socialFlow`），总数 34 个测试中 1 个失败。

- [ ] **Step 3: 实现 socialFlow**

在 `tests/browser-check.cjs` 的 `accountSecurityFlow` 之后（主入口之前）追加：

```js
// 桌面视口下移动端底栏 display:none，未读角标以 DOM 状态（hidden + textContent）断言
async function socialBadgeState(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#notificationsNavBadge");
    return { hidden: el.hidden, text: el.textContent.trim() };
  });
}

async function socialFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`social console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`social pageerror: ${error.message}`);
  });

  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");

  // 登录松声：2 条未读（notif-1/notif-2），未读角标显示 2
  await login(page, "2023123456", "wenyuan88");
  let badge = await socialBadgeState(page);
  if (badge.hidden || badge.text !== "2") {
    throw new Error(`未读角标应为 2，实际 ${badge.text}`);
  }

  // 通知页：3 条、2 条未读、聚合文案正确、全部已读按钮存在
  await goToHash(page, "#/notifications", "消息");
  if ((await page.locator(".notification-item").count()) !== 3) {
    throw new Error("通知页应有 3 条");
  }
  if ((await page.locator(".notification-item.unread").count()) !== 2) {
    throw new Error("通知页未读高亮条数错误");
  }
  const firstText = await page
    .locator(".notification-item .notification-text")
    .first()
    .textContent();
  if (!firstText.includes("白露 评论了你的作品")) {
    throw new Error(`通知文案错误：${firstText}`);
  }
  await expectVisible(
    page.getByRole("button", { name: "全部已读" }),
    "全部已读按钮",
  );

  // 点击第一条通知 → 标记已读 + 跳转作品页；返回后未读减 1，角标变 1
  await page.locator(".notification-row").first().click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  await page.locator(".reading-title h1").waitFor();
  await goToHash(page, "#/notifications", "消息");
  if ((await page.locator(".notification-item.unread").count()) !== 1) {
    throw new Error("点击通知后未读条数没有减少");
  }
  badge = await socialBadgeState(page);
  if (badge.hidden || badge.text !== "1") {
    throw new Error(`标记一条已读后角标应为 1，实际 ${badge.text}`);
  }

  // 全部已读 → 无未读高亮、角标隐藏
  await page.getByRole("button", { name: "全部已读" }).click();
  if ((await page.locator(".notification-item.unread").count()) !== 0) {
    throw new Error("全部已读后仍有未读高亮");
  }
  badge = await socialBadgeState(page);
  if (!badge.hidden) {
    throw new Error("全部已读后角标仍显示");
  }

  // 作品页评论点赞：comment-1 已赞 1（松声赞了白露的评论）；comment-2 赞 1 且是松声自己的回复，
  // self-like 会被数据层拒绝、保持 赞 1，因此切换用 comment-1：取消赞 → 赞 0，再点恢复 → 已赞 1。
  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区");
  const likeButtons = page.locator(".comment-like-button");
  if ((await likeButtons.count()) < 2) {
    throw new Error("评论行没有渲染点赞按钮");
  }
  const firstLike = likeButtons.nth(0);
  if (!/^已赞 1$/.test(await firstLike.textContent())) {
    throw new Error(`第一条评论点赞状态错误：${await firstLike.textContent()}`);
  }
  if (!/^赞 1$/.test(await likeButtons.nth(1).textContent())) {
    throw new Error(`第二条评论点赞状态错误：${await likeButtons.nth(1).textContent()}`);
  }
  await firstLike.click();
  await page.waitForFunction(
    () => document.querySelectorAll(".comment-like-button")[0]?.textContent === "赞 0",
  );
  await firstLike.click();
  await page.waitForFunction(
    () => document.querySelectorAll(".comment-like-button")[0]?.textContent === "已赞 1",
  );

  // 白露作品页：收藏已收藏 2、关注作者已关注 2
  await goToHash(page, "#/works/work-river", "河流向北");
  await expectVisible(
    page.getByRole("button", { name: /取消收藏/ }),
    "收藏按钮",
  );
  const bookmarkLabel = await page.locator("[data-bookmark-label]").textContent();
  const bookmarkCount = await page.locator("[data-bookmark-count]").textContent();
  if (bookmarkLabel !== "已收藏" || bookmarkCount !== "2") {
    throw new Error(`收藏状态错误：${bookmarkLabel} ${bookmarkCount}`);
  }
  await expectVisible(
    page.getByRole("button", { name: /取消关注作者/ }),
    "关注作者按钮",
  );
  const followLabel = await page.locator("[data-follow-label]").textContent();
  const followCount = await page.locator("[data-follow-count]").textContent();
  if (followLabel !== "已关注" || followCount !== "2") {
    throw new Error(`关注状态错误：${followLabel} ${followCount}`);
  }

  // 作者页：白露展示公开粉丝数，关注按钮存在
  await goToHash(page, "#/authors/profile-dew", "白露");
  const stats = await page.locator(".profile-stats").innerText();
  if (!stats.includes("粉丝") || !stats.includes("2")) {
    throw new Error(`作者页没有展示粉丝数：${stats}`);
  }
  await expectVisible(
    page.getByRole("button", { name: /取消关注/ }),
    "作者页关注按钮",
  );

  // 我的关注 / 我的收藏页
  await goToHash(page, "#/my/following", "我关注的人");
  await expectVisible(page.locator(".member-list"), "关注列表");
  await goToHash(page, "#/my/bookmarks", "我的收藏");
  await expectVisible(page.locator(".work-row"), "收藏列表");

  // 未登录访问通知页 → 登录门，角标隐藏
  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await goToHash(page, "#/notifications", "登录后查看消息");
  badge = await socialBadgeState(page);
  if (!badge.hidden) {
    throw new Error("未登录时消息角标仍显示");
  }

  await context.close();
}
```

- [ ] **Step 4: 主入口接入**

在主入口 `(async () => {...})()` 中 `accountSecurityFlow` 之后加入：

```js
    await accountSecurityFlow(browser, browserMessages);
    await socialFlow(browser, browserMessages);
```

- [ ] **Step 5: 运行浏览器检查**

先启动静态服务器（如未运行）：`node tests/static-server.cjs 4173 > /tmp/wenyuan-server.log 2>&1 &`
Run: `node tests/browser-check.cjs`
Expected: `Browser checks passed: desktop and mobile flows verified.`（desktop + mobile + mobileProfileAuth + accountSecurity + social 全绿）。

- [ ] **Step 6: 运行静态断言确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: `pass 34 / fail 0`。

- [ ] **Step 7: 语法检查**

Run: `node --check tests/browser-check.cjs`
Expected: 无输出（通过）。

- [ ] **Step 8: 提交**

```bash
git add tests/browser-check.cjs tests/static-checks.mjs
git commit -m "test: browser-check social flow — notifications, my lists, comment likes, bookmark/follow"
```

### Task 12: 全量回归 + 社交通知迁移并入 schema.sql + 收尾

**Files:**
- Modify: `supabase/schema.sql`（末尾并入 `-- SOCIAL_NOTIFICATIONS_START`…`-- SOCIAL_NOTIFICATIONS_END` 块）
- Modify: `tests/works-versions-db.test.mjs`（增量模式一并剥除 SOCIAL 块）
- Modify: `tests/account-recovery-db.test.mjs`（增量模式一并剥除 SOCIAL 块）
- Modify: `tests/static-checks.mjs`（新增「schema 的社交通知块与迁移同时存在」断言）
- Modify: `index.html`（Step 5a 两处未读角标补 role="status"）
- Modify: `js/app.js`（Step 5b 通知/我的列表加载失败路径补 requestId 守卫）
- Modify: `assets/styles.css`（Step 5c 成员列表空态去 border-top）
- （无删除：`tests/scratch-social-flow.cjs` 不存在，Step 8 为确认性 no-op）

本任务收尾：把 `supabase/migrations/20260810_social_and_notifications.sql` 整体并入 schema.sql（迁移文件本身已带 START/END 标记、幂等 DDL、无 begin/commit，与 VERSIONS_QUOTES 块同构）。因社交块 RPC 依赖 `work_versions`/`comment_quotes`（VERSIONS 块）与 `is_account_write_allowed()`（ACCOUNT 块），`works-versions-db` 与 `account-recovery-db` 的增量模式需一并剥除 SOCIAL 块（与既有剥除 BROWSE/VERSIONS/ACCOUNT 块模式一致）；`social-notifications-db` 保持 schema + 迁移双载，验证并入后幂等。规划期临时脚本无需清理（`tests/scratch-social-flow.cjs` 不存在，社交流程已固化进 Task 11 的 browser-check）。另并入发布四评审遗留的三项前端 Minor（Step 5a 导航角标 role="status"、Step 5b 通知/我的列表加载失败路径 requestId 守卫、Step 5c 成员列表空态边框），由 Step 9 全量回归统一覆盖。最终以 `npm test` 全绿（303 单测/DB/静态 + browser-check 双流 + 社交全流程）收尾。

- [ ] **Step 1: 写失败静态断言**

在 `tests/static-checks.mjs` 的「schema 的版本批注块与迁移同时存在」测试之后追加：

```js
test("schema 的社交通知块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- SOCIAL_NOTIFICATIONS_START/);
  assert.match(schema, /-- SOCIAL_NOTIFICATIONS_END/);
  assert.match(schema, /create table if not exists public\.follows/i);
  assert.match(schema, /create table if not exists public\.notifications/i);
});
```

- [ ] **Step 2: 运行静态断言确认失败**

Run: `node --test tests/static-checks.mjs`
Expected: 新增测试 FAIL（schema.sql 尚未并入 SOCIAL 块），总数 35 个测试中 1 个失败。

- [ ] **Step 3: 并入社交通知迁移到 schema.sql**

将迁移文件内容追加到 schema.sql 末尾（迁移文件自带 `-- SOCIAL_NOTIFICATIONS_START` 头与 `-- SOCIAL_NOTIFICATIONS_END` 尾、全部 DDL 幂等且无事务包裹）：

```bash
printf '\n' >> supabase/schema.sql
cat supabase/migrations/20260810_social_and_notifications.sql >> supabase/schema.sql
```

Expected: schema.sql 末尾以 `-- SOCIAL_NOTIFICATIONS_END` 收尾。

- [ ] **Step 4: 更新 works-versions-db 增量模式**

在 `tests/works-versions-db.test.mjs` 的块常量区追加：

```js
const SOCIAL_START = "-- SOCIAL_NOTIFICATIONS_START";
const SOCIAL_END = "-- SOCIAL_NOTIFICATIONS_END";
```

把 `createDatabase` 中的剥除链替换为：

```js
  const schema = stripBlock(
    stripBlock(
      stripBlock(await readFile(schemaUrl, "utf8"), BROWSE_START, BROWSE_END),
      VERSIONS_START,
      VERSIONS_END,
    ),
    SOCIAL_START,
    SOCIAL_END,
  );
```

原因：该测试单独加载 versions 迁移，而社交块 RPC 引用 `work_versions`/`comment_quotes`，若不剥除会在 versions 迁移加载前因类型不存在而解析失败。

- [ ] **Step 5: 更新 account-recovery-db 增量模式**

在 `tests/account-recovery-db.test.mjs` 的块常量区追加：

```js
const SOCIAL_BLOCK_START = "-- SOCIAL_NOTIFICATIONS_START";
const SOCIAL_BLOCK_END = "-- SOCIAL_NOTIFICATIONS_END";
```

把 `withoutAccountSecurityBlock` 替换为（剥除 ACCOUNT 块后再剥除 SOCIAL 块）：

```js
function withoutAccountSecurityBlock(sql) {
  const start = sql.indexOf(SECURITY_BLOCK_START);
  if (start === -1) return sql;
  const end = sql.indexOf(SECURITY_BLOCK_END, start);
  if (end === -1) {
    throw new Error("fresh schema account-security block is not closed");
  }
  const after = sql.slice(
    end + SECURITY_BLOCK_END.length,
  );
  // 社交通知迁移经自身测试单独加载，增量模式跳过 SOCIAL 块以避免
  // 其 RPC 依赖的 work_versions/comment_quotes 与 is_account_write_allowed 出现缺口。
  const socialStart = after.indexOf(SOCIAL_BLOCK_START);
  if (socialStart !== -1) {
    const socialEnd = after.indexOf(SOCIAL_BLOCK_END, socialStart);
    if (socialEnd !== -1) {
      return (
        sql.slice(0, start) +
        after.slice(0, socialStart) +
        after.slice(socialEnd + SOCIAL_BLOCK_END.length)
      );
    }
  }
  return sql.slice(0, start) + after;
}
```

- [ ] **Step 5a: 修复导航角标可访问性（Task 8 评审 Minor #4 遗留）**

给 `index.html` 两处未读角标补 `role="status"`（屏幕阅读器可播报未读数变化）：

- `index.html` 第 63 行：`<span class="nav-badge" id="menuNotificationsBadge" hidden></span>` → `<span class="nav-badge" id="menuNotificationsBadge" role="status" hidden></span>`
- `index.html` 第 88 行：`<span class="nav-badge" id="notificationsNavBadge" hidden></span>` → `<span class="nav-badge" id="notificationsNavBadge" role="status" hidden></span>`

- [ ] **Step 5b: 通知/我的列表加载失败路径补 requestId 守卫（Task 10 评审 Minor 遗留）**

`loadDiscussionsPage` 的 catch 已有 `if (requestId !== state.discussionRequestId) return;`（app.js:2692），而 `loadNotificationsPage` 与 `loadMyListPage` 的 catch 缺失该守卫，较慢的失败响应可能覆盖更新的请求。在 `js/app.js` 两处 catch 块首行补守卫（与 2692 行模式一致）：

- `loadNotificationsPage` catch（app.js:2892，紧接 `} catch (error) {` 之后）插入 `if (requestId !== state.notificationsRequestId) return;`
- `loadMyListPage` catch（app.js:3090，紧接 `} catch (error) {` 之后）插入 `if (requestId !== state.myListRequestId) return;`

- [ ] **Step 5c: 修正成员列表空态边框（评审 Minor 遗留，纯样式）**

`#/my/following`、`#/my/followers` 空列表时渲染 `<li class="empty-state">`（app.js:3204-3210），`.empty-state` 通用规则（styles.css:738-744）带 `border-top: 1px solid var(--rule)`，在 `ol.member-list`（margin/padding/list-style 均重置）内呈游离分隔线。在 `assets/styles.css` 的 `.member-list` 规则（styles.css:1615-1619）之后追加：

```css
.member-list .empty-state {
  border-top: none;
}
```

- [ ] **Step 6: 运行 DB 测试子集确认通过**

Run: `node --test tests/works-versions-db.test.mjs tests/account-recovery-db.test.mjs tests/social-notifications-db.test.mjs tests/works-browse-db.test.mjs tests/schema.test.mjs`
Expected: `pass 78 / fail 0`。

- [ ] **Step 7: 运行静态断言确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: `pass 35 / fail 0`。

- [ ] **Step 8: 确认规划期临时脚本无需清理**

仓库中不存在 `tests/scratch-social-flow.cjs`（该文件从未创建/提交，社交流程已由 Task 11 的 browser-check 固化），此步为确认性 no-op，不做删除。根目录下未跟踪的 `scratch-*.mjs`/`scratch-social-migration.sql` 不在任何提交内，保持原样，最终交付时向用户提示。

Run: `ls tests/scratch-social-flow.cjs`
Expected: 文件不存在（`No such file or directory`）。

- [ ] **Step 9: 全量回归**

先启动静态服务器（如未运行）：`node tests/static-server.cjs 4173 > /tmp/wenyuan-server.log 2>&1 &`
Run: `npm test`
Expected: `ℹ tests 303 / ℹ pass 303 / ℹ fail 0` 且 `Browser checks passed: desktop and mobile flows verified.`（Task 12 前基线 302，新增 1 条静态断言后为 303）。

- [ ] **Step 10: 语法检查**

Run: `node --check tests/works-versions-db.test.mjs && node --check tests/account-recovery-db.test.mjs`
Expected: 无输出（通过）。

- [ ] **Step 11: 提交**

```bash
git add supabase/schema.sql tests/works-versions-db.test.mjs tests/account-recovery-db.test.mjs tests/static-checks.mjs
git commit -m "chore: merge social notifications migration into schema, keep block-stripping tests green"
```

- [ ] **Step 12: 提交评审遗留 Minor 修复**

```bash
git add index.html js/app.js assets/styles.css
git commit -m "fix: closing review minors — nav badge role, notification/my-list catch guards, member-list empty border"
```

