begin;

create table if not exists public.account_recovery_emails (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email_normalized text not null unique
    check (email_normalized = lower(btrim(email_normalized)))
    check (char_length(email_normalized) between 3 and 320),
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_action_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  purpose text not null check (purpose in (
    'bind_email', 'change_email_old', 'change_email_new', 'reset_password'
  )),
  token_digest bytea not null unique,
  email_normalized text,
  next_email_normalized text,
  expires_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.auth_rate_limits (
  action text not null,
  key_digest bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count >= 1),
  primary key (action, key_digest, window_started_at)
);

alter table public.account_recovery_emails enable row level security;
alter table public.account_action_tokens enable row level security;
alter table public.auth_rate_limits enable row level security;

revoke all on table public.account_recovery_emails from anon, authenticated;
revoke all on table public.account_action_tokens from anon, authenticated;
revoke all on table public.auth_rate_limits from anon, authenticated;

create or replace function public.is_recovery_email_verified()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.account_recovery_emails
      where user_id = auth.uid()
        and verified_at is not null
    );
$$;

create or replace function public.is_account_write_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select value ->> 'write_gate'
      from public.site_settings
      where key = 'account_security'
    ),
    'off'
  ) <> 'enforce'
  or public.is_recovery_email_verified();
$$;

revoke all on function public.is_recovery_email_verified() from public;
grant execute on function public.is_recovery_email_verified() to authenticated;
revoke all on function public.is_account_write_allowed() from public;
grant execute on function public.is_account_write_allowed() to authenticated;

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (
  auth.uid() = id
  and public.is_account_write_allowed()
)
with check (
  auth.uid() = id
  and public.is_account_write_allowed()
);

drop policy if exists "works_insert_own" on public.works;
create policy "works_insert_own"
on public.works
for insert
to authenticated
with check (
  author_id = auth.uid()
  and status = 'published'
  and is_featured = false
  and public.is_account_write_allowed()
);

drop policy if exists "works_update_own_or_admin" on public.works;
create policy "works_update_own_or_admin"
on public.works
for update
to authenticated
using (
  (author_id = auth.uid() or public.is_admin())
  and public.is_account_write_allowed()
)
with check (
  (author_id = auth.uid() or public.is_admin())
  and public.is_account_write_allowed()
);

drop policy if exists "works_delete_own_or_admin" on public.works;
create policy "works_delete_own_or_admin"
on public.works
for delete
to authenticated
using (
  (author_id = auth.uid() or public.is_admin())
  and public.is_account_write_allowed()
);

drop policy if exists "likes_insert_own" on public.likes;
create policy "likes_insert_own"
on public.likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_account_write_allowed()
);

drop policy if exists "likes_delete_own" on public.likes;
create policy "likes_delete_own"
on public.likes
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.is_account_write_allowed()
);

drop policy if exists "comments_insert_own" on public.comments;
create policy "comments_insert_own"
on public.comments
for insert
to authenticated
with check (
  user_id = auth.uid()
  and is_deleted = false
  and public.is_account_write_allowed()
);

drop policy if exists "site_settings_admin_insert" on public.site_settings;
create policy "site_settings_admin_insert"
on public.site_settings
for insert
to authenticated
with check (
  public.is_admin()
  and public.is_account_write_allowed()
);

drop policy if exists "site_settings_admin_update" on public.site_settings;
create policy "site_settings_admin_update"
on public.site_settings
for update
to authenticated
using (
  public.is_admin()
  and public.is_account_write_allowed()
)
with check (
  public.is_admin()
  and public.is_account_write_allowed()
);

drop policy if exists "site_settings_admin_delete" on public.site_settings;
create policy "site_settings_admin_delete"
on public.site_settings
for delete
to authenticated
using (
  public.is_admin()
  and public.is_account_write_allowed()
);

-- p_caller_max_attempts is the caller's upper bound. The effective threshold
-- is always the stricter of that bound and the selected row's max_attempts.
create or replace function public.consume_account_action_token(
  p_presented_token_digest bytea,
  p_purpose text,
  p_user_id uuid,
  p_caller_max_attempts integer
)
returns public.account_action_tokens
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_candidate public.account_action_tokens;
  v_effective_max_attempts integer;
begin
  -- Serialize all attempts against the newest unused token for this
  -- user and purpose, regardless of whether the presented digest matches.
  select *
  into v_candidate
  from public.account_action_tokens
  where user_id = p_user_id
    and purpose = p_purpose
    and used_at is null
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    return null;
  end if;

  v_effective_max_attempts := least(
    v_candidate.max_attempts,
    p_caller_max_attempts
  );

  -- Expired or exhausted rows are terminal and do not gain more attempts.
  if v_candidate.expires_at <= now()
    or v_effective_max_attempts is null
    or v_effective_max_attempts < 1
    or v_candidate.attempt_count >= v_effective_max_attempts then
    return null;
  end if;

  if v_candidate.token_digest = p_presented_token_digest then
    update public.account_action_tokens
    set
      attempt_count = attempt_count + 1,
      used_at = now()
    where id = v_candidate.id
      and attempt_count + 1 <= v_effective_max_attempts
    returning * into v_candidate;

    if not found then
      return null;
    end if;
    return v_candidate;
  end if;

  update public.account_action_tokens
  set attempt_count = attempt_count + 1
  where id = v_candidate.id;
  return null;
end;
$$;

revoke all on function public.consume_account_action_token(
  bytea, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.consume_account_action_token(
  bytea, text, uuid, integer
) to service_role;

create or replace function public.consume_auth_rate_limit(
  p_action text,
  p_key_digest bytea,
  p_window_seconds integer,
  p_max_requests integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_window_started_at timestamptz;
  v_request_count integer;
begin
  if btrim(coalesce(p_action, '')) = '' then
    raise exception '限速动作不能为空';
  end if;
  if p_key_digest is null or octet_length(p_key_digest) = 0 then
    raise exception '限速键不能为空';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 then
    raise exception '限速窗口必须为正整数';
  end if;
  if p_max_requests is null or p_max_requests < 1 then
    raise exception '限速次数必须为正整数';
  end if;

  v_window_started_at := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds)
      * p_window_seconds
  );

  insert into public.auth_rate_limits (
    action,
    key_digest,
    window_started_at,
    request_count
  ) values (
    btrim(p_action),
    p_key_digest,
    v_window_started_at,
    1
  )
  on conflict (action, key_digest, window_started_at)
  do update
  set request_count = public.auth_rate_limits.request_count + 1
  returning request_count into v_request_count;

  return v_request_count <= p_max_requests;
end;
$$;

revoke all on function public.consume_auth_rate_limit(text, bytea, integer, integer)
from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text, bytea, integer, integer)
to service_role;

create or replace function public.set_work_featured(
  target_work_id uuid,
  featured boolean
)
returns public.works
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.works;
begin
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  if not public.is_admin() then
    raise exception '只有管理员可以设置编辑推荐';
  end if;

  update public.works
  set
    is_featured = featured,
    updated_at = now()
  where id = target_work_id
  returning * into target;

  if target.id is null then
    raise exception '作品不存在';
  end if;

  return target;
end;
$$;

create or replace function public.soft_delete_comment(target_comment_id uuid)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.comments;
begin
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  select *
  into target
  from public.comments
  where id = target_comment_id;

  if target.id is null then
    raise exception '评论不存在';
  end if;

  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  if target.user_id <> auth.uid() and not public.is_admin() then
    raise exception '没有权限删除这条评论';
  end if;

  update public.comments
  set
    content = '',
    is_deleted = true,
    updated_at = now()
  where id = target_comment_id
  returning * into target;

  return target;
end;
$$;

create or replace function public.update_own_profile(
  requested_pen_name text,
  requested_bio text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.profiles;
  normalized_pen_name text;
  normalized_bio text;
begin
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;

  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  normalized_pen_name := btrim(coalesce(requested_pen_name, ''));
  normalized_bio := btrim(coalesce(requested_bio, ''));
  if char_length(normalized_pen_name) not between 1 and 24 then
    raise exception '笔名必须为 1 至 24 个字符';
  end if;
  if char_length(normalized_bio) > 240 then
    raise exception '简介不能超过 240 个字符';
  end if;

  select *
  into target
  from public.profiles
  where id = auth.uid()
  for update;

  if target.id is null then
    raise exception '作者不存在';
  end if;

  if target.pen_name <> normalized_pen_name then
    if target.pen_name_changed_at is not null
      and now() < target.pen_name_changed_at + interval '7 days' then
      raise exception '笔名每七天只能修改一次，请在冷却期结束后再试';
    end if;

    update public.profiles
    set
      pen_name = normalized_pen_name,
      pen_name_changed_at = now(),
      bio = normalized_bio
    where id = auth.uid()
    returning * into target;
  else
    update public.profiles
    set bio = normalized_bio
    where id = auth.uid()
    returning * into target;
  end if;

  return target;
end;
$$;

insert into public.site_settings (key, value)
values (
  'account_security',
  jsonb_build_object('write_gate', 'off')
)
on conflict (key) do nothing;

commit;
