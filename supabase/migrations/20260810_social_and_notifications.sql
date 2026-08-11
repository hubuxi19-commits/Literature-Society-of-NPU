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
      || (select coalesce(array_agg(u), '{}') from unnest(v_row.actor_ids) u limit 2),
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
