-- 文苑文学社区：全新 Supabase 数据结构与 Row Level Security
-- 在全新的 Supabase 项目 SQL Editor 中一次性执行本文件。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pen_name text not null check (char_length(pen_name) between 1 and 24),
  pen_name_changed_at timestamptz,
  bio text not null default '' check (char_length(bio) <= 240),
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  excerpt text not null default '' check (char_length(excerpt) <= 180),
  content text not null check (char_length(content) between 1 and 50000),
  category text not null check (
    category in ('新诗', '旧诗', '散文', '小说', '随笔', '其他')
  ),
  status text not null default 'published' check (
    status in ('published', 'hidden')
  ),
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.likes (
  work_id uuid not null references public.works(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete set null,
  content text not null default '' check (char_length(content) <= 2000),
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_deleted or char_length(content) between 1 and 2000)
);

create table if not exists public.site_settings (
  key text primary key check (char_length(key) between 1 and 80),
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists works_created_at_idx
  on public.works (created_at desc);
create index if not exists works_category_created_at_idx
  on public.works (category, created_at desc);
create index if not exists works_author_created_at_idx
  on public.works (author_id, created_at desc);
create index if not exists likes_work_id_idx
  on public.likes (work_id);
create index if not exists comments_work_created_at_idx
  on public.comments (work_id, created_at);
create index if not exists comments_parent_id_idx
  on public.comments (parent_id);
create index if not exists comments_user_id_idx
  on public.comments (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists works_set_updated_at on public.works;
create trigger works_set_updated_at
before update on public.works
for each row execute function public.set_updated_at();

drop trigger if exists comments_set_updated_at on public.comments;
create trigger comments_set_updated_at
before update on public.comments
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_pen_name text;
begin
  requested_pen_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'pen_name'), ''),
      '新社员'
    ),
    24
  );

  insert into public.profiles (id, pen_name)
  values (new.id, requested_pen_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
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

create or replace function public.validate_comment_parent()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_work_id uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  select work_id
  into parent_work_id
  from public.comments
  where id = new.parent_id;

  if parent_work_id is null or parent_work_id <> new.work_id then
    raise exception '回复必须属于同一篇作品';
  end if;

  return new;
end;
$$;

drop trigger if exists comments_validate_parent on public.comments;
create trigger comments_validate_parent
before insert or update of parent_id, work_id on public.comments
for each row execute function public.validate_comment_parent();

create or replace function public.soft_delete_comment(target_comment_id uuid)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.comments;
begin
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

alter table public.profiles enable row level security;
alter table public.works enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.site_settings enable row level security;

drop policy if exists "profiles_public_read" on public.profiles;
create policy "profiles_public_read"
on public.profiles
for select
to anon, authenticated
using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "works_read_published_or_owned" on public.works;
create policy "works_read_published_or_owned"
on public.works
for select
to anon, authenticated
using (
  status = 'published'
  or author_id = auth.uid()
  or public.is_admin()
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
);

drop policy if exists "works_update_own_or_admin" on public.works;
create policy "works_update_own_or_admin"
on public.works
for update
to authenticated
using (author_id = auth.uid() or public.is_admin())
with check (author_id = auth.uid() or public.is_admin());

drop policy if exists "works_delete_own_or_admin" on public.works;
create policy "works_delete_own_or_admin"
on public.works
for delete
to authenticated
using (author_id = auth.uid() or public.is_admin());

drop policy if exists "likes_public_read" on public.likes;
create policy "likes_public_read"
on public.likes
for select
to anon, authenticated
using (true);

drop policy if exists "likes_insert_own" on public.likes;
create policy "likes_insert_own"
on public.likes
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "likes_delete_own" on public.likes;
create policy "likes_delete_own"
on public.likes
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "comments_read_for_published_works" on public.comments;
create policy "comments_read_for_published_works"
on public.comments
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.works
    where works.id = comments.work_id
      and works.status = 'published'
  )
);

drop policy if exists "comments_insert_own" on public.comments;
create policy "comments_insert_own"
on public.comments
for insert
to authenticated
with check (
  user_id = auth.uid()
  and is_deleted = false
);

drop policy if exists "site_settings_public_read" on public.site_settings;
create policy "site_settings_public_read"
on public.site_settings
for select
to anon, authenticated
using (true);

drop policy if exists "site_settings_admin_insert" on public.site_settings;
create policy "site_settings_admin_insert"
on public.site_settings
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "site_settings_admin_update" on public.site_settings;
create policy "site_settings_admin_update"
on public.site_settings
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "site_settings_admin_delete" on public.site_settings;
create policy "site_settings_admin_delete"
on public.site_settings
for delete
to authenticated
using (public.is_admin());

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.works from anon, authenticated;
revoke all on table public.likes from anon, authenticated;
revoke all on table public.comments from anon, authenticated;
revoke all on table public.site_settings from anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant update (bio, updated_at) on table public.profiles to authenticated;

grant select on table public.works to anon, authenticated;
grant insert on table public.works to authenticated;
grant update (
  title,
  excerpt,
  content,
  category,
  status,
  updated_at
) on table public.works to authenticated;
grant delete on table public.works to authenticated;

grant select on table public.likes to anon, authenticated;
grant insert, delete on table public.likes to authenticated;

grant select on table public.comments to anon, authenticated;
grant insert on table public.comments to authenticated;

grant select on table public.site_settings to anon, authenticated;
grant insert, update, delete on table public.site_settings to authenticated;

revoke all on function public.soft_delete_comment(uuid) from public;
grant execute on function public.soft_delete_comment(uuid) to authenticated;

revoke all on function public.set_work_featured(uuid, boolean) from public;
grant execute on function public.set_work_featured(uuid, boolean) to authenticated;

revoke all on function public.update_own_profile(text, text) from public;
grant execute on function public.update_own_profile(text, text) to authenticated;

insert into public.site_settings (key, value)
values
  (
    'editor_note',
    jsonb_build_object(
      'title', '把写下的交给彼此',
      'body', '这里持续收录社员的新作，也保留认真、具体、彼此尊重的讨论。无需等到某个刊期，写完就可以来到这里。'
    )
  ),
  (
    'submission',
    jsonb_build_object(
      'title', '长期征稿',
      'body', '新诗、旧诗、散文、小说、随笔与其他文字均可投稿。请确保作品为本人原创，并尊重评论区里的每一位读者。'
    )
  ),
  (
    'community_rules',
    jsonb_build_array(
      '讨论作品，不攻击作者。',
      '引用他人文字时注明来源。',
      '管理员仅在违反社区规则时隐藏内容。'
    )
  )
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();

-- ACCOUNT_RECOVERY_SECURITY_START
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

-- ACCOUNT_RECOVERY_SECURITY_END
-- BROWSE_READ_START
create extension if not exists pg_trgm;

create index if not exists works_content_trgm_idx
  on public.works using gin (content gin_trgm_ops);

-- browse_works 与 browse_discussions 函数体与
-- supabase/migrations/20260806_browse_works_and_discussions.sql 完全一致。

create or replace function public.browse_works(
  p_search text default '',
  p_category text default '全部',
  p_sort text default 'latest',
  p_cursor text default null,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_page_size, 10), 1), 10);
  v_uid uuid := auth.uid();
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_category text := btrim(coalesce(p_category, '全部'));
  v_sort text := btrim(coalesce(p_sort, 'latest'));
  v_cursor_created timestamptz;
  v_cursor_id uuid;
  v_cursor_like bigint := 0;
  v_cursor_comment bigint := 0;
  v_has_cursor boolean := false;
  v_sql text;
  v_rows record;
  v_works jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_created timestamptz;
  v_last_id uuid;
  v_last_like bigint := 0;
  v_last_comment bigint := 0;
  v_liked boolean := false;
  v_next text := null;
begin
  if v_sort not in ('latest', 'likes', 'discussions') then
    v_sort := 'latest';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select
        (payload ->> 'created_at')::timestamptz,
        (payload ->> 'id')::uuid,
        coalesce((payload ->> 'like_count')::bigint, 0),
        coalesce((payload ->> 'comment_count')::bigint, 0)
      into v_cursor_created, v_cursor_id, v_cursor_like, v_cursor_comment
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    with base as (
      select
        w.id, w.author_id, w.title, w.excerpt, w.content, w.category, w.is_featured,
        w.created_at, w.updated_at,
        p.pen_name as author_pen_name, p.bio as author_bio, p.role as author_role,
        (select count(*) from public.likes l where l.work_id = w.id)::bigint as like_count,
        -- 计数排除已删除评论，与 browse_discussions 的可见列表口径一致
        (select count(*) from public.comments c where c.work_id = w.id and c.is_deleted = false)::bigint as comment_count
      from public.works w
      join public.profiles p on p.id = w.author_id
      where w.status = 'published'
        and (%L = '全部' or w.category = %L)
        -- pg_trgm 的 GIN 索引最小匹配 3 字符；1-2 字中文查询不走索引、退化为 seq scan，
        -- 仅作品量很大时才需评估 pgroonga 等方案（见 plan #10）。
        and (%L = ''
          or w.title ilike '%%' || %L || '%%'
          or w.excerpt ilike '%%' || %L || '%%'
          or w.content ilike '%%' || %L || '%%'
          or p.pen_name ilike '%%' || %L || '%%')
    )
    select *
    from base
    where %s
    order by
      case %L
        when 'likes' then like_count
        when 'discussions' then comment_count
        else 0
      end desc,
      created_at desc,
      id desc
    limit %s
    $query$,
    v_category, v_category,
    v_search, v_search, v_search, v_search, v_search,
    case
      when v_has_cursor
        then case v_sort
          when 'likes'
            then format('(like_count, created_at, id) < (%s::bigint, %L::timestamptz, %L::uuid)', v_cursor_like, v_cursor_created, v_cursor_id)
          when 'discussions'
            then format('(comment_count, created_at, id) < (%s::bigint, %L::timestamptz, %L::uuid)', v_cursor_comment, v_cursor_created, v_cursor_id)
          else format('(created_at, id) < (%L::timestamptz, %L::uuid)', v_cursor_created, v_cursor_id)
        end
      else 'true'
    end,
    v_sort,
    v_limit + 1
  );

  for v_rows in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_liked := v_uid is not null and exists (
        select 1 from public.likes own
        where own.work_id = v_rows.id and own.user_id = v_uid
      );
      v_works := v_works || jsonb_build_object(
        'id', v_rows.id,
        'author_id', v_rows.author_id,
        'title', v_rows.title,
        'excerpt', v_rows.excerpt,
        'content', v_rows.content,
        'category', v_rows.category,
        'is_featured', v_rows.is_featured,
        'created_at', v_rows.created_at,
        'updated_at', v_rows.updated_at,
        'author_pen_name', v_rows.author_pen_name,
        'author_bio', v_rows.author_bio,
        'author_role', v_rows.author_role,
        'like_count', v_rows.like_count,
        'comment_count', v_rows.comment_count,
        'liked_by_current_user', v_liked
      );
      v_last_created := v_rows.created_at;
      v_last_id := v_rows.id;
      v_last_like := v_rows.like_count;
      v_last_comment := v_rows.comment_count;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(
        jsonb_build_object(
          'created_at', v_last_created,
          'id', v_last_id,
          'like_count', v_last_like,
          'comment_count', v_last_comment
        )::text,
        'utf8'
      ),
      'base64'
    );
  end if;

  return jsonb_build_object('works', v_works, 'next_cursor', v_next);
end;
$$;

revoke all on function public.browse_works(text, text, text, text, integer) from public;
grant execute on function public.browse_works(text, text, text, text, integer) to anon, authenticated;

create or replace function public.browse_discussions(
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
  v_cursor_created timestamptz;
  v_cursor_id uuid;
  v_has_cursor boolean := false;
  v_sql text;
  v_rows record;
  v_discussions jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last_created timestamptz;
  v_last_id uuid;
  v_next text := null;
begin
  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      select (payload ->> 'created_at')::timestamptz, (payload ->> 'id')::uuid
      into v_cursor_created, v_cursor_id
      from (select convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb as payload) x;
      v_has_cursor := true;
    exception when others then
      v_has_cursor := false;
    end;
  end if;

  v_sql := format(
    $query$
    select
      cm.id, cm.work_id, w.title as work_title,
      cm.user_id, p.pen_name as user_pen_name, p.role as user_role,
      cm.parent_id, cm.content, cm.is_deleted, cm.created_at, cm.updated_at
    from public.comments cm
    join public.works w on w.id = cm.work_id and w.status = 'published'
    join public.profiles p on p.id = cm.user_id
    where %s
    order by cm.created_at desc, cm.id desc
    limit %s
    $query$,
    case when v_has_cursor
      then format('(cm.created_at, cm.id) < (%L::timestamptz, %L::uuid)', v_cursor_created, v_cursor_id)
      else 'true'
    end,
    v_limit + 1
  );

  for v_rows in execute v_sql loop
    v_count := v_count + 1;
    if v_count <= v_limit then
      v_discussions := v_discussions || jsonb_build_object(
        'id', v_rows.id,
        'work_id', v_rows.work_id,
        'work_title', v_rows.work_title,
        'user_id', v_rows.user_id,
        'user_pen_name', v_rows.user_pen_name,
        'user_role', v_rows.user_role,
        'parent_id', v_rows.parent_id,
        'content', v_rows.content,
        'is_deleted', v_rows.is_deleted,
        'created_at', v_rows.created_at,
        'updated_at', v_rows.updated_at
      );
      v_last_created := v_rows.created_at;
      v_last_id := v_rows.id;
    end if;
  end loop;

  if v_count > v_limit then
    v_next := encode(
      convert_to(
        jsonb_build_object('created_at', v_last_created, 'id', v_last_id)::text,
        'utf8'
      ),
      'base64'
    );
  end if;

  return jsonb_build_object('discussions', v_discussions, 'next_cursor', v_next);
end;
$$;

revoke all on function public.browse_discussions(text, integer) from public;
grant execute on function public.browse_discussions(text, integer) to anon, authenticated;
-- BROWSE_READ_END
-- VERSIONS_QUOTES_START
-- work_versions、comment_quotes、五个 RPC 与 RLS/授权收口与
-- supabase/migrations/20260808_work_versions_and_quotes.sql 完全一致。
create table if not exists public.work_versions (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  title text not null check (char_length(title) between 1 and 80),
  excerpt text not null default '' check (char_length(excerpt) <= 180),
  content text not null check (char_length(content) between 1 and 50000),
  category text not null check (
    category in ('新诗', '旧诗', '散文', '小说', '随笔', '其他')
  ),
  change_summary text not null default '初次发布' check (char_length(change_summary) between 1 and 200),
  restored_from_version_id uuid references public.work_versions(id),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists work_versions_work_version_idx
  on public.work_versions (work_id, version_number);

create index if not exists work_versions_work_id_idx
  on public.work_versions (work_id);

alter table public.works
  add column if not exists current_version_id uuid references public.work_versions(id);

create table if not exists public.comment_quotes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  work_version_id uuid not null references public.work_versions(id) on delete restrict,
  quote_text text not null check (char_length(quote_text) between 1 and 500),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  created_at timestamptz not null default now()
);

create index if not exists comment_quotes_comment_id_idx
  on public.comment_quotes (comment_id);

create index if not exists comment_quotes_version_id_idx
  on public.comment_quotes (work_version_id);

-- 回填：现有作品生成第 1 版（幂等：无版本的作品才插）
insert into public.work_versions (
  work_id, version_number, title, excerpt, content, category,
  change_summary, restored_from_version_id, created_by, created_at
)
select
  w.id, 1, w.title, w.excerpt, w.content, w.category,
  '初次发布', null, w.author_id, w.created_at
from public.works w
where not exists (
  select 1 from public.work_versions v where v.work_id = w.id
);

update public.works w
set current_version_id = v.id
from public.work_versions v
where v.work_id = w.id
  and v.version_number = 1
  and w.current_version_id is null;

alter table public.work_versions enable row level security;
alter table public.comment_quotes enable row level security;

drop policy if exists "work_versions_read_published" on public.work_versions;
create policy "work_versions_read_published"
on public.work_versions
for select
to anon, authenticated
using (
  exists (
    select 1 from public.works w
    where w.id = work_versions.work_id
      and (w.status = 'published' or w.author_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "comment_quotes_read_published" on public.comment_quotes;
create policy "comment_quotes_read_published"
on public.comment_quotes
for select
to anon, authenticated
using (
  exists (
    select 1 from public.comments cm
    join public.works w on w.id = cm.work_id
    where cm.id = comment_quotes.comment_id
      and (w.status = 'published' or w.author_id = auth.uid() or public.is_admin())
  )
);

revoke all on table public.work_versions from anon, authenticated;
revoke all on table public.comment_quotes from anon, authenticated;
grant select on table public.work_versions to anon, authenticated;
grant select on table public.comment_quotes to anon, authenticated;

-- 作品写入只经受保护 RPC，杜绝绕过版本化的直接写
revoke insert on table public.works from authenticated;
revoke update on table public.works from authenticated;

create or replace function public.create_work_version(
  p_work_id uuid,
  p_expected_version_number integer,
  p_title text,
  p_excerpt text,
  p_category text,
  p_content text,
  p_change_summary text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_created boolean := false;
  v_new_version_number integer;
  v_change_summary text := btrim(coalesce(p_change_summary, ''));
  v_title text := btrim(coalesce(p_title, ''));
  v_excerpt text := btrim(coalesce(p_excerpt, ''));
  v_category text := btrim(coalesce(p_category, '新诗'));
  v_content text := coalesce(p_content, '');
  v_version public.work_versions;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if char_length(v_title) not between 1 and 80 then
    raise exception '标题必须为 1 至 80 个字符';
  end if;
  if char_length(v_content) not between 1 and 50000 then
    raise exception '正文必须为 1 至 50000 个字符';
  end if;
  if v_category not in ('新诗', '旧诗', '散文', '小说', '随笔', '其他') then
    raise exception '分类无效';
  end if;
  if char_length(v_excerpt) > 180 then
    raise exception '摘要不能超过 180 个字符';
  end if;

  if p_work_id is null then
    insert into public.works (
      author_id, title, excerpt, content, category, status, is_featured
    ) values (
      auth.uid(), v_title, v_excerpt, v_content, v_category, 'published', false
    )
    returning * into v_work;
    v_created := true;
    v_new_version_number := 1;
  else
    select *
    into v_work
    from public.works
    where id = p_work_id
    for update;

    if v_work.id is null then
      raise exception '作品不存在';
    end if;
    if v_work.author_id <> auth.uid() then
      raise exception '只有作者可以修改自己的作品';
    end if;

    select coalesce(max(version_number), 0) + 1
    into v_new_version_number
    from public.work_versions
    where work_id = p_work_id;

    if p_expected_version_number is not null
      and p_expected_version_number <> v_new_version_number - 1 then
      raise exception '作品已被他人修改，请重新载入后重试';
    end if;

    if v_change_summary = '' then
      raise exception '请填写简短修改说明';
    end if;
  end if;

  insert into public.work_versions (
    work_id, version_number, title, excerpt, content, category,
    change_summary, restored_from_version_id, created_by
  ) values (
    v_work.id, v_new_version_number, v_title, v_excerpt, v_content, v_category,
    case when v_created then '初次发布' else v_change_summary end,
    null, auth.uid()
  )
  returning * into v_version;

  update public.works
  set
    title = v_title,
    excerpt = v_excerpt,
    content = v_content,
    category = v_category,
    current_version_id = v_version.id,
    updated_at = now()
  where id = v_work.id;

  return jsonb_build_object(
    'work_id', v_work.id,
    'version_id', v_version.id,
    'version_number', v_version.version_number,
    'change_summary', v_version.change_summary,
    'is_new', v_created
  );
end;
$$;

revoke all on function public.create_work_version(uuid, integer, text, text, text, text, text) from public;
grant execute on function public.create_work_version(uuid, integer, text, text, text, text, text) to authenticated;

create or replace function public.restore_work_version(
  p_work_id uuid,
  p_source_version_id uuid,
  p_expected_version_number integer,
  p_change_summary text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_work public.works;
  v_source public.work_versions;
  v_new_version_number integer;
  v_change_summary text := btrim(coalesce(p_change_summary, ''));
  v_version public.work_versions;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if not public.is_account_write_allowed() then
    raise exception '请先验证找回邮箱后再进行此操作';
  end if;
  if v_change_summary = '' then
    raise exception '请填写简短修改说明';
  end if;

  select *
  into v_work
  from public.works
  where id = p_work_id
  for update;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.author_id <> auth.uid() then
    raise exception '只有作者可以修改自己的作品';
  end if;

  select *
  into v_source
  from public.work_versions
  where id = p_source_version_id
    and work_id = p_work_id;

  if v_source.id is null then
    raise exception '要恢复的版本不存在';
  end if;

  select coalesce(max(version_number), 0) + 1
  into v_new_version_number
  from public.work_versions
  where work_id = p_work_id;

  if p_expected_version_number is not null
    and p_expected_version_number <> v_new_version_number - 1 then
    raise exception '作品已被他人修改，请重新载入后重试';
  end if;

  insert into public.work_versions (
    work_id, version_number, title, excerpt, content, category,
    change_summary, restored_from_version_id, created_by
  ) values (
    v_work.id, v_new_version_number,
    v_source.title, v_source.excerpt, v_source.content, v_source.category,
    v_change_summary, p_source_version_id, auth.uid()
  )
  returning * into v_version;

  update public.works
  set
    title = v_version.title,
    excerpt = v_version.excerpt,
    content = v_version.content,
    category = v_version.category,
    current_version_id = v_version.id,
    updated_at = now()
  where id = v_work.id;

  return jsonb_build_object(
    'work_id', v_work.id,
    'version_id', v_version.id,
    'version_number', v_version.version_number,
    'restored_from_version_id', p_source_version_id,
    'change_summary', v_version.change_summary
  );
end;
$$;

revoke all on function public.restore_work_version(uuid, uuid, integer, text) from public;
grant execute on function public.restore_work_version(uuid, uuid, integer, text) to authenticated;

-- 批注展示串：content 按 /\n\s*\n/ 分段、逐段 trim、去空段、以 \n 连接；
-- start_offset/end_offset 是 0 基字符偏移，与前端 renderParagraphs 的展示串一致。
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

  for v_seg in select regexp_split_to_table(v_version.content, E'\n\\s*\n') loop
    v_seg := btrim(v_seg);
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

revoke all on function public.create_quoted_comment(uuid, uuid, text, integer, integer, text) from public;
grant execute on function public.create_quoted_comment(uuid, uuid, text, integer, integer, text) to authenticated;

create or replace function public.list_work_versions(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_versions jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.works w
    where w.id = p_work_id
      and (w.status = 'published' or w.author_id = auth.uid() or public.is_admin())
  ) then
    raise exception '作品不存在';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', v.id,
      'version_number', v.version_number,
      'title', v.title,
      'excerpt', v.excerpt,
      'content', v.content,
      'category', v.category,
      'change_summary', v.change_summary,
      'restored_from_version_id', v.restored_from_version_id,
      'created_by', v.created_by,
      'created_at', v.created_at
    )
    order by v.version_number desc
  ), '[]'::jsonb)
  into v_versions
  from public.work_versions v
  where v.work_id = p_work_id;

  return v_versions;
end;
$$;

revoke all on function public.list_work_versions(uuid) from public;
grant execute on function public.list_work_versions(uuid) to anon, authenticated;

create or replace function public.list_work_quotes(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_quotes jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.works w
    where w.id = p_work_id
      and (w.status = 'published' or w.author_id = auth.uid() or public.is_admin())
  ) then
    raise exception '作品不存在';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'comment_id', cq.comment_id,
      'work_version_id', cq.work_version_id,
      'quote_text', cq.quote_text,
      'start_offset', cq.start_offset,
      'end_offset', cq.end_offset,
      'comment_content', cm.content,
      'is_deleted', cm.is_deleted,
      'user_id', cm.user_id,
      'user_pen_name', p.pen_name,
      'created_at', cq.created_at
    )
    order by cq.start_offset asc
  ), '[]'::jsonb)
  into v_quotes
  from public.comment_quotes cq
  join public.comments cm on cm.id = cq.comment_id
  join public.profiles p on p.id = cm.user_id
  where cm.work_id = p_work_id;

  return v_quotes;
end;
$$;

revoke all on function public.list_work_quotes(uuid) from public;
grant execute on function public.list_work_quotes(uuid) to anon, authenticated;
-- VERSIONS_QUOTES_END
