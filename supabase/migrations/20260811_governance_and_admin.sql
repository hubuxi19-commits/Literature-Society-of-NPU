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
-- 先删除发布四的 5 参签名再以 6 参（含默认值）重建，避免同一调用名出现两个重载
-- （5 参调用在 6 参带默认值时产生歧义，导致 follow/bookmark/like/comment/highlight
-- 等全部既有 5 参调用在运行时报 "function ... is not unique"）。
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
