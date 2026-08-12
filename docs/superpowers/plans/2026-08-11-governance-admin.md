# 发布5 治理与管理员编辑能力 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文苑平台增加举报、管理员处置与审计、作品推荐理由/编辑点评/优质评论推荐，以及投稿引导清单与整站视觉无障碍复核。

**Architecture:** 数据库新增 4 张治理表（`work_editorial_notes`/`comment_highlights`/`reports`/`moderation_actions`）与受保护 RPC，复用发布4 的 `is_account_write_allowed()`、`is_admin()`、`upsert_notification` 通知聚合；前端新增 `#/admin` 管理员处置台（四页签）、三处举报入口与举报对话框、作品页编辑展示与管理员就地编辑、写作页投稿引导清单。通知表扩展 `payload` 列承载处置结果。整站 CSS 复核最后单独收口。

**Tech Stack:** PostgreSQL (Supabase) + SECURITY DEFINER RPC + PGlite 测试；ES modules + 原生 DOM；Node test runner + Playwright。工作目录 `C:\Users\legion\Documents\Codex\2026-08-02\qin\work\wenyuan-community-upgrade`，分支 `codex/wenyuan-community-upgrade`。

**设计依据：** `docs/superpowers/specs/2026-08-11-governance-admin-design.md`（已批准）。

---

## 全局约定（所有任务遵守）

- 提交风格沿用本仓库：`feat:` / `fix:` / `docs:` / `test:` / `chore:`。
- 截图 `screenshots/*.png` 由浏览器测试重生成，**永不提交**。
- SQL 迁移与 `schema.sql` 块必须字节一致（沿用发布4 模式）；迁移幂等（`if not exists`、`create or replace`、`drop ... if exists`），无 begin/commit 事务包裹。
- 所有写 RPC 门槛顺序：`auth.uid() is null` → `is_account_write_allowed()` →（管理操作）`is_admin()`。
- 所有新表 RLS 开启、`revoke all ... from anon, authenticated`，只经受保护 RPC 访问。
- 被举报者身份、内部说明、举报者身份绝不进公开查询/日志/通知（`moderation_outcome` 通知只含决策与动作）。
- 测试用真实行为断言（调用 RPC、查询表），不以正则检查源码为主（发布前秘密扫描除外）。

---

## Task 1: 治理迁移 SQL（表 + RLS + 通知扩展 + RPC）

**Files:**
- Create: `supabase/migrations/20260811_governance_and_admin.sql`

- [ ] **Step 1: 创建迁移文件，包含全部 DDL**

按以下完整内容创建 `supabase/migrations/20260811_governance_and_admin.sql`：

```sql
-- GOVERNANCE_ADMIN_START
-- 发布五：治理与管理员编辑能力。
-- 新表 work_editorial_notes/comment_highlights/reports/moderation_actions 全部 revoke 直接授权，
-- 仅经受保护 RPC 访问；举报者身份仅管理员可见；moderation_actions 无任何前端写策略（审计只读）。
-- 通知表扩展 payload 列承载处置结果；upsert_notification 增加可选 payload 参数。
-- 依赖：is_account_write_allowed() 来自 20260802_account_recovery_security.sql，
--       notifications/upsert_notification 来自 20260810_social_and_notifications.sql。

-- ---------- 通知表扩展：payload 列 + 新事件类型 ----------
alter table public.notifications add column if not exists payload jsonb;

alter table public.notifications drop constraint if exists notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check
  check (event_type in (
    'work_comment', 'comment_reply', 'work_like', 'follow', 'work_bookmark', 'comment_like',
    'comment_highlight', 'moderation_outcome'
  ));

-- ---------- 4 张新表 ----------
create table if not exists public.work_editorial_notes (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  note_type text not null check (note_type in ('recommendation_reason', 'editorial_note')),
  content text not null,
  admin_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_id, note_type)
);

create index if not exists work_editorial_notes_work_id_idx
  on public.work_editorial_notes (work_id);

create table if not exists public.comment_highlights (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null unique references public.comments(id) on delete cascade,
  work_id uuid not null references public.works(id) on delete cascade,
  reason text not null,
  admin_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists comment_highlights_work_id_idx
  on public.comment_highlights (work_id);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('work', 'comment', 'profile')),
  target_id uuid not null,
  reason_type text not null check (reason_type in ('violation', 'infringement', 'spam', 'other')),
  detail text,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references public.profiles(id),
  unique (reporter_id, target_type, target_id)
);

create index if not exists reports_status_idx on public.reports (status, created_at desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id);

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.reports(id) on delete set null,
  target_type text not null check (target_type in ('work', 'comment', 'profile')),
  target_id uuid not null,
  decision text not null check (decision in ('resolved', 'dismissed')),
  action_type text check (action_type in ('hide_work', 'hide_comment', 'warn_user')),
  internal_note text,
  admin_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists moderation_actions_created_idx
  on public.moderation_actions (created_at desc);

-- ---------- RLS ----------
alter table public.work_editorial_notes enable row level security;
alter table public.comment_highlights enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_actions enable row level security;

-- 防御性策略：revoke 之后本无授权，若未来误加 grant 仍受 RLS 约束（沿用发布4 模式）
drop policy if exists "work_editorial_notes_read_public" on public.work_editorial_notes;
create policy "work_editorial_notes_read_public" on public.work_editorial_notes
  for select to anon, authenticated
  using (exists (select 1 from public.works w where w.id = work_id and w.status = 'published'));

drop policy if exists "work_editorial_notes_admin_all" on public.work_editorial_notes;
create policy "work_editorial_notes_admin_all" on public.work_editorial_notes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "comment_highlights_read_public" on public.comment_highlights;
create policy "comment_highlights_read_public" on public.comment_highlights
  for select to anon, authenticated
  using (exists (
    select 1 from public.comments cm
    join public.works w on w.id = cm.work_id
    where cm.id = comment_id and w.status = 'published' and cm.is_deleted = false
  ));

drop policy if exists "comment_highlights_admin_all" on public.comment_highlights;
create policy "comment_highlights_admin_all" on public.comment_highlights
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "reports_read_own_or_admin" on public.reports;
create policy "reports_read_own_or_admin" on public.reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
  for insert to authenticated
  with check (reporter_id = auth.uid() and public.is_account_write_allowed());

drop policy if exists "moderation_actions_read_admin" on public.moderation_actions;
create policy "moderation_actions_read_admin" on public.moderation_actions
  for select to authenticated
  using (public.is_admin());

revoke all on table public.work_editorial_notes from anon, authenticated;
revoke all on table public.comment_highlights from anon, authenticated;
revoke all on table public.reports from anon, authenticated;
revoke all on table public.moderation_actions from anon, authenticated;

-- ---------- upsert_notification 扩展：可选 payload ----------
-- 先删除 5 参版本再建 6 参带默认值，避免调用歧义（PostgreSQL "function is not unique"，
-- 会破坏发布4 自身 follow_user/bookmark_work/toggle_like_work/like_comment/create_comment 等 5 参调用）。
-- 5 参调用经默认参数解析到 6 参版本（payload 为 null），行为不变。
drop function if exists public.upsert_notification(uuid, text, uuid, uuid, uuid);
create or replace function public.upsert_notification(
  p_recipient uuid,
  p_event_type text,
  p_target_work_id uuid,
  p_target_comment_id uuid,
  p_actor uuid,
  p_payload jsonb default null
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
      actor_ids, actor_count, last_event_at, is_read, agg_key, payload
    ) values (
      p_recipient, p_event_type, p_target_work_id, p_target_comment_id,
      array[p_actor], 1, now(), false, v_key, p_payload
    );
    return;
  end if;

  if p_actor = any(v_row.actor_ids) then
    update public.notifications
    set last_event_at = now(), updated_at = now(),
        payload = coalesce(p_payload, payload)
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
    updated_at = now(),
    payload = coalesce(p_payload, payload)
  where id = v_row.id;
end;
$$;

revoke all on function public.upsert_notification(uuid, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------- list_notifications 补 payload（moderation_outcome 通知需把 decision/action_type 带给前端）----------
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
      n.actor_ids, n.actor_count, n.last_event_at, n.is_read, n.payload,
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
        'payload', v_row.payload,
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

revoke all on function public.list_notifications(text, integer) from public;
grant execute on function public.list_notifications(text, integer) to authenticated;

-- ---------- 写 RPC ----------
create or replace function public.report_content(
  p_target_type text,
  p_target_id uuid,
  p_reason_type text,
  p_detail text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_detail text := btrim(coalesce(p_detail, ''));
  v_row public.reports;
  v_existing public.reports;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if p_target_type not in ('work', 'comment', 'profile') then
    raise exception '举报目标类型无效';
  end if;
  if p_reason_type not in ('violation', 'infringement', 'spam', 'other') then
    raise exception '举报类型无效';
  end if;
  if p_target_id is null then
    raise exception '举报目标不存在';
  end if;
  if char_length(v_detail) > 2000 then
    raise exception '举报说明不能超过 2000 字';
  end if;

  if p_target_type = 'work' then
    if not exists (select 1 from public.works where id = p_target_id) then
      raise exception '举报目标不存在';
    end if;
    if exists (select 1 from public.works where id = p_target_id and author_id = auth.uid()) then
      raise exception '不能举报自己的内容';
    end if;
  elsif p_target_type = 'comment' then
    if not exists (select 1 from public.comments where id = p_target_id and is_deleted = false) then
      raise exception '举报目标不存在';
    end if;
    if exists (select 1 from public.comments where id = p_target_id and user_id = auth.uid()) then
      raise exception '不能举报自己的内容';
    end if;
  elsif p_target_type = 'profile' then
    if not exists (select 1 from public.profiles where id = p_target_id) then
      raise exception '举报目标不存在';
    end if;
    if p_target_id = auth.uid() then
      raise exception '不能举报自己的内容';
    end if;
  end if;

  insert into public.reports (reporter_id, target_type, target_id, reason_type, detail)
  values (auth.uid(), p_target_type, p_target_id, p_reason_type, nullif(v_detail, ''))
  on conflict (reporter_id, target_type, target_id) do nothing
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('status', 'reported', 'report_id', v_row.id);
  end if;

  select * into v_existing
  from public.reports
  where reporter_id = auth.uid() and target_type = p_target_type and target_id = p_target_id;

  return jsonb_build_object('status', 'already_reported', 'report_id', v_existing.id);
end;
$$;

create or replace function public.moderate_report(
  p_report_id uuid,
  p_decision text,
  p_action_type text,
  p_internal_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_report public.reports;
  v_note text := btrim(coalesce(p_internal_note, ''));
  v_action_id uuid;
  v_recipient uuid;
  v_work_id uuid;
  v_comment_id uuid;
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;
  if p_decision not in ('resolved', 'dismissed') then
    raise exception '处置结果无效';
  end if;
  if p_decision = 'resolved' then
    if p_action_type not in ('hide_work', 'hide_comment', 'warn_user') then
      raise exception '请选择处置动作';
    end if;
    if char_length(v_note) < 1 then
      raise exception '请填写内部说明';
    end if;
  elsif p_action_type is not null then
    raise exception '驳回处置不应填写动作';
  end if;

  select * into v_report from public.reports where id = p_report_id;
  if v_report.id is null then
    raise exception '举报不存在';
  end if;
  if v_report.status <> 'pending' then
    raise exception '该举报已处置';
  end if;

  if p_decision = 'resolved' then
    if p_action_type = 'hide_work' then
      if v_report.target_type <> 'work' then
        raise exception '举报目标类型与动作不匹配';
      end if;
      update public.works set status = 'hidden', updated_at = now() where id = v_report.target_id;
      select author_id into v_recipient from public.works where id = v_report.target_id;
      v_work_id := v_report.target_id;
    elsif p_action_type = 'hide_comment' then
      if v_report.target_type <> 'comment' then
        raise exception '举报目标类型与动作不匹配';
      end if;
      perform public.soft_delete_comment(v_report.target_id);
      select user_id, work_id into v_recipient, v_work_id
      from public.comments where id = v_report.target_id;
      v_comment_id := v_report.target_id;
    elsif p_action_type = 'warn_user' then
      if v_report.target_type <> 'profile' then
        raise exception '举报目标类型与动作不匹配';
      end if;
      v_recipient := v_report.target_id;
    end if;
  end if;

  insert into public.moderation_actions (
    report_id, target_type, target_id, decision, action_type, internal_note, admin_id
  ) values (
    v_report.id, v_report.target_type, v_report.target_id, p_decision,
    case when p_decision = 'resolved' then p_action_type else null end,
    nullif(v_note, ''), auth.uid()
  ) returning id into v_action_id;

  update public.reports
  set status = p_decision, handled_at = now(), handled_by = auth.uid()
  where id = v_report.id;

  v_payload := jsonb_build_object(
    'decision', p_decision,
    'action_type', case when p_decision = 'resolved' then p_action_type else null end
  );
  perform public.upsert_notification(v_recipient, 'moderation_outcome', v_work_id, v_comment_id, auth.uid(), v_payload);

  return jsonb_build_object(
    'action_id', v_action_id,
    'status', p_decision,
    'action_type', case when p_decision = 'resolved' then p_action_type else null end
  );
end;
$$;

create or replace function public.set_work_editorial_note(
  p_work_id uuid,
  p_note_type text,
  p_content text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_content text := btrim(coalesce(p_content, ''));
  v_row public.work_editorial_notes;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;
  if p_note_type not in ('recommendation_reason', 'editorial_note') then
    raise exception '点评类型无效';
  end if;
  if char_length(v_content) not between 1 and 2000 then
    raise exception '点评内容必须为 1 至 2000 字';
  end if;
  if not exists (select 1 from public.works where id = p_work_id) then
    raise exception '作品不存在';
  end if;

  insert into public.work_editorial_notes (work_id, note_type, content, admin_id)
  values (p_work_id, p_note_type, v_content, auth.uid())
  on conflict (work_id, note_type) do update
    set content = excluded.content, admin_id = excluded.admin_id, updated_at = now()
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'work_id', v_row.work_id, 'note_type', v_row.note_type);
end;
$$;

create or replace function public.highlight_comment(
  p_comment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_comment public.comments;
  v_row public.comment_highlights;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;
  if char_length(v_reason) not between 1 and 500 then
    raise exception '推荐理由必须为 1 至 500 字';
  end if;

  select * into v_comment from public.comments where id = p_comment_id;
  if v_comment.id is null or v_comment.is_deleted then
    raise exception '评论不存在';
  end if;
  if not exists (
    select 1 from public.works w where w.id = v_comment.work_id and w.status = 'published'
  ) then
    raise exception '只能推荐公开作品上的评论';
  end if;

  insert into public.comment_highlights (comment_id, work_id, reason, admin_id)
  values (p_comment_id, v_comment.work_id, v_reason, auth.uid())
  on conflict (comment_id) do update
    set reason = excluded.reason, admin_id = excluded.admin_id
  returning * into v_row;

  perform public.upsert_notification(v_comment.user_id, 'comment_highlight', v_comment.work_id, p_comment_id, auth.uid());

  return jsonb_build_object('id', v_row.id, 'comment_id', v_row.comment_id);
end;
$$;

create or replace function public.unhighlight_comment(p_comment_id uuid)
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
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;
  delete from public.comment_highlights where comment_id = p_comment_id;
end;
$$;

-- ---------- 读 RPC ----------
create or replace function public.list_reports(p_status text default 'pending')
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
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;
  if p_status not in ('pending', 'resolved', 'dismissed') then
    raise exception '状态无效';
  end if;

  for v_row in
    select
      r.id, r.reporter_id, r.target_type, r.target_id, r.reason_type,
      r.detail, r.status, r.created_at, r.handled_at, r.handled_by,
      p.pen_name as reporter_pen_name,
      case r.target_type
        when 'work' then (select w.title from public.works w where w.id = r.target_id)
        when 'comment' then (select left(cm.content, 60) from public.comments cm where cm.id = r.target_id)
        else (select pr.pen_name from public.profiles pr where pr.id = r.target_id)
      end as target_preview
    from public.reports r
    join public.profiles p on p.id = r.reporter_id
    where r.status = p_status
    order by r.created_at asc
  loop
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'reporter_id', v_row.reporter_id,
      'reporter_pen_name', v_row.reporter_pen_name,
      'target_type', v_row.target_type,
      'target_id', v_row.target_id,
      'reason_type', v_row.reason_type,
      'detail', v_row.detail,
      'target_preview', v_row.target_preview,
      'created_at', v_row.created_at,
      'handled_at', v_row.handled_at,
      'handled_by', v_row.handled_by
    );
  end loop;

  return jsonb_build_object('reports', v_items);
end;
$$;

create or replace function public.list_moderation_actions()
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
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_admin() then
    raise exception '没有权限执行此操作';
  end if;

  for v_row in
    select
      ma.id, ma.report_id, ma.target_type, ma.target_id, ma.decision,
      ma.action_type, ma.internal_note, ma.created_at,
      p.pen_name as admin_pen_name,
      case ma.target_type
        when 'work' then (select w.title from public.works w where w.id = ma.target_id)
        when 'comment' then (select left(cm.content, 60) from public.comments cm where cm.id = ma.target_id)
        else (select pr.pen_name from public.profiles pr where pr.id = ma.target_id)
      end as target_preview
    from public.moderation_actions ma
    join public.profiles p on p.id = ma.admin_id
    order by ma.created_at desc
  loop
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'report_id', v_row.report_id,
      'target_type', v_row.target_type,
      'target_id', v_row.target_id,
      'decision', v_row.decision,
      'action_type', v_row.action_type,
      'internal_note', v_row.internal_note,
      'admin_pen_name', v_row.admin_pen_name,
      'target_preview', v_row.target_preview,
      'created_at', v_row.created_at
    );
  end loop;

  return jsonb_build_object('actions', v_items);
end;
$$;

create or replace function public.get_work_editorial(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_recommendation text;
  v_editorial text;
  v_admin_rec uuid;
  v_admin_ed uuid;
  v_admin_rec_name text;
  v_admin_ed_name text;
  v_updated_rec timestamptz;
  v_updated_ed timestamptz;
begin
  select * into v_work from public.works where id = p_work_id;
  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  -- 注意：必须显式处理 anon（auth.uid() is null），否则 `author_id <> null` 为 NULL，
  -- `if (NULL)` 视为假，匿名用户可读到已隐藏作品的编辑内容 → 泄密。
  if v_work.status <> 'published'
    and (auth.uid() is null or v_work.author_id <> auth.uid())
    and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  select content, admin_id, updated_at
  into v_recommendation, v_admin_rec, v_updated_rec
  from public.work_editorial_notes
  where work_id = p_work_id and note_type = 'recommendation_reason';

  select content, admin_id, updated_at
  into v_editorial, v_admin_ed, v_updated_ed
  from public.work_editorial_notes
  where work_id = p_work_id and note_type = 'editorial_note';

  select pen_name into v_admin_rec_name from public.profiles where id = v_admin_rec;
  select pen_name into v_admin_ed_name from public.profiles where id = v_admin_ed;

  return jsonb_build_object(
    'recommendation_reason', jsonb_build_object(
      'content', v_recommendation,
      'admin_pen_name', v_admin_rec_name,
      'updated_at', v_updated_rec
    ),
    'editorial_note', jsonb_build_object(
      'content', v_editorial,
      'admin_pen_name', v_admin_ed_name,
      'updated_at', v_updated_ed
    )
  );
end;
$$;

create or replace function public.get_work_highlights(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_items jsonb := '[]'::jsonb;
  v_row record;
begin
  select * into v_work from public.works where id = p_work_id;
  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  -- 注意：必须显式处理 anon（auth.uid() is null），否则 `author_id <> null` 为 NULL，
  -- `if (NULL)` 视为假，匿名用户可读到已隐藏作品的编辑内容 → 泄密。
  if v_work.status <> 'published'
    and (auth.uid() is null or v_work.author_id <> auth.uid())
    and not public.is_admin() then
    raise exception '作品不存在';
  end if;

  for v_row in
    select ch.comment_id, ch.reason, p.pen_name as admin_pen_name, ch.created_at
    from public.comment_highlights ch
    join public.profiles p on p.id = ch.admin_id
    where ch.work_id = p_work_id
    order by ch.created_at desc
  loop
    v_items := v_items || jsonb_build_object(
      'comment_id', v_row.comment_id,
      'reason', v_row.reason,
      'admin_pen_name', v_row.admin_pen_name,
      'created_at', v_row.created_at
    );
  end loop;

  return jsonb_build_object('highlights', v_items);
end;
$$;

-- ---------- 授权收口 ----------
revoke all on function public.report_content(text, uuid, text, text) from public;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;
revoke all on function public.moderate_report(uuid, text, text, text) from public;
grant execute on function public.moderate_report(uuid, text, text, text) to authenticated;
revoke all on function public.set_work_editorial_note(uuid, text, text) from public;
grant execute on function public.set_work_editorial_note(uuid, text, text) to authenticated;
revoke all on function public.highlight_comment(uuid, text) from public;
grant execute on function public.highlight_comment(uuid, text) to authenticated;
revoke all on function public.unhighlight_comment(uuid) from public;
grant execute on function public.unhighlight_comment(uuid) to authenticated;
revoke all on function public.list_reports(text) from public;
grant execute on function public.list_reports(text) to authenticated;
revoke all on function public.list_moderation_actions() from public;
grant execute on function public.list_moderation_actions() to authenticated;
revoke all on function public.get_work_editorial(uuid) from public;
grant execute on function public.get_work_editorial(uuid) to anon, authenticated;
revoke all on function public.get_work_highlights(uuid) from public;
grant execute on function public.get_work_highlights(uuid) to anon, authenticated;

-- GOVERNANCE_ADMIN_END
```

- [ ] **Step 2: 写一个最小的结构加载测试**

创建 `tests/governance-db.test.mjs`，先只放结构断言（行为测试在 Task 2 补齐）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const governanceMigrationUrl = new URL(
  "../supabase/migrations/20260811_governance_and_admin.sql",
  import.meta.url,
);

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
  await db.exec(await readFile(governanceMigrationUrl, "utf8"));
  return db;
}

test("治理四张新表结构 + RLS + revoke 直接访问", async () => {
  const db = await createDatabase();
  try {
    const { rows } = await db.query(`
      select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public'
        and c.relname in ('work_editorial_notes', 'comment_highlights', 'reports', 'moderation_actions')
      order by c.relname, a.attnum
    `);
    const byTable = {};
    for (const row of rows) byTable[row.tbl] = [...(byTable[row.tbl] ?? []), row.col];
    for (const col of ["work_id", "note_type", "content", "admin_id"]) {
      assert.ok(byTable.work_editorial_notes.includes(col), `work_editorial_notes.${col}`);
    }
    for (const col of ["comment_id", "work_id", "reason", "admin_id"]) {
      assert.ok(byTable.comment_highlights.includes(col), `comment_highlights.${col}`);
    }
    for (const col of ["reporter_id", "target_type", "target_id", "reason_type", "status"]) {
      assert.ok(byTable.reports.includes(col), `reports.${col}`);
    }
    for (const col of ["report_id", "target_type", "target_id", "decision", "action_type", "internal_note", "admin_id"]) {
      assert.ok(byTable.moderation_actions.includes(col), `moderation_actions.${col}`);
    }
    for (const tbl of ["work_editorial_notes", "comment_highlights", "reports", "moderation_actions"]) {
      const { rows: rls } = await db.query(
        `select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`, [tbl]);
      assert.equal(rls[0].relrowsecurity, true, `${tbl} RLS 开启`);
      assert.equal(
        (await db.query(`select has_table_privilege('authenticated', 'public.${tbl}', 'SELECT') as ok`)).rows[0].ok,
        false, `${tbl} authenticated SELECT 被 revoke`);
    }
    // 通知表 payload 列 + 新事件类型约束
    const { rows: payloadCol } = await db.query(`
      select count(*)::int as n from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'notifications' and a.attname = 'payload' and not a.attisdropped
    `);
    assert.equal(payloadCol[0].n, 1, "notifications.payload 列存在");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: 运行结构测试确认通过**

Run: `node --test tests/governance-db.test.mjs`
Expected: 1 passing（表结构、RLS、revoke、payload 列断言全绿）。若 20260810 迁移在 PGlite 加载失败，先确认 schema.sql 与各迁移的依赖顺序正确。

- [ ] **Step 4: 提交**

```bash
git add supabase/migrations/20260811_governance_and_admin.sql tests/governance-db.test.mjs
git commit -m "feat: add governance & admin migration (tables, RLS, RPCs)"
```

---

## Task 2: 治理数据库行为测试

**Files:**
- Modify: `tests/governance-db.test.mjs`

沿用 Task 1 的 `createDatabase`/`seed`/`asRole`/`expectError` 辅助。需要新建 `seed`（用户、作品、评论、admin 角色）与通知查询辅助。测试覆盖：

- [ ] **Step 1: 添加 seed 与辅助函数（放在结构测试之后）**

```js
const USER_A = "10000000-0000-4000-8000-000000000001"; // 松声
const USER_B = "10000000-0000-4000-8000-000000000002"; // 白露
const USER_C = "10000000-0000-4000-8000-000000000003"; // 杏雨
const ADMIN_D = "10000000-0000-4000-8000-000000000004"; // 编辑部
const WORK_1 = "20000000-0000-4000-8000-000000000001"; // 作者 A
const WORK_2 = "20000000-0000-4000-8000-000000000002"; // 作者 B
const COMMENT_1 = "30000000-0000-4000-8000-000000000001"; // B 在 WORK_1 的顶层评论

async function seed(db) {
  for (const [id, email, penName] of [
    [USER_A, "a@x.test", "松声"],
    [USER_B, "b@x.test", "白露"],
    [USER_C, "c@x.test", "杏雨"],
    [ADMIN_D, "d@x.test", "编辑部"],
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
    values ('${COMMENT_1}', '${WORK_1}', '${USER_B}', null, '评论一', now() - '3 minutes'::interval)
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
```

- [ ] **Step 2: 举报测试（幂等、自举报拒绝、未验证拒绝、目标校验）**

```js
test("举报：幂等、禁止自举报、目标不存在拒绝", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // B 举报 WORK_1（作者 A）
    const { rows: first } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload",
      ["work", WORK_1, "violation", "疑似抄袭"]);
    assert.equal(first[0].payload.status, "reported");
    // 幂等：重复举报返回 already_reported
    const { rows: again } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload",
      ["work", WORK_1, "violation", "再次"]);
    assert.equal(again[0].payload.status, "already_reported");
    // 自举报拒绝：A 举报自己的作品
    const selfError = await expectError(asRole(db, "authenticated", USER_A,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(selfError.message, /不能举报自己的内容/);
    // 目标不存在
    const missingError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4)",
      ["work", "99999999-0000-4000-8000-000000000000", "violation", "x"]));
    assert.match(missingError.message, /举报目标不存在/);
    // 未登录拒绝
    const anonError = await expectError(asRole(db, "anon", null,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(anonError.message, /请先登录/);
  } finally {
    await db.close();
  }
});

test("write_gate=enforce 未验证用户举报被拒，绑定后放行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    const rejected = await expectError(asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(rejected.message, /找回邮箱/);
    await db.exec(`
      insert into public.account_recovery_emails (user_id, email_normalized, verified_at)
      values ('${USER_B}', 'b-recovery@x.test', now())
    `);
    const { rows } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload", ["work", WORK_1, "violation", "x"]);
    assert.equal(rows[0].payload.status, "reported");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: 越权读取测试（举报者身份仅管理员可见）**

```js
test("举报越权读取：非管理员读不到他人举报，管理员可见", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "spam", "垃圾内容"]);
    // 非管理员 list_reports 被拒
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.list_reports('pending')"));
    assert.match(denied.message, /没有权限/);
    // 管理员可见举报者身份
    const { rows } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    assert.equal(rows[0].payload.reports.length, 1);
    assert.equal(rows[0].payload.reports[0].reporter_pen_name, "杏雨");
    assert.equal(rows[0].payload.reports[0].target_preview, "末班车");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 4: 处置测试（成立隐藏作品 / 驳回 / 审计 / 结果通知）**

```js
test("处置成立 hide_work：作品隐藏、浏览排除、审计记录、moderation_outcome 通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "内容违规"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    // 非管理员处置被拒
    const denied = await expectError(asRole(db, "authenticated", USER_B,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "resolved", "hide_work", "确认违规"]));
    assert.match(denied.message, /没有权限/);
    // 管理员处置成立 → hide_work
    const { rows: acted } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId, "resolved", "hide_work", "确认违规"]);
    assert.equal(acted[0].payload.status, "resolved");
    assert.equal(acted[0].payload.action_type, "hide_work");
    // 作品状态隐藏
    const { rows: work } = await db.query(
      "select status from public.works where id = $1", [WORK_1]);
    assert.equal(work[0].status, "hidden");
    // 审计记录
    const { rows: audit } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_moderation_actions() as payload");
    assert.equal(audit[0].payload.actions.length, 1);
    assert.equal(audit[0].payload.actions[0].internal_note, "确认违规");
    assert.equal(audit[0].payload.actions[0].admin_pen_name, "编辑部");
    // 被举报者收到 moderation_outcome 通知，含决策不含内部说明
    const aRows = await notificationsFor(db, USER_A);
    const outcome = aRows.find((n) => n.event_type === "moderation_outcome");
    assert.ok(outcome, "作者 A 收到处置结果通知");
    assert.equal(outcome.payload->>'decision', "resolved");
    assert.equal(outcome.payload->>'action_type', "hide_work");
    assert.ok(!(outcome.payload ? outcome.payload::text : "").includes("确认违规"), "内部说明不进入通知");
    // 重复处置被拒
    const againError = await expectError(asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "dismissed", null, "重复"]));
    assert.match(againError.message, /已处置/);
  } finally {
    await db.close();
  }
});
```

（注意：PGlite 返回的 jsonb 已是 JS 对象，上例 `outcome.payload->>'decision'` 写法在 JS 中应为 `outcome.payload.decision`。请按 PGlite 的实际返回类型调整断言：PGlite 的 jsonb 列会解析为 JS 对象，直接访问 `outcome.payload.decision` 与 `outcome.payload.action_type`，内部说明检查用 `JSON.stringify(outcome.payload)`。）

- [ ] **Step 4b: list_notifications 透传 payload 测试（防止 RPC 补丁回归）**

```js
test("list_notifications 透传 payload：moderation_outcome 含 decision/action_type", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "内容违规"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "resolved", "hide_work", "确认"]);
    // 作者 A 调用 list_notifications 应能读到 payload
    const { rows } = await asRole(db, "authenticated", USER_A,
      "select public.list_notifications() as payload");
    const n = rows[0].payload.notifications.find((x) => x.event_type === "moderation_outcome");
    assert.ok(n, "作者 A 收到处置结果通知");
    assert.equal(n.payload.decision, "resolved");
    assert.equal(n.payload.action_type, "hide_work");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 5: 处置驳回 + hide_comment + warn_user 测试**

```js
test("处置驳回与 hide_comment：不成立写审计且不隐藏，成立隐藏评论", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // 举报评论
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["comment", COMMENT_1, "spam", "广告"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    // 驳回：不填动作
    const { rows: dismissed } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId, "dismissed", null, "证据不足"]);
    assert.equal(dismissed[0].payload.status, "dismissed");
    const { rows: cm } = await db.query(
      "select is_deleted from public.comments where id = $1", [COMMENT_1]);
    assert.equal(cm[0].is_deleted, false, "驳回不隐藏评论");
    const { rows: audit } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_moderation_actions() as payload");
    assert.equal(audit[0].payload.actions[0].decision, "dismissed");
    assert.equal(audit[0].payload.actions[0].action_type, null);
    // 新举报后 hide_comment
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["comment", COMMENT_1, "violation", "违规"]);
    const { rows: list2 } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId2 = list2[0].payload.reports[0].id;
    const { rows: acted } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId2, "resolved", "hide_comment", "确认违规"]);
    assert.equal(acted[0].payload.action_type, "hide_comment");
    const { rows: cm2 } = await db.query(
      "select is_deleted from public.comments where id = $1", [COMMENT_1]);
    assert.equal(cm2[0].is_deleted, true, "hide_comment 软删评论");
    // 评论作者 B 收到处置通知
    const bRows = await notificationsFor(db, USER_B);
    assert.ok(bRows.some((n) => n.event_type === "moderation_outcome"), "评论作者收到通知");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 6: 编辑点评/推荐理由测试**

```js
test("编辑点评与推荐理由：非管理员被拒、管理员 upsert、公开可读", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.set_work_editorial_note($1, $2, $3)",
      [WORK_1, "editorial_note", "这句写得好"]));
    assert.match(denied.message, /没有权限/);
    // 管理员 upsert 推荐理由
    const { rows: rec } = await asRole(db, "authenticated", ADMIN_D,
      "select public.set_work_editorial_note($1, $2, $3) as payload",
      [WORK_1, "recommendation_reason", "本期编辑推荐"]);
    assert.equal(rec[0].payload.note_type, "recommendation_reason");
    // upsert 覆盖
    await asRole(db, "authenticated", ADMIN_D,
      "select public.set_work_editorial_note($1, $2, $3)", [WORK_1, "recommendation_reason", "新推荐语"]);
    // 公开读（anon）
    const { rows: anonEd } = await asRole(db, "anon", null,
      "select public.get_work_editorial($1) as payload", [WORK_1]);
    assert.equal(anonEd[0].payload.recommendation_reason.content, "新推荐语");
    assert.equal(anonEd[0].payload.recommendation_reason.admin_pen_name, "编辑部");
    assert.equal(anonEd[0].payload.editorial_note.content, null, "无编辑点评时 content 为 null");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 7: 优质评论测试（通知触发、非管理员拒绝、取消推荐）**

```js
test("优质评论推荐：非管理员被拒、管理员推荐触发通知、取消推荐", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.highlight_comment($1, $2)", [COMMENT_1, "值得一读"]));
    assert.match(denied.message, /没有权限/);
    const { rows: hl } = await asRole(db, "authenticated", ADMIN_D,
      "select public.highlight_comment($1, $2) as payload", [COMMENT_1, "观点清晰"]);
    assert.equal(hl[0].payload.comment_id, COMMENT_1);
    // 评论作者 B 收到 comment_highlight 通知
    const bRows = await notificationsFor(db, USER_B);
    const notif = bRows.find((n) => n.event_type === "comment_highlight");
    assert.ok(notif, "评论作者收到推荐通知");
    assert.equal(notif.target_comment_id, COMMENT_1);
    assert.deepEqual(notif.actor_ids, [ADMIN_D]);
    // 公开读 highlights
    const { rows: highlights } = await asRole(db, "anon", null,
      "select public.get_work_highlights($1) as payload", [WORK_1]);
    assert.equal(highlights[0].payload.highlights.length, 1);
    assert.equal(highlights[0].payload.highlights[0].reason, "观点清晰");
    // 取消推荐
    await asRole(db, "authenticated", ADMIN_D,
      "select public.unhighlight_comment($1)", [COMMENT_1]);
    const { rows: after } = await asRole(db, "anon", null,
      "select public.get_work_highlights($1) as payload", [WORK_1]);
    assert.equal(after[0].payload.highlights.length, 0);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 8: 迁移完整性测试（函数清单 + 授权面 + 通知约束）**

```js
test("迁移完整性：治理函数齐全 + 授权面 + moderation_actions 无写策略", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: funcs } = await db.query(`
      select proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and proname in (
          'report_content','moderate_report','set_work_editorial_note',
          'highlight_comment','unhighlight_comment','list_reports',
          'list_moderation_actions','get_work_editorial','get_work_highlights'
        )
    `);
    assert.equal(funcs.length, 9, "9 个治理函数齐全");
    // 写/管理 RPC：authenticated 可执行
    for (const [sig] of [
      ["public.report_content(text, uuid, text, text)"],
      ["public.moderate_report(uuid, text, text, text)"],
      ["public.set_work_editorial_note(uuid, text, text)"],
      ["public.highlight_comment(uuid, text)"],
      ["public.unhighlight_comment(uuid)"],
    ]) {
      assert.equal(
        (await db.query(`select has_function_privilege('authenticated', '${sig}', 'EXECUTE') as ok`)).rows[0].ok,
        true, `${sig} authenticated 可执行`);
    }
    // 公开读 RPC：anon 可执行
    for (const sig of ["public.get_work_editorial(uuid)", "public.get_work_highlights(uuid)"]) {
      assert.equal(
        (await db.query(`select has_function_privilege('anon', '${sig}', 'EXECUTE') as ok`)).rows[0].ok,
        true, `${sig} anon 可执行`);
    }
    // moderation_actions 无 update/delete 策略
    const { rows: policies } = await db.query(`
      select polname, pg_get_expr(polqual, polrelid) as qual
      from pg_policy
      where polrelid = 'public.moderation_actions'::regclass
    `);
    for (const row of policies) {
      assert.ok(!row.qual.includes("update") && !row.qual.includes("delete"),
        `moderation_actions 不应有 update/delete 策略：${row.qual}`);
    }
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 9: 运行全部治理 DB 测试**

Run: `node --test tests/governance-db.test.mjs`
Expected: 全部通过（结构 + 行为）。若 `moderate_report` 调用 `soft_delete_comment` 时报「找回邮箱」错，检查调用者 `ADMIN_D` 是否已验证——把 `ADMIN_D` 绑定找回邮箱加入 `seed`（`insert into public.account_recovery_emails ... where user_id = ADMIN_D`），或在 `write_gate` 为 warn 时无需绑定（`is_account_write_allowed` 返回 true）。

- [ ] **Step 10: 提交**

```bash
git add tests/governance-db.test.mjs
git commit -m "test: governance & admin DB behavior tests"
```

---

## Task 3: schema.sql 合并 + 静态检查

**Files:**
- Modify: `supabase/schema.sql`（追加治理块）
- Modify: `tests/static-checks.mjs`

- [ ] **Step 1: 追加治理块到 schema.sql**

把 Task 1 的迁移内容（`-- GOVERNANCE_ADMIN_START` 到 `-- GOVERNANCE_ADMIN_END` 整段，含两个标记注释）**字节一致**地追加到 `supabase/schema.sql` 文件末尾。

- [ ] **Step 2: 校验字节一致**

Run:
```bash
node -e "const a=require('fs').readFileSync('supabase/schema.sql','utf8');const b=require('fs').readFileSync('supabase/migrations/20260811_governance_and_admin.sql','utf8');const start=a.indexOf('-- GOVERNANCE_ADMIN_START');const end=a.indexOf('-- GOVERNANCE_ADMIN_END')+'-- GOVERNANCE_ADMIN_END'.length;const block=a.slice(start,end);if(block!==b.trim()){console.error('治理块与迁移不一致');process.exit(1)}console.log('OK: 治理块与迁移字节一致')"
```
Expected: `OK: 治理块与迁移字节一致`

- [ ] **Step 3: 添加静态检查断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("schema 的治理块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- GOVERNANCE_ADMIN_START/);
  assert.match(schema, /-- GOVERNANCE_ADMIN_END/);
  assert.match(schema, /create table if not exists public\.reports/i);
  assert.match(schema, /create table if not exists public\.moderation_actions/i);
});
```

- [ ] **Step 4: 运行静态 + schema 测试**

Run: `node --test tests/static-checks.mjs tests/schema.test.mjs tests/governance-db.test.mjs`
Expected: 全部通过（含 schema.sql 双载幂等——schema.test.mjs 若存在双载验证会加载含治理块的新 schema）。

- [ ] **Step 5: 提交**

```bash
git add supabase/schema.sql tests/static-checks.mjs
git commit -m "chore: merge governance migration into schema, keep static checks green"
```

---

## Task 4: 演示服务层治理实现

**Files:**
- Modify: `js/data-service.mjs`（demo service）

- [ ] **Step 1: 初始化演示治理状态**

在 `createDemoService` 的 state 初始化处（`state.notifications` 之后）追加：

```js
state.reports = state.reports ?? [];
state.moderationActions = state.moderationActions ?? [];
state.editorialNotes = state.editorialNotes ?? []; // { work_id, note_type, content, admin_id, updated_at }
state.commentHighlights = state.commentHighlights ?? []; // { comment_id, work_id, reason, admin_id, created_at }
```

- [ ] **Step 2: 在 demo service 对象内新增治理方法**

在 demo service 的 `getCommentLikeState` 方法之后新增：

```js
    async reportContent(targetType, targetId, reasonType, detail) {
      const current = requireVerifiedSession();
      if (!["work", "comment", "profile"].includes(targetType)) {
        throw new Error("举报目标类型无效");
      }
      if (!["violation", "infringement", "spam", "other"].includes(reasonType)) {
        throw new Error("举报类型无效");
      }
      if (String(detail ?? "").trim().length > 2000) {
        throw new Error("举报说明不能超过 2000 字");
      }
      const existing = state.reports.find(
        (r) => r.reporter_id === current.profile.id &&
          r.target_type === targetType && r.target_id === targetId,
      );
      if (existing) return { status: "already_reported", report_id: existing.id };
      if (targetType === "work") {
        const work = state.works.find((w) => w.id === targetId);
        if (!work) throw new Error("举报目标不存在");
        if (work.author_id === current.profile.id) throw new Error("不能举报自己的内容");
      } else if (targetType === "comment") {
        const comment = state.comments.find((c) => c.id === targetId && !c.is_deleted);
        if (!comment) throw new Error("举报目标不存在");
        if (comment.user_id === current.profile.id) throw new Error("不能举报自己的内容");
      } else if (targetType === "profile") {
        const profile = state.profiles.find((p) => p.id === targetId);
        if (!profile) throw new Error("举报目标不存在");
        if (profile.id === current.profile.id) throw new Error("不能举报自己的内容");
      }
      const report = {
        id: makeId("report"),
        reporter_id: current.profile.id,
        target_type: targetType,
        target_id: targetId,
        reason_type: reasonType,
        detail: String(detail ?? "").trim() || null,
        status: "pending",
        created_at: now().toISOString(),
        handled_at: null,
        handled_by: null,
      };
      state.reports.push(report);
      return { status: "reported", report_id: report.id };
    },

    async moderateReport(reportId, decision, actionType, internalNote) {
      requireVerifiedSession();
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      if (!["resolved", "dismissed"].includes(decision)) throw new Error("处置结果无效");
      if (decision === "resolved" && !["hide_work", "hide_comment", "warn_user"].includes(actionType)) {
        throw new Error("请选择处置动作");
      }
      if (decision === "resolved" && !String(internalNote ?? "").trim()) {
        throw new Error("请填写内部说明");
      }
      if (decision === "dismissed" && actionType) throw new Error("驳回处置不应填写动作");
      const report = state.reports.find((r) => r.id === reportId);
      if (!report) throw new Error("举报不存在");
      if (report.status !== "pending") throw new Error("该举报已处置");

      if (decision === "resolved") {
        if (actionType === "hide_work") {
          const work = state.works.find((w) => w.id === report.target_id);
          if (work) work.status = "hidden";
        } else if (actionType === "hide_comment") {
          const comment = state.comments.find((c) => c.id === report.target_id);
          if (comment) comment.is_deleted = true;
        }
      }
      const action = {
        id: makeId("action"),
        report_id: report.id,
        target_type: report.target_type,
        target_id: report.target_id,
        decision,
        action_type: decision === "resolved" ? actionType : null,
        internal_note: String(internalNote ?? "").trim() || null,
        admin_id: session.profile.id,
        created_at: now().toISOString(),
      };
      state.moderationActions.unshift(action);
      report.status = decision;
      report.handled_at = now().toISOString();
      report.handled_by = session.profile.id;

      // 通知被举报者（不含内部说明）
      const recipient = await this.resolveReportRecipient(report);
      if (recipient && recipient.id !== session.profile.id) {
        const payload = {
          decision,
          action_type: decision === "resolved" ? actionType : null,
        };
        state.notifications = this.pushNotification({
          user_id: recipient.id,
          event_type: "moderation_outcome",
          target_work_id: report.target_type === "work" ? report.target_id : null,
          target_comment_id: report.target_type === "comment" ? report.target_id : null,
          actor_ids: [session.profile.id],
          actor_count: 1,
          payload,
        });
      }
      return {
        action_id: action.id,
        status: decision,
        action_type: decision === "resolved" ? actionType : null,
      };
    },

    async setWorkEditorialNote(workId, noteType, content) {
      requireVerifiedSession();
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      if (!["recommendation_reason", "editorial_note"].includes(noteType)) {
        throw new Error("点评类型无效");
      }
      const text = String(content ?? "").trim();
      if (!text || Array.from(text).length > 2000) throw new Error("点评内容必须为 1 至 2000 字");
      if (!state.works.some((w) => w.id === workId)) throw new Error("作品不存在");
      const existing = state.editorialNotes.find(
        (n) => n.work_id === workId && n.note_type === noteType,
      );
      if (existing) {
        existing.content = text;
        existing.admin_id = session.profile.id;
        existing.updated_at = now().toISOString();
      } else {
        state.editorialNotes.push({
          id: makeId("note"),
          work_id: workId,
          note_type: noteType,
          content: text,
          admin_id: session.profile.id,
          updated_at: now().toISOString(),
        });
      }
      return { id: existing?.id ?? "note", work_id: workId, note_type: noteType };
    },

    async highlightComment(commentId, reason) {
      requireVerifiedSession();
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      const text = String(reason ?? "").trim();
      if (!text || Array.from(text).length > 500) throw new Error("推荐理由必须为 1 至 500 字");
      const comment = state.comments.find((c) => c.id === commentId && !c.is_deleted);
      if (!comment) throw new Error("评论不存在");
      const work = state.works.find((w) => w.id === comment.work_id);
      if (!work || work.status !== "published") throw new Error("只能推荐公开作品上的评论");
      const existing = state.commentHighlights.find((h) => h.comment_id === commentId);
      if (existing) {
        existing.reason = text;
        existing.admin_id = session.profile.id;
      } else {
        state.commentHighlights.push({
          id: makeId("hl"),
          comment_id: commentId,
          work_id: comment.work_id,
          reason: text,
          admin_id: session.profile.id,
          created_at: now().toISOString(),
        });
      }
      if (comment.user_id !== session.profile.id) {
        state.notifications = this.pushNotification({
          user_id: comment.user_id,
          event_type: "comment_highlight",
          target_work_id: comment.work_id,
          target_comment_id: commentId,
          actor_ids: [session.profile.id],
          actor_count: 1,
        });
      }
      return { id: existing?.id ?? "hl", comment_id: commentId };
    },

    async unhighlightComment(commentId) {
      requireVerifiedSession();
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      state.commentHighlights = state.commentHighlights.filter(
        (h) => h.comment_id !== commentId,
      );
    },

    async listReports(status = "pending") {
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      const rows = state.reports
        .filter((r) => r.status === status)
        .map((r) => ({
          ...r,
          reporter_pen_name: getProfileRecord(r.reporter_id)?.pen_name ?? "未知",
          target_preview: this.reportTargetPreview(r),
        }));
      return { reports: rows };
    },

    async listModerationActions() {
      if (!isAdmin()) throw new Error("没有权限执行此操作");
      const rows = state.moderationActions.map((a) => ({
        ...a,
        admin_pen_name: getProfileRecord(a.admin_id)?.pen_name ?? "未知",
        target_preview: this.reportTargetPreview(a),
      }));
      return { actions: rows };
    },

    async getWorkEditorial(workId) {
      const rec = state.editorialNotes.find(
        (n) => n.work_id === workId && n.note_type === "recommendation_reason",
      );
      const ed = state.editorialNotes.find(
        (n) => n.work_id === workId && n.note_type === "editorial_note",
      );
      const toNote = (note) =>
        note
          ? { content: note.content, admin_pen_name: getProfileRecord(note.admin_id)?.pen_name ?? null, updated_at: note.updated_at }
          : { content: null, admin_pen_name: null, updated_at: null };
      return { recommendation_reason: toNote(rec), editorial_note: toNote(ed) };
    },

    async getWorkHighlights(workId) {
      const highlights = state.commentHighlights
        .filter((h) => h.work_id === workId)
        .map((h) => ({
          comment_id: h.comment_id,
          reason: h.reason,
          admin_pen_name: getProfileRecord(h.admin_id)?.pen_name ?? null,
          created_at: h.created_at,
        }));
      return { highlights };
    },
```

- [ ] **Step 3: 新增演示辅助方法**

在 demo service 对象内（上述方法附近）新增两个私有辅助（若 `this.pushNotification` 不存在则直接操作 `state.notifications` 并返回新数组）：

```js
    resolveReportRecipient(report) {
      if (report.target_type === "work") {
        const work = state.works.find((w) => w.id === report.target_id);
        return work ? getProfileRecord(work.author_id) : null;
      }
      if (report.target_type === "comment") {
        const comment = state.comments.find((c) => c.id === report.target_id);
        return comment ? getProfileRecord(comment.user_id) : null;
      }
      return getProfileRecord(report.target_id);
    },

    reportTargetPreview(report) {
      if (report.target_type === "work") {
        const work = state.works.find((w) => w.id === report.target_id);
        return work?.title ?? "";
      }
      if (report.target_type === "comment") {
        const comment = state.comments.find((c) => c.id === report.target_id);
        return comment ? Array.from(comment.content).slice(0, 60).join("") : "";
      }
      return getProfileRecord(report.target_id)?.pen_name ?? "";
    },
```

注意：demo service 现有的通知写入模式是直接 push 到 `state.notifications`（见 `upsertNotification` 私有方法）。请对照 `js/data-service.mjs` 现有 demo 通知聚合实现（约 280-340 行），把上述 `state.notifications = this.pushNotification(...)` 替换为调用现有的聚合逻辑（或直接 `state.notifications.push(...)`），保证 `agg_key`、`actor` 折叠与 SQL 一致。为演示服务测试与浏览器测试正确显示，至少保证：事件写入 `state.notifications`、含 `event_type`/`actor_ids`/`actor_count`/`payload`/`target_work_id`/`target_comment_id` 字段、`markNotificationRead` 与未读数计数能识别。

**同时修改 demo `listNotifications`（约 1030-1043 行的 map）**：当前 map 未透传 `payload`，会导致 Task 6 的 `moderation_outcome` 断言失败。在 map 返回对象中追加 `payload: item.payload ?? null`（与 SQL `list_notifications` 对齐）。

- [ ] **Step 4: 运行现有服务层测试确认无回归**

Run: `node --test tests/data-service.test.mjs tests/social-notifications-service.test.mjs`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add js/data-service.mjs
git commit -m "feat: demo service governance methods (report, moderate, editorial, highlight)"
```

---

## Task 5: Supabase 服务层治理 RPC 封装

**Files:**
- Modify: `js/data-service.mjs`（supabase service）

- [ ] **Step 1: 新增治理 RPC 方法**

在 supabase service 对象的 `getCommentLikeState` 方法之后新增：

```js
    // ---- 治理与管理员编辑（发布五）----

    async reportContent(targetType, targetId, reasonType, detail) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("report_content", {
        p_target_type: targetType,
        p_target_id: targetId,
        p_reason_type: reasonType,
        p_detail: detail ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async moderateReport(reportId, decision, actionType, internalNote) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("moderate_report", {
        p_report_id: reportId,
        p_decision: decision,
        p_action_type: actionType ?? null,
        p_internal_note: internalNote ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async setWorkEditorialNote(workId, noteType, content) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("set_work_editorial_note", {
        p_work_id: workId,
        p_note_type: noteType,
        p_content: content,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async highlightComment(commentId, reason) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("highlight_comment", {
        p_comment_id: commentId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async unhighlightComment(commentId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.rpc("unhighlight_comment", {
        p_comment_id: commentId,
      });
      if (error) throw new Error(error.message);
    },

    async listReports(status = "pending") {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_reports", {
        p_status: status,
      });
      if (error) throw new Error(error.message);
      return { reports: data?.reports ?? [] };
    },

    async listModerationActions() {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("list_moderation_actions", {});
      if (error) throw new Error(error.message);
      return { actions: data?.actions ?? [] };
    },

    async getWorkEditorial(workId) {
      const client = await getClient();
      const { data, error } = await client.rpc("get_work_editorial", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return data ?? {};
    },

    async getWorkHighlights(workId) {
      const client = await getClient();
      const { data, error } = await client.rpc("get_work_highlights", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return { highlights: data?.highlights ?? [] };
    },
```

- [ ] **Step 2: 运行现有 supabase 服务测试**

Run: `node --test tests/social-notifications-supabase.test.mjs tests/data-service.test.mjs`
Expected: 全部通过（mock 客户端不会命中新 RPC，无回归）。

- [ ] **Step 3: 提交**

```bash
git add js/data-service.mjs
git commit -m "feat: supabase service governance RPC wrappers"
```

---

## Task 6: 治理服务层测试（demo）

**Files:**
- Create: `tests/governance-service.test.mjs`

- [ ] **Step 1: 创建测试文件**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
import { demoSeed } from "../js/demo-data.mjs";

const SIGN = {
  pine: { studentNumber: "2023123456", password: "wenyuan88" }, // 松声 (member)
  editor: { studentNumber: "2023000001", password: "editor88" }, // 编辑部 (admin)
  dew: { studentNumber: "2022111111", password: "reader88" }, // 白露 (member)
};

function freshSeed() {
  const seed = structuredClone(demoSeed);
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  seed.reports = [];
  seed.moderationActions = [];
  seed.editorialNotes = [];
  seed.commentHighlights = [];
  return seed;
}

function demoService() {
  return createDataService({ mode: "demo", seed: freshSeed() });
}

const ofType = (serviceItems, eventType) =>
  serviceItems.notifications.filter((n) => n.event_type === eventType);

test("演示模式：举报往返、幂等、禁止自举报", async () => {
  const service = demoService();
  await service.signIn(SIGN.dew);
  const reported = await service.reportContent("work", "work-night-bus", "violation", "疑似抄袭");
  assert.equal(reported.status, "reported");
  const again = await service.reportContent("work", "work-night-bus", "violation", "再报");
  assert.equal(again.status, "already_reported");
  // 白露是 work-night-bus 的作者松声之外的读者；松声自举报被拒
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.reportContent("work", "work-night-bus", "violation", "x"),
    /不能举报自己的内容/,
  );
});

test("演示模式：管理员处置成立隐藏作品并写审计，作者收到处置通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.dew);
  await service.reportContent("work", "work-night-bus", "violation", "内容违规");
  const { reports } = await service.listReports("pending");
  assert.equal(reports.length, 1);
  // 非管理员处置被拒
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.moderateReport(reports[0].id, "resolved", "hide_work", "确认"),
    /没有权限/,
  );
  // 管理员处置成立
  await service.signIn(SIGN.editor);
  const acted = await service.moderateReport(reports[0].id, "resolved", "hide_work", "确认违规");
  assert.equal(acted.status, "resolved");
  assert.equal(acted.action_type, "hide_work");
  const { actions } = await service.listModerationActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].internal_note, "确认违规");
  assert.equal(actions[0].admin_pen_name, "编辑部");
  // 作品已隐藏
  const work = await service.getWork("work-night-bus");
  assert.equal(work.status, "hidden");
  // 作者松声收到处置结果通知（含决策不含内部说明）
  await service.signIn(SIGN.pine);
  const outcomes = ofType(await service.listNotifications(), "moderation_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.decision, "resolved");
  assert.equal(outcomes[0].payload.action_type, "hide_work");
  assert.ok(!JSON.stringify(outcomes[0].payload).includes("确认违规"));
});

test("演示模式：编辑点评与推荐理由——仅管理员可写，公开可读", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.setWorkEditorialNote("work-river", "editorial_note", "写得好"),
    /没有权限/,
  );
  await service.signIn(SIGN.editor);
  await service.setWorkEditorialNote("work-river", "recommendation_reason", "本期编辑推荐");
  await service.setWorkEditorialNote("work-river", "recommendation_reason", "新推荐语");
  const editorial = await service.getWorkEditorial("work-river");
  assert.equal(editorial.recommendation_reason.content, "新推荐语");
  assert.equal(editorial.recommendation_reason.admin_pen_name, "编辑部");
  assert.equal(editorial.editorial_note.content, null);
});

test("演示模式：优质评论推荐触发通知，取消推荐", async () => {
  const service = demoService();
  await service.signIn(SIGN.editor);
  await service.highlightComment("comment-1", "观点清晰");
  // 评论作者白露收到推荐通知
  await service.signIn(SIGN.dew);
  assert.equal(ofType(await service.listNotifications(), "comment_highlight").length, 1);
  const { highlights } = await service.getWorkHighlights("work-night-bus");
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].reason, "观点清晰");
  await service.signIn(SIGN.editor);
  await service.unhighlightComment("comment-1");
  assert.equal((await service.getWorkHighlights("work-night-bus")).highlights.length, 0);
});

test("演示模式：非管理员访问处置台列表被拒", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(() => service.listReports("pending"), /没有权限/);
  await assert.rejects(() => service.listModerationActions(), /没有权限/);
});
```

- [ ] **Step 2: 运行测试并修正**

Run: `node --test tests/governance-service.test.mjs`
Expected: 全部通过。若 demo `getWork` 不支持已隐藏作品读取（演示态无状态概念），把「作品已隐藏」断言改为检查 `state`——若不可行则去掉该断言并只在处置/审计/通知层面断言。

- [ ] **Step 3: 提交**

```bash
git add tests/governance-service.test.mjs
git commit -m "test: governance & admin demo service tests"
```

---

## Task 7: 路由 + 通知文案/跳转新事件

**Files:**
- Modify: `js/utils.mjs`
- Modify: `js/app.js`

- [ ] **Step 1: 扩展 buildNotificationText 处理新事件**

在 `js/utils.mjs` 的 `buildNotificationText` switch 中加入：

```js
    case "comment_highlight":
      return `${actor} 推荐了你的评论`;
    case "moderation_outcome": {
      const decision = notification?.payload?.decision;
      const actionLabel = notification?.payload?.action_type === "hide_work"
        ? "，作品已隐藏"
        : notification?.payload?.action_type === "hide_comment"
          ? "，评论已隐藏"
          : notification?.payload?.action_type === "warn_user"
            ? "，已向你发出提醒"
            : "";
      if (decision === "resolved") {
        return `管理员处理了与你相关的举报：成立${actionLabel}`;
      }
      if (decision === "dismissed") {
        return `管理员处理了与你相关的举报：不成立`;
      }
      return `管理员处理了与你相关的举报`;
    }
```

- [ ] **Step 2: parseRoute 增加 admin 路由**

在 `js/utils.mjs` 的 `parseRoute` 中（`notifications` 分支后）加入：

```js
  if (parts.length === 1 && parts[0] === "admin") {
    return { name: "admin" };
  }
```

- [ ] **Step 3: app.js 路由分发**

在 `js/app.js` 的 `renderCurrentRoute` 分派处（`else if (route.name === "notifications")` 附近）加入：

```js
    else if (route.name === "admin") renderAdmin();
```

并确认 `updateHeader` 的 data-nav 高亮逻辑无需改动（admin 页无 data-nav 导航项）。

- [ ] **Step 4: 运行路由/工具测试**

Run: `node --test tests/utils.test.mjs tests/social-notifications-service.test.mjs`
Expected: 通过。若 `utils.test.mjs` 有 `buildNotificationText` 快照断言，补充新事件断言：

```js
test("通知文案：comment_highlight 与 moderation_outcome", () => {
  assert.equal(
    buildNotificationText({ event_type: "comment_highlight", actor_pen_names: ["编辑部"], actor_count: 1 }),
    "编辑部 推荐了你的评论",
  );
  assert.equal(
    buildNotificationText({ event_type: "moderation_outcome", actor_pen_names: ["编辑部"], actor_count: 1, payload: { decision: "resolved", action_type: "hide_work" } }),
    "管理员处理了与你相关的举报：成立，作品已隐藏",
  );
  assert.equal(
    buildNotificationText({ event_type: "moderation_outcome", actor_pen_names: ["编辑部"], actor_count: 1, payload: { decision: "dismissed", action_type: null } }),
    "管理员处理了与你相关的举报：不成立",
  );
});
```

- [ ] **Step 5: 提交**

```bash
git add js/utils.mjs js/app.js tests/utils.test.mjs
git commit -m "feat: route #/admin and notification text for moderation events"
```

---

## Task 8: 管理员处置台页面（#/admin）

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: 新增 admin 页面状态**

在 `js/app.js` 的 state 定义处追加：

```js
  state.admin = {
    tab: "reports",
    reports: [],
    actions: [],
    loading: false,
    requestId: 0,
    submission: {},
  };
```

- [ ] **Step 2: 新增加载与渲染函数**

在 `renderNotifications` 附近新增（紧接 `renderMyListPageRoute` 之后）：

```js
async function loadAdminData() {
  const requestId = ++state.admin.requestId;
  state.admin.loading = true;
  try {
    const [pending, resolved, dismissed, actions] = await Promise.all([
      service.listReports("pending"),
      service.listReports("resolved"),
      service.listReports("dismissed"),
      service.listModerationActions(),
    ]);
    if (requestId !== state.admin.requestId) return;
    state.admin.reports = [
      ...pending.reports.map((r) => ({ ...r, status: "pending" })),
      ...resolved.reports.map((r) => ({ ...r, status: "resolved" })),
      ...dismissed.reports.map((r) => ({ ...r, status: "dismissed" })),
    ];
    state.admin.actions = actions.actions;
    state.admin.loading = false;
    renderAdminConsole();
  } catch (error) {
    if (requestId !== state.admin.requestId) return;
    state.admin.loading = false;
    showError("处置台暂时无法加载", error.message, true);
  }
}

function renderAdmin() {
  showLoading("正在打开处置台");
  if (!state.session) {
    const shell = element("div", { className: "page-shell auth-gate" }, [
      element("p", { className: "eyebrow", text: "ADMIN" }),
      element("h2", { text: "登录后查看管理台" }),
      element("button", {
        className: "primary-button",
        type: "button",
        text: "登录",
        dataset: { action: "open-auth", returnHash: "#/admin" },
      }),
    ]);
    replaceContent(app, shell);
    return;
  }
  if (state.session.profile.role !== "admin") {
    replaceContent(
      app,
      element("div", { className: "page-shell auth-gate" }, [
        element("p", { className: "eyebrow", text: "ADMIN" }),
        element("h2", { text: "只有管理员可以进入处置台" }),
        element("p", { text: "如果你需要帮助，请联系文学社编辑部。" }),
      ]),
    );
    return;
  }
  loadAdminData();
}

function renderAdminConsole() {
  const shell = element("div", { className: "page-shell" });
  const head = element("header", { className: "page-header" }, [
    element("div", {}, [
      element("p", { className: "eyebrow", text: "ADMIN" }),
      element("h1", { text: "管理台" }),
      element("p", { text: "处置举报、查看审计、管理编辑点评与优质评论。" }),
    ]),
  ]);
  const tabs = element("div", { className: "admin-tabs", role: "tablist" });
  const pendingCount = state.admin.reports.filter((r) => r.status === "pending").length;
  const tabDefs = [
    { id: "reports", label: `待处理举报（${pendingCount}）` },
    { id: "audit", label: "处置与审计" },
    { id: "notes", label: "编辑点评与推荐" },
    { id: "highlights", label: "优质评论" },
  ];
  tabDefs.forEach((tab) => {
    tabs.append(
      element("button", {
        className: state.admin.tab === tab.id ? "admin-tab active" : "admin-tab",
        type: "button",
        role: "tab",
        "aria-selected": String(state.admin.tab === tab.id),
        text: tab.label,
        dataset: { action: "switch-admin-tab", tab: tab.id },
      }),
    );
  });
  shell.append(head, tabs);
  const panel = element("section", { className: "admin-panel" });
  if (state.admin.tab === "reports") panel.append(renderPendingReports());
  else if (state.admin.tab === "audit") panel.append(renderAuditList());
  else if (state.admin.tab === "notes") panel.append(renderNotesDirectory());
  else panel.append(renderHighlightsList());
  shell.append(panel);
  replaceContent(app, shell);
}
```

（`element` 的属性写法沿用本文件现有 helper——`attrs`/`dataset`/`text`/`className`/`type` 等，参考 `renderNotificationsList`。）

- [ ] **Step 3: 新增四个页签渲染函数 + 处置交互**

新增：

```js
const REPORT_REASON_LABELS = {
  violation: "违规内容",
  infringement: "侵权",
  spam: "垃圾广告",
  other: "其他",
};
const ACTION_LABELS = {
  hide_work: "隐藏作品",
  hide_comment: "隐藏评论",
  warn_user: "警告账号",
};

function renderPendingReports() {
  const section = element("section");
  section.append(
    element("p", { className: "eyebrow", text: "PENDING" }),
    element("h2", { text: "待处理举报" }),
  );
  const pending = state.admin.reports.filter((r) => r.status === "pending");
  if (!pending.length) {
    section.append(
      element("p", { className: "empty-state", text: "没有待处理的举报。" }),
    );
    return section;
  }
  const list = element("ol", { className: "report-list" });
  pending.forEach((report) => {
    const item = element("li", { className: "report-item", dataset: { reportId: report.id } });
    item.append(
      element("div", { className: "report-head" }, [
        element("span", {
          className: "report-target",
          text: report.target_preview || "（无摘要）",
        }),
        element("span", { className: "report-meta", text:
          `${REPORT_REASON_LABELS[report.reason_type] ?? report.reason_type} · 举报人 ${report.reporter_pen_name}` }),
      ]),
      report.detail
        ? element("p", { className: "report-detail", text: report.detail })
        : null,
      element("time", {
        className: "report-time",
        text: formatRelativeTime(report.created_at),
        attrs: { datetime: report.created_at },
      }),
    );
    const form = element("form", {
      className: "moderate-form",
      dataset: { moderateForm: report.id },
    });
    form.append(
      element("label", {}, [
        element("span", { text: "处置结果" }),
        element("select", { name: "decision" }, [
          element("option", { value: "resolved", text: "成立（执行动作）" }),
          element("option", { value: "dismissed", text: "不成立（驳回）" }),
        ]),
      ]),
      element("label", {}, [
        element("span", { text: "动作" }),
        element("select", { name: "actionType" }, [
          element("option", { value: "", text: "选择动作" }),
          element("option", { value: "hide_work", text: "隐藏作品" }),
          element("option", { value: "hide_comment", text: "隐藏评论" }),
          element("option", { value: "warn_user", text: "警告账号" }),
        ]),
      ]),
      element("label", {}, [
        element("span", { text: "内部说明（不向被举报者展示）" }),
        element("textarea", { name: "internalNote", attrs: { maxlength: 2000, "aria-label": "内部说明" } }),
      ]),
      element("button", {
        className: "primary-button",
        type: "submit",
        text: "提交处置",
      }),
    );
    item.append(form);
    list.append(item);
  });
  section.append(list);
  return section;
}

function renderAuditList() {
  const section = element("section");
  section.append(
    element("p", { className: "eyebrow", text: "AUDIT" }),
    element("h2", { text: "处置与审计记录" }),
  );
  if (!state.admin.actions.length) {
    section.append(
      element("p", { className: "empty-state", text: "还没有处置记录。" }),
    );
    return section;
  }
  const list = element("ol", { className: "audit-list" });
  state.admin.actions.forEach((action) => {
    const decision = action.decision === "resolved" ? "成立" : "不成立";
    const actionLabel = action.action_type ? ` · ${ACTION_LABELS[action.action_type] ?? action.action_type}` : "";
    list.append(
      element("li", { className: "audit-item" }, [
        element("div", { className: "audit-head" }, [
          element("span", { text: `${decision}${actionLabel}` }),
          element("time", {
            text: formatRelativeTime(action.created_at),
            attrs: { datetime: action.created_at },
          }),
        ]),
        element("p", { text: action.target_preview || "（无摘要）" }),
        element("p", {
          className: "audit-note",
          text: `内部说明：${action.internal_note ?? "（无）"}`,
        }),
        element("p", { className: "audit-meta", text: `操作人 ${action.admin_pen_name}` }),
      ]),
    );
  });
  section.append(list);
  return section;
}

function renderNotesDirectory() {
  const section = element("section");
  section.append(
    element("p", { className: "eyebrow", text: "EDITORIAL" }),
    element("h2", { text: "编辑点评与推荐理由" }),
    element("p", { text: "在作品页就地添加或修改推荐理由与编辑点评。" }),
  );
  const noted = state.works.filter((work) =>
    state.editorialNotes?.some?.((n) => n.work_id === work.id) ?? false,
  );
  if (!noted.length) {
    section.append(
      element("p", { className: "empty-state", text: "还没有编辑点评或推荐理由。打开任意作品页添加。" }),
    );
    return section;
  }
  const list = element("ol", { className: "audit-list" });
  noted.forEach((work) => {
    list.append(
      element("li", { className: "audit-item" }, [
        element("a", { className: "inline-link", href: `#/works/${encodeURIComponent(work.id)}`, text: work.title }),
      ]),
    );
  });
  section.append(list);
  return section;
}

function renderHighlightsList() {
  const section = element("section");
  section.append(
    element("p", { className: "eyebrow", text: "HIGHLIGHTS" }),
    element("h2", { text: "优质评论" }),
  );
  const rows = [];
  state.works.forEach((work) => {
    (work.highlights ?? []).forEach((hl) => {
      rows.push({ work, highlight: hl });
    });
  });
  if (!rows.length) {
    section.append(
      element("p", { className: "empty-state", text: "还没有优质评论推荐。" }),
    );
    return section;
  }
  const list = element("ol", { className: "audit-list" });
  rows.forEach(({ work, highlight }) => {
    list.append(
      element("li", { className: "audit-item" }, [
        element("a", { className: "inline-link", href: `#/works/${encodeURIComponent(work.id)}`, text: work.title }),
        element("p", { text: highlight.reason }),
      ]),
    );
  });
  section.append(list);
  return section;
}
```

注意：`state.works` 是全站目录（发布2 保留），其条目可能不含 `highlights`/`editorialNotes`。处置台的「编辑点评」与「优质评论」目录若数据不足，可简化为仅提示「在作品页管理」的空态列表——确保页签不报错即可，完整数据展示在作品页（Task 10）。`state.editorialNotes` 演示态可省略，目录页允许空态。

- [ ] **Step 4: 事件处理器**

在全局事件委托（`handleAction` 或现有 `click` 委托）中加入 admin 动作处理。找到 `action === "retry-route"` 附近，新增：

```js
    } else if (action === "switch-admin-tab") {
      state.admin.tab = button.dataset.tab;
      renderAdminConsole();
    } else if (action === "moderate-report-submit") {
      // 表单由 submit 委托处理，见下方
    }
```

并在表单提交委托中（`commentForm`/`replyForm` 的 submit 处理附近）加入：

```js
  const moderateForm = event.target.closest("[data-moderate-form]");
  if (moderateForm) {
    event.preventDefault();
    const reportId = moderateForm.dataset.moderateForm;
    const formData = new FormData(moderateForm);
    const decision = formData.get("decision");
    const actionType = formData.get("actionType") || null;
    const internalNote = formData.get("internalNote") || null;
    try {
      await service.moderateReport(reportId, decision, actionType, internalNote);
      await loadAdminData();
      showToast("处置已提交");
    } catch (error) {
      showToast(`处置失败：${error.message}`);
    }
    return;
  }
```

- [ ] **Step 5: 运行单元与浏览器既有测试确认无回归**

Run: `node --test tests/static-checks.mjs tests/governance-service.test.mjs`
Expected: 通过（admin 页尚未接浏览器测试）。

- [ ] **Step 6: 提交**

```bash
git add js/app.js
git commit -m "feat: admin console page with reports, audit, notes, highlights tabs"
```

---

## Task 9: 举报入口三处 + 举报对话框

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`
- Modify: `assets/styles.css`

- [ ] **Step 1: 新增举报对话框**

在 `index.html` 的 `annotateDialog` 之后加入：

```html
    <dialog
      class="modal report-dialog"
      id="reportDialog"
      aria-labelledby="reportTitle"
    >
      <div class="modal-head">
        <div>
          <p class="eyebrow">REPORT</p>
          <h2 id="reportTitle">举报</h2>
        </div>
        <button
          class="close-button"
          type="button"
          data-action="close-report"
          aria-label="关闭举报窗口"
        >
          关闭
        </button>
      </div>

      <form id="reportForm" class="stack-form">
        <p class="form-message" data-report-message role="status"></p>
        <label>
          <span>举报目标</span>
          <p class="report-target-line" id="reportTargetLine"></p>
        </label>
        <label>
          <span>举报类型</span>
          <select name="reasonType" id="reportReasonType" required>
            <option value="violation">违规内容</option>
            <option value="infringement">侵权</option>
            <option value="spam">垃圾广告</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>
          <span>详细说明</span>
          <textarea
            name="detail"
            placeholder="告诉我们具体原因（选填，最多 2000 字）"
            maxlength="2000"
            rows="5"
          ></textarea>
        </label>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-report">
            取消
          </button>
          <button class="primary-button" type="submit">提交举报</button>
        </div>
      </form>
    </dialog>
```

- [ ] **Step 2: 引入对话框元素常量**

在 `js/app.js` 顶部常量区（`annotateDialog` 附近）加入：

```js
const reportDialog = document.querySelector("#reportDialog");
const reportTargetLine = document.querySelector("#reportTargetLine");
const reportReasonType = document.querySelector("#reportReasonType");
const reportFormMessage = document.querySelector("[data-report-message]");
```

- [ ] **Step 3: 新增打开/提交举报函数**

新增：

```js
let pendingReportTarget = null;

function openReportDialog(targetType, targetId, targetLabel) {
  pendingReportTarget = { targetType, targetId };
  reportTargetLine.textContent = targetLabel;
  reportReasonType.selectedIndex = 0;
  reportFormMessage.textContent = "";
  reportDialog.querySelector("textarea[name='detail']").value = "";
  if (!reportDialog.open) reportDialog.showModal();
}

async function submitReport(event) {
  event.preventDefault();
  if (!pendingReportTarget) return;
  const reasonType = reportReasonType.value;
  const detail = reportDialog.querySelector("textarea[name='detail']").value;
  try {
    const result = await service.reportContent(
      pendingReportTarget.targetType,
      pendingReportTarget.targetId,
      reasonType,
      detail,
    );
    if (result.status === "already_reported") {
      showToast("你已经举报过这个内容了。");
    } else {
      showToast("举报已提交，感谢你的反馈。");
    }
    reportDialog.close();
  } catch (error) {
    reportFormMessage.textContent = error.message;
    if (routeToAccountSecurityIfUnverified(error)) return;
  }
}
```

- [ ] **Step 4: 三个举报入口**

作品页：在 `renderWork` 的 `actionBar` 末尾追加「举报」按钮：

```js
    actionBar.append(
      element("button", {
        className: "quiet-button report-entry",
        type: "button",
        text: "举报作品",
        dataset: { action: "report", targetType: "work", targetId: work.id },
        attrs: { "aria-label": "举报这篇作品" },
      }),
    );
```

评论：在 `createCommentItem` 的 `actions` 区（`comment-like-button` 之前）追加「举报」按钮（仅未删除评论）：

```js
    if (!comment.is_deleted) {
      actions.append(
        element("button", {
          type: "button",
          text: "举报",
          dataset: {
            action: "report",
            targetType: "comment",
            targetId: comment.id,
          },
        }),
      );
    }
```

作者页：在 `renderAuthor` 的公开资料区追加「举报此用户」按钮（需确认该函数结构后插入，作者本人或当前用户时不显示）：

```js
    if (!state.session || state.session.profile.id !== profile.id) {
      authorBlock.append(
        element("button", {
          className: "quiet-button report-entry",
          type: "button",
          text: "举报此用户",
          dataset: { action: "report", targetType: "profile", targetId: profile.id },
        }),
      );
    }
```

- [ ] **Step 5: 事件委托**

在全局点击委托中加入：

```js
    } else if (action === "report") {
      if (!state.session) {
        openAuth("login", window.location.hash);
        return;
      }
      const targetLabel = reportTargetLabel(button.dataset.targetType, button.dataset.targetId);
      openReportDialog(button.dataset.targetType, button.dataset.targetId, targetLabel);
    } else if (action === "close-report") {
      if (reportDialog.open) reportDialog.close();
    }
```

并新增目标标签辅助：

```js
function reportTargetLabel(targetType, targetId) {
  if (targetType === "work") {
    const work = state.currentWork?.id === targetId
      ? state.currentWork
      : state.works.find((w) => w.id === targetId);
    return `作品：${work?.title ?? "未知"}`;
  }
  if (targetType === "comment") {
    return "评论";
  }
  const profile = state.profiles?.find?.((p) => p.id === targetId);
  return `用户：${profile?.pen_name ?? "未知"}`;
}
```

在 `reportForm` 的 submit 事件监听（模块初始化处，与 `annotateForm` 类似）：

```js
  reportForm.addEventListener("submit", submitReport);
```

（`reportForm` 常量：`const reportForm = document.querySelector("#reportForm");`，加入顶部常量区。）

- [ ] **Step 6: 样式**

在 `assets/styles.css` 末尾追加（沿用现有 modal/button 变量）：

```css
/* ---- 治理（发布五）---- */
.admin-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0; }
.admin-tab {
  appearance: none; border: 1px solid var(--ink, currentColor);
  background: transparent; color: inherit; font: inherit;
  padding: 0.4rem 0.9rem; cursor: pointer; border-radius: 2px;
}
.admin-tab.active { background: var(--ink, currentColor); color: var(--paper, #fff); }
.report-item { border-top: 1px solid currentColor; padding: 1rem 0; }
.report-head { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: space-between; }
.report-target { font-weight: 600; }
.report-meta { opacity: 0.8; font-size: 0.9em; }
.report-detail { margin: 0.5rem 0; }
.moderate-form { display: grid; gap: 0.5rem; margin-top: 0.75rem; }
.moderate-form label { display: grid; gap: 0.25rem; }
.audit-item { border-top: 1px solid currentColor; padding: 0.75rem 0; }
.audit-note { opacity: 0.85; font-size: 0.92em; }
.audit-meta { opacity: 0.7; font-size: 0.85em; }
.report-entry { font-size: 0.85em; opacity: 0.75; }
```

- [ ] **Step 7: 运行静态检查 + 服务层测试**

Run: `node --test tests/static-checks.mjs tests/governance-service.test.mjs`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add index.html js/app.js assets/styles.css
git commit -m "feat: report entries (work/comment/profile) with report dialog"
```

---

## Task 10: 作品页编辑展示 + 管理员就地编辑

**Files:**
- Modify: `js/app.js`
- Modify: `assets/styles.css`

- [ ] **Step 1: renderWork 读取编辑数据**

在 `renderWork` 的 `renderWork(workId)` 开头，把 `Promise.all` 扩展为同时取编辑数据：

```js
    const [work, quotes, editorial, highlights] = await Promise.all([
      service.getWork(workId),
      service.listWorkQuotes(workId),
      service.getWorkEditorial(workId),
      service.getWorkHighlights(workId),
    ]);
```

并把 `highlights.highlights` 存到局部 `const workHighlights = new Map(highlights.highlights.map((h) => [h.comment_id, h]));`。

- [ ] **Step 2: 渲染推荐理由横幅与编辑点评框**

在 `renderWork` 的 `shell.append` 中，`actionBar` 之后、`export-results-host` 之前插入一个编辑区块：

```js
    const editorialBlock = element("section", {
      className: "editorial-block",
      attrs: { "aria-label": "编辑点评与推荐理由" },
    });
    const rec = editorial.recommendation_reason;
    if (rec?.content) {
      editorialBlock.append(
        element("div", { className: "editorial-recommendation" }, [
          element("p", { className: "eyebrow", text: "EDITORS' PICK" }),
          element("p", { className: "editorial-text", text: rec.content }),
          element("p", {
            className: "editorial-meta",
            text: `推荐 · ${rec.admin_pen_name ?? "编辑部"} · ${formatDate(rec.updated_at)}`,
          }),
        ]),
      );
    }
    const ed = editorial.editorial_note;
    if (ed?.content) {
      editorialBlock.append(
        element("div", { className: "editorial-note" }, [
          element("p", { className: "eyebrow", text: "EDITOR'S NOTE" }),
          element("p", { className: "editorial-text", text: ed.content }),
          element("p", {
            className: "editorial-meta",
            text: `点评 · ${ed.admin_pen_name ?? "编辑部"} · ${formatDate(ed.updated_at)}`,
          }),
        ]),
      );
    }
    if (state.session?.profile?.role === "admin") {
      editorialBlock.append(
        element("div", { className: "editorial-admin-actions" }, [
          element("button", {
            className: "quiet-button",
            type: "button",
            text: rec?.content ? "修改推荐理由" : "添加推荐理由",
            dataset: { action: "edit-editorial", noteType: "recommendation_reason", workId: work.id },
          }),
          element("button", {
            className: "quiet-button",
            type: "button",
            text: ed?.content ? "修改编辑点评" : "添加编辑点评",
            dataset: { action: "edit-editorial", noteType: "editorial_note", workId: work.id },
          }),
        ]),
      );
    }
    if (editorialBlock.childElementCount) {
      // 插入到 body 之后、actionBar 之前更贴近正文；此处插在 actionBar 之后
      shell.append(editorialBlock);
    }
```

（若需紧贴正文，可在 `shell.append` 中把 `editorialBlock` 放在 `renderAnnotatableBody(...)` 之后、`actionBar` 之前。以阅读顺序自然为准：推荐理由/编辑点评置于正文后、讨论前。）

- [ ] **Step 3: 优质评论标记**

在 `createCommentItem` 中，`item.append(head, content)` 之后、`if (!comment.is_deleted)` 之前，加入：

```js
  const highlight = window.__workHighlights?.get(comment.id);
  if (highlight) {
    const badge = element("div", { className: "comment-highlight" }, [
      element("span", { className: "comment-highlight-mark", text: "编辑推荐" }),
      element("p", { className: "comment-highlight-reason", text: highlight.reason }),
    ]);
    item.append(badge);
  }
```

并在 `renderWork` 渲染评论树前设置 `window.__workHighlights = workHighlights;`（渲染后清理 `window.__workHighlights = null;`）。`createCommentItem` 是纯函数，用全局临时 Map 传入高亮信息以最小改动。

- [ ] **Step 4: 评论「设为优质评论」**

在 `createCommentItem` 的 actions 区，`state.session` 为 admin 时追加：

```js
    if (state.session?.profile?.role === "admin" && !comment.is_deleted) {
      actions.append(
        element("button", {
          type: "button",
          text: window.__workHighlights?.get(comment.id) ? "取消推荐" : "设为优质评论",
          dataset: {
            action: window.__workHighlights?.get(comment.id) ? "unhighlight-comment" : "highlight-comment",
            commentId: comment.id,
            workId,
          },
        }),
      );
    }
```

- [ ] **Step 5: 编辑点评/推荐理由对话框（复用 prompt 或新对话框）**

为「添加/修改推荐理由/编辑点评」与「设为优质评论」提供输入。最简单一致的做法是新增一个复用对话框 `editorialDialog`（参照 `annotateDialog`）带 textarea + 隐藏 noteType/commentId；或直接用一个 `window.prompt`。项目已移除 `window.prompt`（发布3 补丁），因此新增 `editorialDialog`：

在 `index.html` 追加：

```html
    <dialog class="modal editorial-dialog" id="editorialDialog" aria-labelledby="editorialTitle">
      <div class="modal-head">
        <div>
          <p class="eyebrow">EDITORIAL</p>
          <h2 id="editorialTitle">编辑内容</h2>
        </div>
        <button class="close-button" type="button" data-action="close-editorial" aria-label="关闭">关闭</button>
      </div>
      <form id="editorialForm" class="stack-form">
        <p class="form-message" data-editorial-message role="status"></p>
        <label>
          <span id="editorialFieldLabel">内容</span>
          <textarea name="content" id="editorialContent" maxlength="2000" rows="5" required></textarea>
        </label>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-editorial">取消</button>
          <button class="primary-button" type="submit">保存</button>
        </div>
      </form>
    </dialog>
```

事件：`data-action="edit-editorial"` 打开时设置 `pendingEditorial = { workId, noteType }` 并填初值；提交时调 `service.setWorkEditorialNote(workId, noteType, content)` 后 `renderWork(workId)`。`data-action="highlight-comment"` 打开同一对话框并设置 `pendingEditorial = { commentId, workId, mode: "highlight" }`；提交调 `service.highlightComment`。`data-action="unhighlight-comment"` 直接调 `service.unhighlightComment` 后 `renderWork(workId)`。

- [ ] **Step 6: 样式**

在 `assets/styles.css` 末尾追加：

```css
.editorial-block { border-left: 2px solid var(--cinnabar, #9a3b3b); padding-left: 1rem; margin: 1.5rem 0; }
.editorial-recommendation, .editorial-note { margin-bottom: 1rem; }
.editorial-text { font-size: 1.02em; }
.editorial-meta { opacity: 0.75; font-size: 0.85em; margin-top: 0.25rem; }
.editorial-admin-actions { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
.comment-highlight {
  border: 1px solid var(--cinnabar, #9a3b3b); padding: 0.5rem 0.75rem; margin: 0.5rem 0;
  background: rgba(154, 59, 59, 0.06);
}
.comment-highlight-mark { font-weight: 600; color: var(--cinnabar, #9a3b3b); }
.comment-highlight-reason { margin-top: 0.25rem; font-size: 0.95em; }
```

- [ ] **Step 7: 运行服务层 + 静态测试**

Run: `node --test tests/governance-service.test.mjs tests/static-checks.mjs`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add index.html js/app.js assets/styles.css
git commit -m "feat: work page editorial display and inline admin editing"
```

---

## Task 11: 投稿引导清单

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: renderWrite 顶部插入引导清单**

在 `renderWrite` 渲染表单之前（页面 shell 内、标题后），插入非阻塞提醒块：

```js
    const checklist = element("section", {
      className: "submission-checklist",
      attrs: { "aria-label": "投稿前提醒" },
    }, [
      element("p", { className: "eyebrow", text: "BEFORE YOU SUBMIT" }),
      element("ul", {}, [
        element("li", { text: "确保作品为本人原创。" }),
        element("li", { text: "引用或化用他人文字时，注明来源。" }),
        element("li", { text: "发布前检查分段与标点，避免整段堆叠。" }),
        element("li", { text: "建议去读一读其他社员的新作，参与互评。" }),
      ]),
      element("p", { className: "submission-checklist-note", text: "以上仅为提醒，不会阻止发布。" }),
    ]);
```

把 `checklist` 追加到页面 shell 中标题之下、表单之前（阅读 `renderWrite` 现有结构后确定插入点，保持与新作/编辑两种模式一致）。

- [ ] **Step 2: 样式**

在 `assets/styles.css` 末尾追加：

```css
.submission-checklist {
  border: 1px dashed currentColor; padding: 1rem; margin-bottom: 1.5rem;
  background: rgba(128, 128, 128, 0.05);
}
.submission-checklist ul { margin: 0.5rem 0 0.25rem; padding-left: 1.2rem; }
.submission-checklist-note { opacity: 0.75; font-size: 0.85em; margin-top: 0.5rem; }
```

- [ ] **Step 3: 浏览器本地验证清单可见**

Run: 启动静态服务，打开写作页确认清单出现且不阻止保存。`node tests/static-server.cjs`（参考 `package.json` scripts 的启动方式）。

- [ ] **Step 4: 提交**

```bash
git add js/app.js assets/styles.css
git commit -m "feat: non-blocking submission checklist on write page"
```

---

## Task 12: 账户菜单管理台入口

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`

- [ ] **Step 1: 账户菜单加管理台链接**

在 `index.html` 账户菜单（`#accountMenu`）中，「账号安全」链接前加入（默认隐藏，登录后按角色显示）：

```html
            <a href="#/admin" id="adminMenuLink" hidden>管理台</a>
```

- [ ] **Step 2: 登录态更新菜单可见性**

在 `js/app.js` 的 `updateHeader()` 中，登录分支（`if (state.session) {`）内加入：

```js
    const adminMenuLink = document.querySelector("#adminMenuLink");
    if (adminMenuLink) adminMenuLink.hidden = state.session.profile.role !== "admin";
```

退出分支（else）中确保隐藏：

```js
    const adminMenuLink = document.querySelector("#adminMenuLink");
    if (adminMenuLink) adminMenuLink.hidden = true;
```

- [ ] **Step 3: 提交**

```bash
git add index.html js/app.js
git commit -m "feat: admin menu entry in account menu"
```

---

## Task 13: 浏览器测试（治理全流程）

**Files:**
- Modify: `tests/browser-check.cjs`
- Modify: `tests/static-checks.mjs`（治理块断言已含）

- [ ] **Step 1: 新增治理浏览器流程**

在 `tests/browser-check.cjs` 的 `socialFlow` 之后新增 `governanceFlow`，并在主入口 `main()` 中注册（参照 `socialFlow` 的注册方式）：

```js
async function governanceFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") browserMessages.push(`governance console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`governance pageerror: ${error.message}`);
  });

  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");

  // 非管理员（松声）访问 #/admin → 无权限
  await login(page, "2023123456", "wenyuan88");
  await goToHash(page, "#/admin", "只有管理员可以进入处置台");

  // 白露举报松声的作品《末班车经过友谊校区》
  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "2022111111", "reader88");
  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区");
  await expectVisible(page.getByRole("button", { name: "举报作品" }), "作品举报按钮");
  await page.getByRole("button", { name: "举报作品" }).click();
  await expectVisible(page.locator("#reportDialog"), "举报对话框");
  await page.locator('#reportForm textarea[name="detail"]').fill("疑似违规");
  await page.getByRole("button", { name: "提交举报" }).click();
  await expectVisible(page.getByText("举报已提交"), "举报成功提示");

  // 编辑部（admin）登录 → 处置台待处理有 1 条 → 处置成立隐藏作品
  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "2023000001", "editor88");
  await goToHash(page, "#/admin", "管理台");
  await expectVisible(page.locator(".report-item"), "待处理举报列表");
  if ((await page.locator(".report-item").count()) < 1) {
    throw new Error("待处理举报应为至少 1 条");
  }
  // 处置：成立 + 隐藏作品 + 内部说明
  await page.locator(".moderate-form select[name='decision']").selectOption("resolved");
  await page.locator(".moderate-form select[name='actionType']").selectOption("hide_work");
  await page.locator('.moderate-form textarea[name="internalNote"]').fill("确认违规");
  await page.getByRole("button", { name: "提交处置" }).click();
  await expectVisible(page.getByText("处置已提交"), "处置成功提示");
  await page.getByRole("tab", { name: /处置与审计/ }).click();
  await expectVisible(page.locator(".audit-item"), "审计记录列表");
  if (!(await page.locator(".audit-item").innerText()).includes("内部说明：确认违规")) {
    throw new Error("审计记录缺少内部说明");
  }

  // 作者松声收到处置结果通知
  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "2023123456", "wenyuan88");
  await goToHash(page, "#/notifications", "消息");
  const texts = await page.locator(".notification-text").allTextContents();
  if (!texts.some((t) => t.includes("处理了与你相关的举报"))) {
    throw new Error(`松声未收到处置结果通知：${texts.join(" | ")}`);
  }

  await context.close();
}
```

- [ ] **Step 2: 主入口注册 governanceFlow**

在 `main()` 的浏览器流程列表中追加 `governanceFlow(browser, browserMessages)`，并把总断言消息数注释更新为含治理流程的预期值（若现有代码对 browserMessages 长度有断言，先查看再调整）。

- [ ] **Step 3: 运行浏览器测试**

Run: `node tests/run-browser-check.cjs`
Expected: 全部流程通过，无 JS error。若 demo 服务在浏览器端行为与测试不符，回到 Task 4 修正演示态。

- [ ] **Step 4: 提交**

```bash
git add tests/browser-check.cjs
git commit -m "test: browser-check governance flow (report, moderate, audit, notify)"
```

---

## Task 14: 整站视觉与无障碍复核

**Files:**
- Modify: `assets/styles.css`
- Review: `index.html`、`js/app.js` 焦点可达性

- [ ] **Step 1: 对照清单审计并修复**

逐项核对 `assets/styles.css`（可新建 `screenshots/` 下桌面+移动截图对比）：

1. **移动正文**：`.work-content p`（或正文容器）font-size ≥16px、line-height ≥1.9；若存在 `@media (max-width: 760px)` 覆盖，确保不缩水。
2. **关键元信息**：`.reading-meta`、`.discussion-meta`、`.notification-time` 等 ≥13px。
3. **触控目标**：`.comment-like-button`、`.reply`、`.like-button`、`.admin-tab` 等高度 ≥44px 或 padding 补足；`.quiet-button`/`.report-entry` 若过小，在触屏媒体查询中补 min-height: 44px。
4. **对比度**：正文文字颜色与背景对比 ≥4.5:1；`.editorial-meta`/`.audit-meta`/`.report-meta` 等弱化文字 opacity 调整到对比度达标（不透明度建议 ≥0.7 或改用明确色值）。
5. **焦点状态**：`a:focus-visible`、`button:focus-visible`、`input/textarea/select:focus-visible` 有可见 outline 或背景变化（保留现有气质，用暗红描边）。
6. **未读朱砂标记**：保留 `.notification-item.unread` 的朱砂左侧标记；确认新 `.comment-highlight-mark` 沿用暗红。

对每项，用实际计算值检查（可写一次性 Playwright 脚本计算 computed style，也可目测截图）。修复后保持米白/墨黑/暗红/宋体/留白/细线气质，不引入玻璃拟态、表情导航、商业卡片流、长期侧栏。

- [ ] **Step 2: 截图复核**

Run: `node tests/run-browser-check.cjs`（会重生成 `screenshots/desktop-home.png`、`mobile-home.png`、`mobile-reading.png` 等），检查移动端无横向溢出、正文字号/行高达标、触控目标高度合格。

- [ ] **Step 3: 提交**

```bash
git add assets/styles.css index.html js/app.js
git commit -m "fix: visual and accessibility review — font size, contrast, focus, touch targets"
```

---

## Task 15: 全量测试收口

**Files:**
- Verify: 全部

- [ ] **Step 1: 运行全量单元/DB/静态测试**

Run: `npm test`
Expected: 全绿。基线为发布4 的 303 个；新增治理 DB + 服务 + 静态断言后总数上升（约 320+）。若有失败，回到对应任务修复。

- [ ] **Step 2: 运行浏览器套件**

Run: `node tests/run-browser-check.cjs`
Expected: 桌面/移动/账号安全/社交/治理 五流程全过，无 JS error，无横向溢出。

- [ ] **Step 3: 更新任务账本**

编辑 `文社网站待完成更新任务.md`：发布5 节顶部加一行「实施中」，概述已完成任务清单（Task 1-15 状态）。

- [ ] **Step 4: 提交**

```bash
git add 文社网站待完成更新任务.md
git commit -m "chore: mark Release 5 implementation progress in task ledger"
```

---

## 迁移部署（此计划的后续执行，不在任务内自动执行）

迁移文件审查 → 测试环境验证 → 完整自动化测试 → 生产迁移确认（用户在生产 SQL Editor 执行 `20260811_governance_and_admin.sql`，采用**文件上传**避免粘贴丢行）→ 前端发布 → 线上冒烟。生产/main/GitHub Pages 未经负责人明确批准不动。

## 协作红线（与账本一致）

- 新增测试验证真实行为，不以正则检查源码作为主要测试（Task 3 的治理块断言属发布4 既有的双载模式，允许）。
- 向 staging 写 migration、设 secrets、部署函数、建虚构用户前，先停下请求 staging-only 授权。
- 生产、`main`、GitHub Pages 未经负责人明确批准不动。
- 禁止把完整找回邮箱/内部说明放进公开查询/日志/通知；前端永不出现 `service_role` 或任何密钥。
