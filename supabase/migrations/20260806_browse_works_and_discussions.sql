begin;

create extension if not exists pg_trgm;

create index if not exists works_content_trgm_idx
  on public.works using gin (content gin_trgm_ops);

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
        'liked_by_current_user', v_uid is not null
          and exists (
            select 1 from public.likes own
            where own.work_id = v_rows.id and own.user_id = v_uid
          )
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

commit;
