-- 文苑文学社区：全新 Supabase 数据结构与 Row Level Security
-- 在全新的 Supabase 项目 SQL Editor 中一次性执行本文件。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pen_name text not null check (char_length(pen_name) between 1 and 24),
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
