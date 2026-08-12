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
revoke delete on table public.works from authenticated;

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
    if char_length(v_change_summary) > 200 then
      raise exception '修改说明不能超过 200 个字符';
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
  if char_length(v_change_summary) > 200 then
    raise exception '修改说明不能超过 200 个字符';
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

-- 删除作品：作者或管理员、需验证找回邮箱；按引用/版本依赖顺序删除，
-- 避免 comment_quotes 的 on delete restrict 阻断，杜绝绕过版本化的直接删除。
create or replace function public.delete_work(p_work_id uuid)
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

  select *
  into v_work
  from public.works
  where id = p_work_id;

  if v_work.id is null then
    raise exception '作品不存在';
  end if;
  if v_work.author_id <> auth.uid() and not public.is_admin() then
    raise exception '没有权限删除这篇作品';
  end if;

  delete from public.comments where work_id = p_work_id;
  delete from public.works where id = p_work_id;
  delete from public.work_versions where work_id = p_work_id;
end;
$$;

revoke all on function public.delete_work(uuid) from public;
grant execute on function public.delete_work(uuid) to authenticated;

-- 批注展示串：content 按 /\n[[:space:]]*\n/ 分段、逐段 trim（含空格/Tab/回车/换行/垂直
-- 制表/换页及全角空格 U+3000）、去空段、以 \n 连接（与前端 renderParagraphs 规则一致）；
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
