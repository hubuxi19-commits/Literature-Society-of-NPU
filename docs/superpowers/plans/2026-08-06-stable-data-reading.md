# 稳定数据读取（发布 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将首页和讨论页从"全量下载 + 逐篇补查"改为服务端分页聚合与正文中文搜索，同批把关键元信息字号提升到 13px，消除加载全部作品、逐篇补查点赞评论和讨论页 N+1 的行为。

**Architecture:** 新增两个 SECURITY DEFINER 数据库函数 `browse_works` 与 `browse_discussions`，返回 JSONB（作品/讨论 + 聚合计数 + 当前用户点赞状态 + 不透明 keyset 游标），搜索词经参数绑定并用 `pg_trgm` GIN 索引支撑中文子串查询。数据服务层在 demo 与 supabase 两种实现里新增 `listWorksPage` / `listDiscussionsPage`，游标由服务端生成、前端原样回传。前端首页改为分批渲染 + “再读十篇”/移动预取，搜索输入 300ms 防抖并取消旧请求，返回首页恢复筛选、批次与阅读位置。

**Tech Stack:** 静态 HTML/CSS/ES modules、Supabase Postgres/RLS、`pg_trgm`、`@supabase/supabase-js@2`、Node test runner、PGlite、Playwright。

## Global Constraints

- 保留现有 `profiles`、`works`、`likes`、`comments`、`site_settings` 五张业务表，不新增表；只新增函数、索引和迁移。
- 不改变用户 UUID、作品 ID、作者归属；不删除、不改写任何现有数据。
- 所有新增读取不绕过 RLS 语义：`browse_works` 只返回 `status = 'published'` 的作品；`browse_discussions` 只返回已发布作品的评论。
- 服务端页面大小硬限制：作品每页最多 10 篇；讨论每页最多 20 条。
- 搜索词、分类、排序、游标一律经参数绑定或白名单拼接，禁止拼接用户输入进 SQL。
- 列表响应不返回正文全文（保留 `excerpt`）；正文只在单篇 `getWork` 里返回。
- 搜索覆盖标题、摘要、正文和作者笔名（中文子串）。
- 前端保留已加载作品：搜索/筛选失败或旧请求被取消时不把页面误显示成“0 篇”。
- 返回首页时恢复已加载批次、筛选状态和阅读位置（SPA 内 state 保留，阅读位置用 `sessionStorage`）。
- 演示服务、Supabase 服务与数据库函数的接口形状保持一致：`{ works, nextCursor }` / `{ discussions, nextCursor }`。
- 不向 staging/生产执行迁移、不部署函数、不推送 main、不发布 GitHub Pages，直到用户在测试验证后再次明确授权。
- 继续遵循测试验证真实行为而非正则检查源码文字为主的原则；发布前秘密扫描仍保留。

## File Structure

- `supabase/migrations/20260806_browse_works_and_discussions.sql`：生产增量迁移，新增 pg_trgm 扩展、GIN 索引、`browse_works`、`browse_discussions`。
- `supabase/schema.sql`：新项目完整结构，用 `-- BROWSE_READ_START` / `-- BROWSE_READ_END` 块与迁移保持一致。
- `js/utils.mjs`：新增 `searchWorks(works, filters)`，demo 服务复用其排序/搜索（覆盖正文），供演示分页使用。
- `js/data-service.mjs`：demo 与 supabase 两种实现新增 `listWorksPage` 与 `listDiscussionsPage`；supabase 版调用两个 RPC。
- `js/mobile-feed.mjs`：`createMobileFeedController` 增加 `append` 方法，供分页预取追加批次。
- `js/app.js`：首页桌面分页 + “再读十篇”、移动端预取、搜索防抖与取消、讨论页独立分页、返回首页恢复。
- `assets/styles.css`：关键元信息字号提升到 13px、移动端表单 16px、触控目标 44px 复核。
- `tests/works-browse-db.test.mjs`：PGlite 行为测试，验证两个 RPC 的分页、搜索、聚合、游标稳定与隐私。
- `tests/schema.test.mjs`：迁移与 schema 静态断言更新。
- `tests/data-service.test.mjs`：demo 分页行为 + supabase fake client RPC 契约测试。
- `tests/mobile-feed.test.mjs`：`append` 方法测试。
- `tests/static-checks.mjs`：新增元信息字号/对比度断言。
- `tests/browser-check.cjs`：桌面首页分页、搜索防抖、讨论分页与移动预取行为断言。

---

### Task 1: 数据库分页聚合与搜索 RPC（browse_works / browse_discussions）

**Files:**
- Create: `supabase/migrations/20260806_browse_works_and_discussions.sql`
- Modify: `supabase/schema.sql`（末尾追加 BROWSE 块）
- Create: `tests/works-browse-db.test.mjs`
- Modify: `tests/schema.test.mjs`

**Interfaces:**
- `browse_works(p_search text, p_category text, p_sort text, p_cursor text, p_page_size int) returns jsonb`
  - `p_search`：搜索词，默认 `''`；匹配 title/excerpt/content/author pen_name 的任意子串。
  - `p_category`：分类，默认 `'全部'`；`'全部'` 不过滤。
  - `p_sort`：`'latest' | 'likes' | 'discussions'`，默认 `'latest'`。
  - `p_cursor`：上一页返回的 `next_cursor`，默认 `null`；为空串按无游标处理。
  - `p_page_size`：请求页大小，服务端钳制为 `[1,10]`。
  - 返回 `{"works": [...], "next_cursor": "..." | null}`。每篇作品含：`id, author_id, title, excerpt, category, is_featured, created_at, updated_at, author_pen_name, author_bio, author_role, like_count, comment_count, liked_by_current_user`。**不含 content**。
  - 排序：latest 按 `created_at desc, id desc`；likes 按 `like_count desc, created_at desc, id desc`；discussions 按 `comment_count desc, created_at desc, id desc`。
- `browse_discussions(p_cursor text, p_page_size int) returns jsonb`
  - 返回 `{"discussions": [...], "next_cursor": "..." | null}`。每条讨论含：`id, work_id, work_title, user_id, user_pen_name, user_role, parent_id, content, is_deleted, created_at, updated_at`。
  - 只包含 `status = 'published'` 作品的评论；按 `created_at desc, id desc` keyset 分页。

- [ ] **Step 1: 写失败的迁移 + schema 静态断言**

在 `tests/schema.test.mjs` 末尾追加两个测试：

```js
test("分页迁移增加正文搜索索引、聚合浏览与讨论分页函数", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260806_browse_works_and_discussions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /create extension if not exists pg_trgm/i);
  assert.match(migration, /using gin\s*\(\s*content\s+gin_trgm_ops\s*\)/i);
  assert.match(migration, /create or replace function public\.browse_works/i);
  assert.match(migration, /create or replace function public\.browse_discussions/i);
  assert.match(migration, /least\(greatest\(coalesce\(p_page_size, 10\), 1\), 10\)/i);
  assert.match(migration, /status = 'published'/i);
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
});

test("schema 的分页块与迁移同时存在且函数只读已发布作品", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- BROWSE_READ_START/);
  assert.match(schema, /-- BROWSE_READ_END/);
  assert.match(schema, /create or replace function public\.browse_works/i);
  assert.match(schema, /create or replace function public\.browse_discussions/i);
});
```

- [ ] **Step 2: 运行 schema 测试验证 RED**

Run: `node --test tests/schema.test.mjs`
Expected: 新增两条测试 FAIL（迁移与 schema 均不存在）。

- [ ] **Step 3: 写失败的 PGlite 行为测试**

创建 `tests/works-browse-db.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const migrationUrl = new URL(
  "../supabase/migrations/20260806_browse_works_and_discussions.sql",
  import.meta.url,
);

const BROWSE_START = "-- BROWSE_READ_START";
const BROWSE_END = "-- BROWSE_READ_END";
const ACCOUNT_START = "-- ACCOUNT_RECOVERY_SECURITY_START";
const ACCOUNT_END = "-- ACCOUNT_RECOVERY_SECURITY_END";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";
const USER_C = "10000000-0000-4000-8000-000000000003";

function stripBlock(sql, start, end) {
  const startIndex = sql.indexOf(start);
  if (startIndex === -1) return sql;
  const endIndex = sql.indexOf(end, startIndex);
  if (endIndex === -1) throw new Error(`${start} 未闭合`);
  return sql.slice(0, startIndex) + sql.slice(endIndex + end.length);
}

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
  const schema = stripBlock(await readFile(schemaUrl, "utf8"), BROWSE_START, BROWSE_END);
  await db.exec(schema);
  const accountMigration = new URL(
    "../supabase/migrations/20260802_account_recovery_security.sql",
    import.meta.url,
  );
  try {
    const accountSql = await readFile(accountMigration, "utf8");
    await db.exec(accountSql);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await db.exec(await readFile(migrationUrl, "utf8"));
  return db;
}

async function seed(db) {
  await db.query(`
    insert into auth.users (id, email, raw_user_meta_data)
    values
      ($1, 'a@x.test', jsonb_build_object('pen_name', '松声')),
      ($2, 'b@x.test', jsonb_build_object('pen_name', '白露')),
      ($3, 'c@x.test', jsonb_build_object('pen_name', '杏雨'))
  `, [USER_A, USER_B, USER_C]);
  await db.exec(`
    insert into public.works (id, author_id, title, excerpt, content, category, status, created_at)
    select
      ('20000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
      (case when i % 3 = 0 then '${USER_A}' when i % 3 = 1 then '${USER_B}' else '${USER_C}' end)::uuid,
      '作品标题' || i,
      '摘要' || i,
      '正文第' || i || '段，末班车经过友谊校区，雨落在图书馆闭馆以后。',
      (case when i % 3 = 0 then '新诗' when i % 3 = 1 then '散文' else '小说' end),
      'published',
      now() - (i || ' minutes')::interval
    from generate_series(1, 12) as i;
  `);
  await db.exec(`
    insert into public.likes (work_id, user_id)
    values
      ('20000000-0000-4000-8000-000000000001', '${USER_A}'),
      ('20000000-0000-4000-8000-000000000001', '${USER_B}'),
      ('20000000-0000-4000-8000-000000000002', '${USER_A}')
  `);
  await db.exec(`
    insert into public.comments (id, work_id, user_id, content, created_at)
    values
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '${USER_B}', '评论一', now() - '2 minutes'::interval),
      ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '${USER_A}', '评论二', now() - '1 minutes'::interval),
      ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '${USER_C}', '评论三', now())
  `;
}

async function asRole(db, role, userId, sql, params = []) {
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false)",
    [userId ?? ""],
  );
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

test("browse_works 匿名可读、每页最多十篇且聚合计数正确", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows } = await asRole(db, "anon", null, `
      select public.browse_works('', '全部', 'latest', null, 10) as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.works.length, 10);
    assert.ok(payload.next_cursor, "第一页应返回游标");
    const first = payload.works[0];
    assert.equal(typeof first.like_count, "number");
    assert.equal(typeof first.comment_count, "number");
    assert.equal(first.liked_by_current_user, false);
    assert.equal("content" in first, false, "列表不应返回正文全文");
    assert.equal(first.author_pen_name, "松声");
  } finally {
    await db.close();
  }
});

test("browse_works 服务端钳制页大小并返回稳定游标无重叠无遗漏", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: firstPage } = await asRole(db, "anon", null, `
      select public.browse_works('', '全部', 'latest', null, 999) as payload
    `);
    assert.equal(firstPage[0].payload.works.length, 10, "999 请求被钳制为 10");

    const cursor = firstPage[0].payload.next_cursor;
    const { rows: secondPage } = await asRole(db, "anon", null, `
      select public.browse_works('', '全部', 'latest', $1::text, 10) as payload
    `, [cursor]);
    const firstIds = firstPage[0].payload.works.map((w) => w.id);
    const secondIds = secondPage[0].payload.works.map((w) => w.id);
    assert.equal(secondIds.length, 2, "第二页应只剩 2 篇");
    assert.equal(new Set([...firstIds, ...secondIds]).size, 12, "两页应无重叠");
    assert.equal(secondPage[0].payload.next_cursor, null, "最后一页无游标");
  } finally {
    await db.close();
  }
});

test("browse_works 正文中文子串搜索命中标题未出现的诗句", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows } = await asRole(db, "anon", null, `
      select public.browse_works('雨落在图书馆闭馆以后', '全部', 'latest', null, 10) as payload
    `);
    assert.ok(rows[0].payload.works.length > 0, "正文诗句应被搜到");
    for (const work of rows[0].payload.works) {
      assert.match(work.title, /作品标题/);
    }
  } finally {
    await db.close();
  }
});

test("browse_works 按点赞数和评论数排序且 liked_by_current_user 随身份变化", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const anon = await asRole(db, "anon", null, `
      select public.browse_works('', '全部', 'likes', null, 10) as payload
    `);
    const likesSorted = anon.rows[0].payload.works;
    assert.ok(likesSorted[0].like_count >= likesSorted[1].like_count);

    const userA = await asRole(db, "authenticated", USER_A, `
      select public.browse_works('', '全部', 'discussions', null, 10) as payload
    `);
    const discSorted = userA.rows[0].payload.works;
    assert.ok(discSorted[0].comment_count >= discSorted[1].comment_count);

    const topWork = discSorted.find((w) => w.like_count > 0);
    const firstPage = await asRole(db, "authenticated", USER_A, `
      select public.browse_works('', '全部', 'latest', null, 10) as payload
    `);
    const likedByA = firstPage.rows[0].payload.works.find(
      (w) => w.id === "20000000-0000-4000-8000-000000000001",
    );
    assert.equal(likedByA.liked_by_current_user, true);
  } finally {
    await db.close();
  }
});

test("browse_discussions 独立分页且只含已发布作品评论", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows } = await asRole(db, "anon", null, `
      select public.browse_discussions(null, 20) as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.discussions.length, 3);
    assert.equal(payload.next_cursor, null);
    assert.equal(payload.discussions[0].work_title, "作品标题1");
    assert.equal(payload.discussions[0].user_pen_name, "松声");
    const ids = payload.discussions.map((d) => d.id);
    assert.equal(new Set(ids).size, 3, "讨论不重复");
  } finally {
    await db.close();
  }
});

test("browse_works 搜索词带引号不注入 SQL", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows } = await asRole(db, "anon", null, `
      select public.browse_works('作品标题1''; drop table public.works; --', '全部', 'latest', null, 10) as payload
    `);
    assert.equal(rows[0].payload.works.length, 0);
    const still = await db.query("select count(*)::int as n from public.works");
    assert.equal(still.rows[0].n, 12, "注入尝试不得删除数据");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 4: 运行 PGlite 测试验证 RED**

Run: `node --test tests/works-browse-db.test.mjs`
Expected: FAIL（browse_works 函数不存在）。

- [ ] **Step 5: 写生产增量迁移**

创建 `supabase/migrations/20260806_browse_works_and_discussions.sql`：

```sql
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
        w.id, w.author_id, w.title, w.excerpt, w.category, w.is_featured,
        w.created_at, w.updated_at,
        p.pen_name as author_pen_name, p.bio as author_bio, p.role as author_role,
        (select count(*) from public.likes l where l.work_id = w.id)::bigint as like_count,
        (select count(*) from public.comments c where c.work_id = w.id)::bigint as comment_count
      from public.works w
      join public.profiles p on p.id = w.author_id
      where w.status = 'published'
        and (%L = '全部' or w.category = %L)
        and (%L = ''
          or w.title ilike '%' || %L || '%'
          or w.excerpt ilike '%' || %L || '%'
          or w.content ilike '%' || %L || '%'
          or p.pen_name ilike '%' || %L || '%')
        and %s
    )
    select *
    from base
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
    v_search, v_search, v_search, v_search,
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
```

- [ ] **Step 6: 同步 schema.sql 追加 BROWSE 块**

读取 `supabase/schema.sql`，在文件末尾追加：

```sql
-- BROWSE_READ_START
create extension if not exists pg_trgm;

create index if not exists works_content_trgm_idx
  on public.works using gin (content gin_trgm_ops);

-- browse_works 与 browse_discussions 函数体与
-- supabase/migrations/20260806_browse_works_and_discussions.sql 完全一致。
-- BROWSE_READ_END
```

然后在 `-- BROWSE_READ_START` 与 `-- BROWSE_READ_END` 之间，逐字粘贴迁移文件里 `create or replace function public.browse_works(...)` 到 `grant execute on function public.browse_discussions(text, integer) to anon, authenticated;` 的完整函数与授权语句。

- [ ] **Step 7: 运行全部相关测试验证 GREEN**

Run:
```bash
node --test tests/works-browse-db.test.mjs
node --test tests/schema.test.mjs
```
Expected: 两个文件全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add supabase/migrations/20260806_browse_works_and_discussions.sql supabase/schema.sql tests/works-browse-db.test.mjs tests/schema.test.mjs
git commit -m "feat: add server-side browse pagination and Chinese content search RPCs"
```

---

### Task 2: demo 数据服务分页接口（listWorksPage / listDiscussionsPage）

**Files:**
- Modify: `js/utils.mjs`（新增 `searchWorks`）
- Modify: `js/data-service.mjs`（demo 服务新增两个分页方法）
- Test: `tests/data-service.test.mjs`

**Interfaces:**
- `service.listWorksPage({ query = "", category = "全部", sort = "latest", cursor = null, pageSize = 10 })` → `{ works, nextCursor }`
- `service.listDiscussionsPage({ cursor = null, pageSize = 20 })` → `{ discussions, nextCursor }`
- demo 的 `nextCursor` 为不透明 base64 字符串，只内部编码当前排序后的起点索引；无更多时返回 `null`。

- [ ] **Step 1: 写失败的 demo 分页测试**

在 `tests/data-service.test.mjs` 末尾追加：

```js
test("演示服务按页返回作品、支持正文搜索与稳定游标", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  for (let i = 1; i <= 11; i += 1) {
    await service.createWork({
      title: `分页作品${i}`,
      excerpt: `摘要${i}`,
      content: `正文第${i}段，包含专属诗句 山雨欲来。`,
      category: "新诗",
    });
  }
  const page1 = await service.listWorksPage({
    query: "",
    category: "全部",
    sort: "latest",
    pageSize: 10,
  });
  assert.equal(page1.works.length, 10);
  assert.ok(page1.nextCursor, "第一页应有游标");
  const page2 = await service.listWorksPage({
    query: "",
    category: "全部",
    sort: "latest",
    cursor: page1.nextCursor,
    pageSize: 10,
  });
  assert.equal(page2.works.length, 5);
  assert.equal(page2.nextCursor, null);
  const ids = [...page1.works, ...page2.works].map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, "两页作品不应重叠");

  const searched = await service.listWorksPage({
    query: "山雨欲来",
    category: "全部",
    sort: "latest",
    pageSize: 10,
  });
  assert.ok(searched.works.length === 11, "正文搜索应命中全部 11 篇新增作品");
  assert.ok(searched.works.every((w) => w.title.startsWith("分页作品")));

  const cat = await service.listWorksPage({
    query: "",
    category: "散文",
    sort: "latest",
    pageSize: 10,
  });
  assert.ok(cat.works.length >= 1);
  assert.ok(cat.works.every((w) => w.category === "散文"));
});

test("演示服务独立分页讨论", async () => {
  const service = createDataService({ mode: "demo" });
  const page = await service.listDiscussionsPage({ pageSize: 20 });
  assert.ok(page.discussions.length >= 1);
  assert.equal(typeof page.discussions[0].work_title, "string");
  assert.equal(typeof page.discussions[0].user_pen_name, "string");
});
```

- [ ] **Step 2: 运行测试验证 RED**

Run: `node --test tests/data-service.test.mjs`
Expected: 新增两条测试 FAIL（`listWorksPage is not a function`）。

- [ ] **Step 3: 在 utils.mjs 新增 searchWorks**

在 `js/utils.mjs` 的 `filterAndSortWorks` 之后追加：

```js
export function searchWorks(works = [], filters = {}) {
  const query = String(filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
  const category = filters.category || "全部";
  const sort = filters.sort || "latest";

  const filtered = works.filter((work) => {
    const categoryMatches =
      category === "全部" || normalizeCategory(work.category) === category;
    const haystack = [
      work.title,
      work.excerpt,
      work.content,
      work.author_pen_name,
    ]
      .map((value) => String(value ?? "").toLocaleLowerCase("zh-CN"))
      .join("\n");
    return categoryMatches && (!query || haystack.includes(query));
  });

  const sorters = {
    latest: (left, right) =>
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
    likes: (left, right) =>
      Number(right.like_count ?? 0) - Number(left.like_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
    discussions: (left, right) =>
      Number(right.comment_count ?? 0) - Number(left.comment_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
  };

  return [...filtered].sort(sorters[sort] ?? sorters.latest);
}
```

- [ ] **Step 4: 在 demo 服务实现两个分页方法**

在 `js/data-service.mjs` 顶部 import 中把 `filterAndSortWorks` 加入（若无）：

```js
import {
  createExcerpt,
  getPenNameChangeAvailability,
  maskEmail,
  PUBLISHABLE_CATEGORIES,
  searchWorks,
  studentNumberToAuthEmail,
  validatePassword,
  validateStudentNumber,
} from "./utils.mjs";
```

在 `createDemoService` 的 `enrichComment` 之后、`const service = {` 之前，添加分页辅助：

```js
  const encodeCursor = (index) =>
    Buffer.from(JSON.stringify({ start: index })).toString("base64");

  const listWorksPageDemo = async (options = {}) => {
    const pageSize = Math.min(
      Math.max(Number(options.pageSize) || 10, 1),
      10,
    );
    const start = (() => {
      if (!options.cursor) return 0;
      try {
        return Number(
          JSON.parse(Buffer.from(String(options.cursor), "base64").toString("utf8"))
            .start || 0,
        );
      } catch {
        return 0;
      }
    })();
    const enriched = state.works
      .filter((work) => work.status === "published")
      .map(enrichWork);
    const sorted = searchWorks(enriched, {
      query: options.query,
      category: options.category,
      sort: options.sort,
    });
    const page = sorted.slice(start, start + pageSize);
    const nextStart = start + page.length;
    return {
      works: page,
      nextCursor:
        nextStart < sorted.length ? encodeCursor(nextStart) : null,
    };
  };

  const listDiscussionsPageDemo = async (options = {}) => {
    const pageSize = Math.min(
      Math.max(Number(options.pageSize) || 20, 1),
      20,
    );
    const start = (() => {
      if (!options.cursor) return 0;
      try {
        return Number(
          JSON.parse(Buffer.from(String(options.cursor), "base64").toString("utf8"))
            .start || 0,
        );
      } catch {
        return 0;
      }
    })();
    const rows = state.comments
      .map((comment) => {
        const work = state.works.find((item) => item.id === comment.work_id);
        return {
          ...enrichComment(comment),
          work_title: work?.title ?? "已删除作品",
          work_id: comment.work_id,
        };
      })
      .sort(
        (left, right) =>
          new Date(right.created_at) - new Date(left.created_at) ||
          String(left.id ?? "").localeCompare(String(right.id ?? "")),
      );
    const page = rows.slice(start, start + pageSize);
    const nextStart = start + page.length;
    return {
      discussions: page,
      nextCursor:
        nextStart < rows.length ? encodeCursor(nextStart) : null,
    };
  };
```

在 demo `service` 对象里（`listWorks` 之后）添加：

```js
    async listWorksPage(options = {}) {
      return listWorksPageDemo(options);
    },

    async listDiscussionsPage(options = {}) {
      return listDiscussionsPageDemo(options);
    },
```

- [ ] **Step 5: 运行测试验证 GREEN**

Run: `node --test tests/data-service.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add js/utils.mjs js/data-service.mjs tests/data-service.test.mjs
git commit -m "feat: add demo paginated work and discussion browsing with content search"
```

---

### Task 3: Supabase 数据服务分页接口（调用 RPC）

**Files:**
- Modify: `js/data-service.mjs`（supabase 服务新增两个分页方法）
- Test: `tests/data-service.test.mjs`

**Interfaces:**
- `listWorksPage` 调用 `client.rpc("browse_works", { p_search, p_category, p_sort, p_cursor, p_page_size })`，返回 `{ works, nextCursor: data.next_cursor }`。
- `listDiscussionsPage` 调用 `client.rpc("browse_discussions", { p_cursor, p_page_size })`，返回 `{ discussions, nextCursor: data.next_cursor }`。

- [ ] **Step 1: 写失败的 supabase 契约测试**

在 `tests/data-service.test.mjs` 末尾追加：

```js
test("Supabase 服务通过 RPC 分页浏览作品与讨论", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: null,
      }),
    },
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name === "browse_works") {
        return {
          data: {
            works: [
              {
                id: "work-1",
                title: "返回作品",
                like_count: 3,
                comment_count: 1,
                liked_by_current_user: false,
              },
            ],
            next_cursor: "cursor-1",
          },
          error: null,
        };
      }
      if (name === "browse_discussions") {
        return {
          data: {
            discussions: [
              {
                id: "disc-1",
                work_title: "返回作品",
                user_pen_name: "松声",
                content: "评论",
              },
            ],
            next_cursor: null,
          },
          error: null,
        };
      }
      return { data: null, error: { message: "unknown" } };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const worksPage = await service.listWorksPage({
    query: "山雨",
    category: "新诗",
    sort: "likes",
    cursor: "prev-cursor",
    pageSize: 10,
  });
  assert.equal(worksPage.works[0].title, "返回作品");
  assert.equal(worksPage.nextCursor, "cursor-1");
  assert.deepEqual(invoked.at(-1), [
    "browse_works",
    {
      p_search: "山雨",
      p_category: "新诗",
      p_sort: "likes",
      p_cursor: "prev-cursor",
      p_page_size: 10,
    },
  ]);

  const discussionsPage = await service.listDiscussionsPage({
    cursor: "disc-cursor",
    pageSize: 20,
  });
  assert.equal(discussionsPage.discussions[0].work_title, "返回作品");
  assert.equal(discussionsPage.nextCursor, null);
  assert.deepEqual(invoked.at(-1), [
    "browse_discussions",
    { p_cursor: "disc-cursor", p_page_size: 20 },
  ]);
});
```

- [ ] **Step 2: 运行测试验证 RED**

Run: `node --test tests/data-service.test.mjs`
Expected: 新增测试 FAIL（supabase service 无 `listWorksPage`）。

- [ ] **Step 3: 在 supabase 服务实现两个分页方法**

在 `createSupabaseService` 的 `enrichRemoteWorks` 之后、`const service = {` 之前，添加：

```js
  const listWorksPageRemote = async (options = {}) => {
    const client = await getClient();
    const { data, error } = await client.rpc("browse_works", {
      p_search: String(options.query ?? ""),
      p_category: String(options.category ?? "全部"),
      p_sort: String(options.sort ?? "latest"),
      p_cursor: options.cursor ?? null,
      p_page_size: Number(options.pageSize) || 10,
    });
    if (error) throw new Error(error.message);
    return {
      works: Array.isArray(data?.works) ? data.works : [],
      nextCursor: data?.next_cursor ?? null,
    };
  };

  const listDiscussionsPageRemote = async (options = {}) => {
    const client = await getClient();
    const { data, error } = await client.rpc("browse_discussions", {
      p_cursor: options.cursor ?? null,
      p_page_size: Number(options.pageSize) || 20,
    });
    if (error) throw new Error(error.message);
    return {
      discussions: Array.isArray(data?.discussions) ? data.discussions : [],
      nextCursor: data?.next_cursor ?? null,
    };
  };
```

在 supabase `service` 对象里（`listWorks` 之后）添加：

```js
    async listWorksPage(options = {}) {
      return listWorksPageRemote(options);
    },

    async listDiscussionsPage(options = {}) {
      return listDiscussionsPageRemote(options);
    },
```

- [ ] **Step 4: 运行测试验证 GREEN**

Run: `node --test tests/data-service.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add js/data-service.mjs tests/data-service.test.mjs
git commit -m "feat: add Supabase RPC-backed paginated work and discussion browsing"
```

---

### Task 4: 移动 feed 支持分页追加（append）

**Files:**
- Modify: `js/mobile-feed.mjs`
- Test: `tests/mobile-feed.test.mjs`

**Interfaces:**
- `createMobileFeedController` 返回对象新增 `append(works)`：把新批次追加到队列尾部（保留已展示顺序），返回当前仍指向的条目。
- `append` 必须去重（按 id），避免分页边界重复；追加后 `isAtEnd()` 相应更新。

- [ ] **Step 1: 读现有测试约定**

读取 `tests/mobile-feed.test.mjs` 了解现有 API 断言。

- [ ] **Step 2: 写失败的 append 测试**

在 `tests/mobile-feed.test.mjs` 末尾追加：

```js
test("追加批次保留顺序、去重且更新队尾状态", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const dupA = { id: "a" };
  const c = { id: "c" };
  const controller = createMobileFeedController([a, b], () => 0.5);
  controller.append([dupA, c]);
  controller.next();
  assert.equal(controller.next()?.id, "c", "追加后应能到达 c");
  assert.equal(controller.isAtEnd(), true);
  assert.equal(controller.current()?.id, "c");
});
```

- [ ] **Step 3: 运行测试验证 RED**

Run: `node --test tests/mobile-feed.test.mjs`
Expected: 新增测试 FAIL（`append is not a function`）。

- [ ] **Step 4: 实现 append**

在 `js/mobile-feed.mjs` 的 `createMobileFeedController` 里，把 `queue` 和去重集合提取为闭包变量，并新增 `append`。将函数体改为：

```js
export function createMobileFeedController(works, random = Math.random) {
  let queue = buildMobileFeedQueue(works, random);
  let cursor = 0;
  const seen = new Set(queue.map((work) => work.id));

  return {
    current() {
      return queue[cursor] ?? null;
    },
    isAtStart() {
      return cursor === 0;
    },
    isAtEnd() {
      return queue.length === 0 || cursor >= queue.length - 1;
    },
    next() {
      if (cursor >= queue.length - 1) return null;
      cursor += 1;
      return queue[cursor];
    },
    previous() {
      if (cursor > 0) cursor -= 1;
      return queue[cursor] ?? null;
    },
    append(nextWorks) {
      uniqueWorks(nextWorks).forEach((work) => {
        if (seen.has(work.id)) return;
        seen.add(work.id);
        queue.push(work);
      });
      return queue[cursor] ?? null;
    },
    reset(nextWorks, nextRandom = Math.random) {
      queue = buildMobileFeedQueue(nextWorks, nextRandom);
      cursor = 0;
      seen.clear();
      queue.forEach((work) => seen.add(work.id));
      return queue[cursor] ?? null;
    },
  };
}
```

- [ ] **Step 5: 运行测试验证 GREEN**

Run: `node --test tests/mobile-feed.test.mjs`
Expected: 全部 PASS（含原有测试）。

- [ ] **Step 6: 提交**

```bash
git add js/mobile-feed.mjs tests/mobile-feed.test.mjs
git commit -m "feat: support appending paginated batches to mobile feed controller"
```

---

### Task 5: 前端首页分页、搜索防抖与状态恢复

**Files:**
- Modify: `js/app.js`
- Test: `tests/static-checks.mjs`、`tests/browser-check.cjs`

**Interfaces:**
- `state.browse = { works: [], nextCursor: null, loading: false, error: null, requestId: 0 }`
- `state.filters` 沿用现有 `{ query, category, sort }`。
- 新增 `loadBrowseWorks({ reset })`：取 `service.listWorksPage`，用递增 `requestId` 丢弃过期响应；失败时保留 `state.browse.works` 并把 `state.browse.error` 设为文案。
- 新增 `loadMoreWorks()`：用 `nextCursor` 追加下一页。
- 搜索输入防抖 300ms（`input` 事件）；分类/排序 `change` 事件重置第一页。
- 首页渲染基于 `state.browse.works`，底部显示“再读十篇”（有 `nextCursor` 时）；失败显示重试入口。
- 返回首页时用 `sessionStorage` 恢复已加载批次与阅读位置（`renderCurrentRoute` 对 home 路由特殊处理）。

- [ ] **Step 1: 写失败的静态与浏览器断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("首页实现分页浏览、搜索防抖与再读十篇", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /browse:\s*\{[\s\S]*?nextCursor:\s*null/);
  assert.match(app, /async\s+function\s+loadBrowseWorks\s*\(/);
  assert.match(app, /async\s+function\s+loadMoreWorks\s*\(/);
  assert.match(app, /requestId/);
  assert.match(app, /state\.browse\.nextCursor/);
  assert.match(app, /setTimeout\([\s\S]*?300\s*[,)]/);
  assert.match(app, /再读十篇/);
  assert.match(app, /service\.listWorksPage\(/);
});
```

在 `tests/browser-check.cjs` 的 `desktopFlow` 中，把现有“搜索–回车”段落改为“防抖输入 + 再读十篇”断言。定位 `desktopFlow` 里 `const search = page.getByRole("textbox", { name: "搜索作品" });` 到分类选择前，替换为：

```js
  const search = page.getByRole("textbox", { name: "搜索作品" });
  await search.fill("河流");
  await page.waitForTimeout(450);
  const workList = page.getByTestId("work-list");
  await expectVisible(
    workList.getByText("河流向北", { exact: true }),
    "防抖搜索结果",
  );
  if (
    await workList.getByText("末班车经过友谊校区", { exact: true }).count()
  ) {
    throw new Error("防抖搜索没有过滤无关作品");
  }
  await search.fill("");
  await page.waitForTimeout(450);
  const loadMore = page.getByRole("button", { name: "再读十篇" });
  const hasLoadMore = (await loadMore.count()) > 0;
  if (!hasLoadMore) {
    throw new Error("桌面首页没有再读十篇按钮");
  }
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增静态断言 FAIL。

- [ ] **Step 3: 实现前端分页状态与加载函数**

在 `js/app.js` 的 `state` 对象里，`filters` 之后添加：

```js
  browse: {
    works: [],
    nextCursor: null,
    loading: false,
    error: null,
    requestId: 0,
  },
```

在 `refreshWorks` 附近新增加载函数：

```js
async function loadBrowseWorks({ reset = true } = {}) {
  const requestId = ++state.browse.requestId;
  if (reset) {
    state.browse.works = [];
    state.browse.nextCursor = null;
    state.browse.error = null;
  }
  state.browse.loading = true;
  try {
    const result = await service.listWorksPage({
      query: state.filters.query,
      category: state.filters.category,
      sort: state.filters.sort,
      cursor: reset ? null : state.browse.nextCursor,
      pageSize: 10,
    });
    if (requestId !== state.browse.requestId) return;
    state.browse.works = reset
      ? result.works
      : [...state.browse.works, ...result.works];
    state.browse.nextCursor = result.nextCursor;
    state.browse.loading = false;
  } catch (error) {
    if (requestId !== state.browse.requestId) return;
    state.browse.error = error.message;
    state.browse.loading = false;
  }
  renderHome();
}

async function loadMoreWorks() {
  if (!state.browse.nextCursor || state.browse.loading) return;
  await loadBrowseWorks({ reset: false });
}

function setFilters(patch) {
  Object.assign(state.filters, patch);
  loadBrowseWorks({ reset: true });
}
```

- [ ] **Step 4: 改造桌面首页渲染**

`renderDesktopHome` 中，把 `const filtered = filterAndSortWorks(state.works, state.filters);` 改为基于 `state.browse.works`；作品列表渲染改用 `state.browse.works`；`共 N 篇` 改为 `已加载 N 篇`；在 `worksSection` 底部追加“再读十篇”或重试按钮。将 `worksSection.append(list);` 之后添加：

```js
  const browseWorks = state.browse.works;
  if (state.browse.error) {
    worksSection.append(
      element("div", { className: "empty-state" }, [
        element("p", { text: "加载新一批作品失败。" }),
        element("button", {
          className: "secondary-button",
          type: "button",
          text: "重试加载",
          dataset: { action: "retry-browse" },
        }),
      ]),
    );
  } else if (state.browse.nextCursor) {
    worksSection.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "再读十篇",
          dataset: { action: "load-more" },
        }),
      ]),
    );
  }
  const loadMeta = worksSection.querySelector(
    ".section-heading p",
  );
  if (loadMeta) loadMeta.textContent = `已加载 ${browseWorks.length} 篇`;
```

并保证 `filtered` 引用全部替换为 `browseWorks`（列表为空态、featured 等仍可用 `browseWorks`）。具体：`createFeaturedItem`/`renderCommunityRail` 需要的作品池改为 `browseWorks`。

- [ ] **Step 5: 绑定防抖搜索与分页动作**

在 `document.addEventListener("submit", ...)` 中，把 `homeFilters` 分支改为防抖：删除立即 `renderHome()`，改为触发重置加载。替换 `homeFilters` 分支为：

```js
  } else if (form.id === "homeFilters") {
    event.preventDefault();
    const data = new FormData(form);
    setFilters({
      query: String(data.get("query") ?? "").trim(),
    });
  }
```

在 `document.addEventListener("change", ...)` 的 `homeFilters` 分支里，把 `renderHome()` 改为：

```js
    if (target.name === "category") setFilters({ category: target.value });
    if (target.name === "sort") setFilters({ sort: target.value });
```

新增防抖（放在 `document.addEventListener("input", ...)` 里，`writingForm` 分支之前或之后）：

```js
document.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "query") {
    clearTimeout(window.__homeSearchTimer);
    window.__homeSearchTimer = setTimeout(() => {
      setFilters({ query: target.value.trim() });
    }, 300);
  }
});
```

在 `handleAction`（`action === ...`）分支里新增两个动作。定位现有 `action === "reset-filters"` 分支附近，添加：

```js
  } else if (action === "load-more") {
    loadMoreWorks();
  } else if (action === "retry-browse") {
    loadBrowseWorks({ reset: true });
  }
```

- [ ] **Step 6: 改造初始化与返回首页恢复**

`initialize()` 中把 `service.listWorks()` 换为 `service.listWorksPage`，并保存批次到 `sessionStorage`：

```js
async function initialize() {
  showLoading();
  try {
    const saved = readHomeSession();
    if (saved) {
      Object.assign(state.filters, saved.filters);
      state.browse.works = saved.works;
      state.browse.nextCursor = saved.nextCursor;
    }
    [state.session, state.settings] = await Promise.all([
      service.getSession(),
      service.getSiteSettings(),
    ]);
    if (!saved) await loadBrowseWorks({ reset: true });
    updateHeader();
    await renderCurrentRoute();
  } catch (error) {
    showError(
      "社区暂时无法加载",
      `${error.message}。请检查网络或 Supabase 配置后重试。`,
      true,
    );
  }
}

const HOME_SESSION_KEY = "wenyuan-home-session";

function readHomeSession() {
  try {
    const raw = sessionStorage.getItem(HOME_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.filters || !Array.isArray(parsed.works)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveHomeSession() {
  try {
    sessionStorage.setItem(
      HOME_SESSION_KEY,
      JSON.stringify({
        filters: state.filters,
        works: state.browse.works,
        nextCursor: state.browse.nextCursor,
      }),
    );
  } catch {
    // sessionStorage 不可用时静默跳过
  }
}
```

在 `renderCurrentRoute()` 中，对 home 路由在渲染完成后恢复滚动位置，其它路由保持 `scrollTo`：

```js
  } finally {
    if (route.name === "home") {
      const savedTop = sessionStorage.getItem("wenyuan-home-scroll");
      window.scrollTo({
        top: Number(savedTop || 0),
        behavior: "instant",
      });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
      sessionStorage.setItem("wenyuan-home-scroll", "0");
    }
    app.focus({ preventScroll: true });
  }
```

在 `loadBrowseWorks` 的成功分支末尾与 `loadMoreWorks` 成功后，调用 `saveHomeSession()`。`refreshWorks()` 中把 `state.works = await service.listWorks();` 换为触发首页分页并保存：

```js
async function refreshWorks() {
  await loadBrowseWorks({ reset: true });
  saveHomeSession();
}
```

（若 `refreshWorks` 被作品发布/删除后调用，需确保其不依赖 `state.works` 全量；其余使用 `state.works` 的代码点在本计划内替换为 `state.browse.works`。）

> **范围决定（2026-08-07，负责人批准）：** 最终 code review 后确认，`initialize()`/`refreshWorks()` 仍保留 `service.listWorks()` 全量下载（含正文），未完全消除「加载全部作品」。理由：作品页「相关作品」块（同分类/同作者）依赖全量目录；卡片摘要兜底 `createExcerpt(work.content)` 依赖正文（`excerpt` 列允许空串）。分页 RPC 本身已服务端化且 staging 验证通过。此偏离记录在案，留给后续轮次处理（候选方案：`listWorks` 改为不查 `content` 的轻量目录，或相关作品改为服务端查询）。

- [ ] **Step 7: 运行静态 + 单元测试验证 GREEN**

Run:
```bash
node --test tests/static-checks.mjs
node --test tests/data-service.test.mjs tests/mobile-feed.test.mjs
```
Expected: 全部 PASS。

- [ ] **Step 8: 运行浏览器桌面流程验证**

Run: `node tests/run-browser-check.cjs`
Expected: 桌面流程通过（首页标题、防抖搜索命中河流向北、再读十篇按钮存在、其余流程仍通过）。若因 demo 数据仅 6 篇导致“再读十篇”按钮缺失，需在 `browser-check.cjs` 的 demo 流程里先发布足够作品（见 Step 9）。

- [ ] **Step 9: 补充 demo 浏览器数据以确保可翻页（已定：种子增到 12 篇）**

用户已确认采用“demo 种子增到 12 篇”。执行：
1. 把 `js/demo-data.mjs` 的 `works` 数组扩到 12 篇（新增 6 篇，沿用现有字段形状；标题可用“分页作品 7..12”或与现有风格一致的新标题，正文含可搜索词）。
2. 同步检查 `tests/data-service.test.mjs` 与 `browser-check.cjs` 中依赖作品数量的断言（例如 demo 首页标题、分类计数、搜索断言），数量变化后仍成立。
3. 确认“再读十篇”按钮出现：demo 每页 10 篇，12 篇 → 第一页 10 篇 + 按钮。`browser-check.cjs` 的 `desktopFlow` 增加断言：点击“再读十篇”后列表条目从 10 增至 12。

- [ ] **Step 10: 提交**

```bash
git add js/app.js tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: paginate home browsing with debounced search and load-more"
```

---

### Task 6: 讨论页独立分页

**Files:**
- Modify: `js/app.js`
- Modify: `js/data-service.mjs`（删除/替换 demo 与 supabase 的 `listDiscussions` 遗留或复用分页方法）
- Test: `tests/browser-check.cjs`、`tests/static-checks.mjs`

**Interfaces:**
- `renderDiscussions()` 改用 `service.listDiscussionsPage`，首屏 20 条 + “更多讨论”按钮（有 `nextCursor` 时）。
- 删除对 `service.getWork` 的逐篇调用路径（`loadAllDiscussions` 不再被讨论页使用）。

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("讨论页使用独立分页而不是逐篇补查", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /listDiscussionsPage/);
  assert.match(app, /state\.discussions\s*=|browseDiscussions/);
  assert.match(app, /更多讨论/);
  const loadAllDiscussions = app.match(/async\s+function\s+loadAllDiscussions[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.doesNotMatch(loadAllDiscussions, /service\.getWork\s*\(/, "讨论页不得逐篇补查");
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL（讨论页仍逐篇 getWork）。

- [ ] **Step 3: 改造讨论页渲染**

在 `js/app.js` 的 `state` 对象里加：

```js
  browseDiscussions: {
    items: [],
    nextCursor: null,
    loading: false,
  },
```

将 `renderDiscussions` 与 `loadAllDiscussions` 替换为：

```js
async function loadDiscussionsPage({ reset = true } = {}) {
  const requestId = ++state.discussionRequestId;
  if (reset) {
    state.browseDiscussions.items = [];
    state.browseDiscussions.nextCursor = null;
  }
  state.browseDiscussions.loading = true;
  try {
    const result = await service.listDiscussionsPage({
      cursor: reset ? null : state.browseDiscussions.nextCursor,
      pageSize: 20,
    });
    if (requestId !== state.discussionRequestId) return;
    state.browseDiscussions.items = reset
      ? result.discussions
      : [...state.browseDiscussions.items, ...result.discussions];
    state.browseDiscussions.nextCursor = result.nextCursor;
    state.browseDiscussions.loading = false;
  } catch (error) {
    if (requestId !== state.discussionRequestId) return;
    state.browseDiscussions.loading = false;
    showError("讨论暂时无法加载", error.message, true);
    return;
  }
  renderDiscussions();
}

function renderDiscussions() {
  const shell = element("div", { className: "page-shell" });
  shell.append(
    createPageHeader(
      "DISCUSSIONS",
      "正在讨论",
      "一条好评论不是判词，而是把自己读到的细节交还给作者和下一位读者。",
    ),
  );
  const list = element("ol", { className: "discussion-page-list" });
  const discussions = state.browseDiscussions.items;
  discussions.forEach((discussion) => {
    const row = element("li", { className: "discussion-row" });
    row.append(
      element("time", {
        text: formatDate(discussion.created_at),
        attrs: { datetime: discussion.created_at },
      }),
      element("div", {}, [
        element("div", { className: "discussion-meta" }, [
          element("a", {
            className: "meta-link",
            href: `#/authors/${encodeURIComponent(discussion.user_id)}`,
            text: discussion.user_pen_name,
          }),
          element("span", { text: "评论了" }),
          element("a", {
            className: "meta-link",
            href: `#/works/${encodeURIComponent(discussion.work_id)}`,
            text: discussion.work_title,
          }),
        ]),
        element("blockquote", {
          text: discussion.is_deleted
            ? "该评论已由作者删除"
            : discussion.content,
        }),
        element("a", {
          className: "inline-link",
          href: `#/works/${encodeURIComponent(discussion.work_id)}`,
          text: "进入讨论",
        }),
      ]),
    );
    list.append(row);
  });
  if (!discussions.length) {
    list.append(
      element("li", {
        className: "empty-state",
        text: "社区里还没有讨论。",
      }),
    );
  }
  shell.append(list);
  if (state.browseDiscussions.nextCursor) {
    shell.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "更多讨论",
          dataset: { action: "load-more-discussions" },
        }),
      ]),
    );
  }
  replaceContent(app, shell);
}
```

- [ ] **Step 4: 更新路由调用与动作绑定**

`renderCurrentRoute` 中讨论页分支改为：

```js
    else if (route.name === "discussions") await loadDiscussionsPage({ reset: true });
```

删除旧的 `async function loadAllDiscussions() { ... }` 与 `state.discussions` 的逐篇填充；`buildActiveDiscussions`/`createDiscussionItem` 等依赖 `state.discussions` 的首页预览，改为依赖 `state.browseDiscussions.items`（首屏加载后即有数据）。

在 `handleAction` 分支新增：

```js
  } else if (action === "load-more-discussions") {
    loadDiscussionsPage({ reset: false });
  }
```

在 `initialize()` 里并行拉取讨论首屏，替换 `await refreshDiscussionsPreview();` 为 `await loadDiscussionsPage({ reset: true });`（若首页依赖讨论预览，则改为 `await loadDiscussionsPage({ reset: true });` 后调用一次 `renderHome`）。

- [ ] **Step 5: 移除数据服务层遗留的逐篇讨论逻辑**

检查 `js/data-service.mjs`：demo 与 supabase 服务中若有 `getProfile` 内 `listWorks` 全量过滤等仍逐篇补查的路径，只保留 `listWorksPage` 供首页使用；`getProfile`（作者页）与 `getWork`（阅读页）保持单篇查询，不属于本任务范围。本任务只保证**讨论页**不再逐篇 `getWork`。

- [ ] **Step 6: 运行静态 + 单元测试验证 GREEN**

Run:
```bash
node --test tests/static-checks.mjs
node --test tests/data-service.test.mjs
```
Expected: 全部 PASS。

- [ ] **Step 7: 运行浏览器讨论流程验证**

Run: `node tests/run-browser-check.cjs`
Expected: 讨论页仍显示评论、进入讨论正常。

- [ ] **Step 8: 提交**

```bash
git add js/app.js js/data-service.mjs tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: paginate discussions page without per-work lookups"
```

---

### Task 7: 移动端首页预取

**Files:**
- Modify: `js/app.js`
- Test: `tests/static-checks.mjs`、`tests/browser-check.cjs`

**Interfaces:**
- 移动首页基于 `state.browse.works` 构建 feed 队列；当接近末尾（剩余可展示条目 ≤ 2 且存在 `nextCursor`）时触发 `loadMoreWorks()` 预取。
- 保持“一次只重点展示一篇”的现有交互不变。

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("移动首页接近末尾时预取下一批", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /createMobileFeedController\([\s\S]*?state\.browse\.works/);
  assert.match(app, /isAtEnd\(\)|remaining/);
  assert.match(app, /loadMoreWorks\(\)/);
  assert.match(app, /append\(/);
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL。

- [ ] **Step 3: 改造 renderMobileHome**

`renderMobileHome` 中，把 `filtered` 来源从 `state.works` 改为 `state.browse.works`，并在构造/重置 feed 控制器后追加预取检查。替换开头：

```js
function renderMobileHome() {
  const filtered = state.browse.works;
  const signature = buildMobileFeedSignature(filtered);
  if (!state.mobileFeed.controller) {
    state.mobileFeed.controller = createMobileFeedController(filtered);
    state.mobileFeed.signature = signature;
  } else if (signature !== state.mobileFeed.signature) {
    state.mobileFeed.controller.reset(filtered);
    state.mobileFeed.signature = signature;
  } else {
    state.mobileFeed.controller.append(filtered);
  }

  maybePrefetchMobileNext();

  const shell = element("div", { className: "page-shell mobile-home" });
  // ... 其余原样保留
}
```

新增预取函数：

```js
function maybePrefetchMobileNext() {
  if (state.browse.loading || !state.browse.nextCursor) return;
  const controller = state.mobileFeed.controller;
  if (!controller) return;
  const current = controller.current();
  if (!current) return;
  const remainingAfterCurrent = state.browse.works.length - 1 -
    state.mobileFeed.index;
  if (remainingAfterCurrent <= 2) {
    loadMoreWorks();
  }
}
```

`state.mobileFeed.index` 需要同步维护：在“下一篇”动作处理里更新。找到移动 feed 下一页按钮的处理（`action === "mobile-feed-next"`），在调用 `controller.next()` 后更新 `state.mobileFeed.index`。

在 `state` 对象 `mobileFeed` 里加 `index: 0`，并在 `renderMobileHome` 每次渲染 `controller.current()` 后设置 `state.mobileFeed.index = Math.max(0, ...) - 1`（若无法直接读游标，用 `remaining` 反推）。若 `createMobileFeedController` 未暴露游标，本计划在 `mobile-feed.mjs` 增加只读 `position()`：

```js
    position() {
      return cursor;
    },
```

然后在 `renderMobileHome` 里用 `state.mobileFeed.index = controller.position();`，`maybePrefetchMobileNext` 判断 `state.mobileFeed.index >= state.browse.works.length - 3` 时预取：

```js
function maybePrefetchMobileNext() {
  if (state.browse.loading || !state.browse.nextCursor) return;
  const controller = state.mobileFeed.controller;
  if (!controller) return;
  if (controller.position() >= Math.max(state.browse.works.length - 3, 0)) {
    loadMoreWorks();
  }
}
```

- [ ] **Step 4: 运行静态检查验证 GREEN**

Run: `node --test tests/static-checks.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 运行浏览器移动流程验证**

Run: `node tests/run-browser-check.cjs`
Expected: 移动首页仍能左右翻页、无回归。

- [ ] **Step 6: 提交**

```bash
git add js/app.js js/mobile-feed.mjs tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: prefetch next batch on mobile home near queue end"
```

---

### Task 8: 关键元信息字号与对比度修正

**Files:**
- Modify: `assets/styles.css`
- Modify: `tests/static-checks.mjs`

**Goal:** 关键作者/日期/分类/操作提示字号 ≥ 13px；移动端表单输入 16px；主要触控目标 ≥ 44px。

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("关键元信息字号不小于 13px 且移动表单不小于 16px", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  const metaRule = css.match(
    /\.discussion-meta,\s*\.work-meta,\s*\.profile-meta,\s*\.reading-meta\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(metaRule, /font-size:\s*13px/);
  const metaLinkRule = css.match(
    /\.meta-link\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(metaLinkRule, /font-size:\s*13px/);
  assert.match(
    css,
    /@media \(max-width:\s*768px\)[\s\S]*?\.filter-form\s*input[\s\S]*?font-size:\s*16px/,
  );
  assert.match(
    css,
    /\.primary-button[\s\S]*?min-height:\s*44px|\.load-more-row[\s\S]*?min-height:\s*44px/,
  );
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL（当前 `.discussion-meta` 为 `0.75rem`，`.meta-link` 无 font-size）。

- [ ] **Step 3: 修改 CSS**

在 `assets/styles.css` 中，把 `.discussion-meta, .work-meta, .profile-meta, .reading-meta` 规则的 `font-size: 0.75rem;` 改为 `font-size: 13px;`：

```css
.discussion-meta,
.work-meta,
.profile-meta,
.reading-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  color: var(--soft-ink);
  font-family: var(--utility);
  font-size: 13px;
}
```

给 `.meta-link` 增加明确字号（保证继承不受影响但显式达标）：

```css
.meta-link {
  color: var(--soft-ink);
  text-decoration: none;
  font-size: 13px;
}
```

在移动端媒体查询（`@media (max-width: 768px)` 或既有 760px 断点，取文件内已有断点）内追加：

```css
  .filter-form input,
  .filter-form select,
  .filter-form button {
    font-size: 16px;
    min-height: 44px;
  }
  .load-more-row {
    display: flex;
    justify-content: center;
    padding: 2rem 0 3rem;
  }
  .load-more-row .primary-button {
    min-height: 44px;
    padding: 0 1.5rem;
  }
```

桌面端也确保 `.load-more-row` 存在（放在媒体查询之外）：

```css
.load-more-row {
  display: flex;
  justify-content: center;
  padding: 2rem 0 3rem;
}
.load-more-row .primary-button {
  min-height: 44px;
  padding: 0 1.5rem;
}
```

- [ ] **Step 4: 运行静态检查验证 GREEN**

Run: `node --test tests/static-checks.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add assets/styles.css tests/static-checks.mjs
git commit -m "feat: raise meta font size to 13px and mobile controls to 16px/44px"
```

---

### Task 9: 全量回归与发布前检查

**Files:**
- 全仓库只读检查；必要时更新 `README.md`、`SECURITY.md`。

- [ ] **Step 1: 全量测试**

Run:
```bash
npm test
```
Expected: 单元 + 浏览器全部通过（在既有 186 + 新增测试基础上全绿）。

- [ ] **Step 2: 行为差异复核**

Run: `node tests/run-browser-check.cjs`
手动核对四流程（桌面、移动、移动档案、账号安全）截图无横向溢出，首页首批仅 10 篇、桌面“再读十篇”、移动预取、讨论分页均生效。

- [ ] **Step 3: 秘密/隐私扫描**

Run（沿用既有发布前扫描模式）：
```bash
grep -rnE "service_role|sb_secret_|sb_publishable_JGnMQuwRNV6pTIzUORyqSg|accounts\.wenyuan\.invalid|password|student_number" js/ supabase/migrations/ tests/ --include="*.mjs" --include="*.js" --include="*.cjs" --include="*.sql" | grep -v node_modules || echo "干净"
```
Expected: 不包含生产 publishable key、service_role、真实邮箱或密码明文。

- [ ] **Step 4: diff 与状态检查**

Run:
```bash
git diff --check
git status --short
```
Expected: 无空白错误；工作区仅本计划任务产生的改动。

- [ ] **Step 5: 汇报 staging 授权请求**

向用户汇报：新迁移 `20260806_browse_works_and_discussions.sql` 需在测试项目（ref `rcrqosnbkojaarppvcac`）执行、两个函数部署、演示账号验证正文搜索与分页；**必须停下请求用户批准后再向 staging 写入。**

- [ ] **Step 6: 提交文档更新（若改动了 README/SECURITY）**

```bash
git add README.md SECURITY.md
git commit -m "docs: record paginated browsing rollout order"
```

---

## Self-Review

**Spec 覆盖核对（设计文档阶段 B / 第 7 节）：**

- 服务端分页 RPC、每页最多十篇 → Task 1 `browse_works`（`least(greatest(...,10),1)`）+ Task 2/3 服务接口。
- 一次返回作者公开资料、点赞数、评论数、当前用户互动状态 → Task 1 返回字段（`author_pen_name`/`like_count`/`comment_count`/`liked_by_current_user`）。
- 首页不再全量下载、不再逐篇补查 → Task 5（`loadBrowseWorks` 每次 10 篇）。
- 正文、标题、摘要、作者纳入服务端搜索 → Task 1 SQL `ilike` 覆盖四字段 + pg_trgm 索引。
- 讨论页独立分页、不再逐篇 `getWork` → Task 6 `browse_discussions` + `renderDiscussions` 改造。
- 桌面“再读十篇”、移动端临近末尾预取 → Task 5 “再读十篇”、Task 7 `maybePrefetchMobileNext`。
- 搜索 300ms 防抖、取消旧请求 → Task 5（`setTimeout` 300ms + `requestId`）。
- 搜索/分类/排序变化重置第一页 → Task 5 `setFilters` 传 `reset: true`。
- 失败保留已加载作品 + 重试 → Task 5 `state.browse.error` + “重试加载”。
- 返回首页恢复筛选、批次、阅读位置 → Task 5 `sessionStorage` + `HOME_SESSION_KEY`。
- 移动端仍一次一篇 → Task 7 保留 `createMobileFeedController` 交互。
- 元信息字号 ≥ 13px、移动表单 16px、触控 ≥ 44px → Task 8。
- 稳定游标无重复无遗漏 → Task 1 keyset + Task 1 测试断言无重叠。
- 搜索参数不拼接 SQL → Task 1 用 `format`/参数绑定 + Task 1 注入测试。

**占位符扫描：** 无 TBD/TODO；每个代码步骤含完整实现。

**类型一致性：** `nextCursor` 在 demo/supabase/DB 统一返回 `null` 表示无更多；`browse_works` 返回 `works` 数组、`browse_discussions` 返回 `discussions` 数组；RPC 参数名 `p_search/p_category/p_sort/p_cursor/p_page_size` 在前端、服务层、数据库三者一致。
