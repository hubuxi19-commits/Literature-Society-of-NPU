begin;

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

commit;
