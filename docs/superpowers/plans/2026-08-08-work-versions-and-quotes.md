# 版本与批注（发布 3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给作品加入不可变、公开的版本历史：修改作品生成新版本（必须填修改说明）、恢复旧版本不删历史；读者可在当前可见正文里选句创建公开批注，批注固定到具体版本。

**Architecture:** 新增 `work_versions`（版本快照）与 `comment_quotes`（批注引用）两张表，`works` 增加 `current_version_id` 指针并保留最新内容缓存。所有作品写入（新建/改版/恢复）与批注创建都经过 SECURITY DEFINER 受保护 RPC，同一事务内写版本表并更新 `works` 缓存，杜绝绕过版本化的直接写。批注偏移约定为「按 `/\n\s*\n/` 分段、逐段 `trim()`、去空段后以 `\n` 连接而成的展示串」上的 0 基字符偏移，前端选区与 SQL 校验用同一规则。数据服务层 demo/supabase 双实现；前端新增历史版本页、写作台编辑模式与阅读页选区批注。

**Tech Stack:** 静态 HTML/CSS/ES modules、Supabase Postgres/RLS、`@supabase/supabase-js@2`、Node test runner、PGlite、Playwright。

## Global Constraints

- 不改变作品 ID、作者归属；不删除任何现有数据；`works` 继续作为「最新内容缓存」保留原字段（title/excerpt/content/category/status/is_featured）。
- 已有作品在迁移时回填为第 1 版（`change_summary = '初次发布'`，`created_by = author_id`，`created_at = works.created_at`），`works.current_version_id` 指向它。
- 所有作品新建/改版/恢复只经受保护 RPC（`create_work_version` / `restore_work_version`）；**收回 authenticated 对 `works` 的直接 insert/update 权限**，避免绕过版本化。
- 只有作品作者能创建新版本/恢复版本；管理员不能冒充作者改正文（`author_id <> auth.uid()` 一律拒绝）。
- 未验证找回邮箱账号的所有新表/新 RPC 写操作被数据库拒绝（`is_account_write_allowed()`）。
- 版本号按作品单调递增，用 `expected_version_number` 做乐观锁；版本已变化时拒绝覆盖。
- 恢复旧版本 = 复制旧内容生成新的最新版本，`restored_from_version_id` 指向来源，不删除历史。
- 批注引用原文、起止位置在创建时锁定到当前可见版本；后续改版不改变历史引用。
- 已发布作品的版本历史对所有读者公开；隐藏作品仅作者/管理员可见。
- 批注偏移一律按「展示串」计算（见上），前端选区与 SQL 校验用同一分段/修剪规则，伪造位置被拒绝。
- 不向 staging/生产执行迁移、不部署、不推送 main、不发布 Pages，直到测试验证后再次明确授权；staging 外部写前先停下请求授权。

## File Structure

- `supabase/migrations/20260808_work_versions_and_quotes.sql`：生产增量迁移（表 + 回填 + RPC + RLS + 授权收口）。
- `supabase/schema.sql`：新项目完整结构，新增 `-- VERSIONS_QUOTES_START` / `-- VERSIONS_QUOTES_END` 块。
- `js/data-service.mjs`：demo/supabase 双实现新增 `createWorkVersion`、`restoreWorkVersion`、`listWorkVersions`、`listWorkQuotes`、`createQuotedComment`；`createWork` 改走版本机制（demo 建 v1，supabase 调 RPC）。
- `js/app.js`：新路由 `#/works/:id/versions`（历史版本页）、`#/works/:id/edit`（编辑模式）；写作台加修改说明；阅读页选区批注 + 批注展示 + 「历史版本」入口。
- `assets/styles.css`：历史版本列表、批注块、批注浮动按钮样式（沿用米白/墨黑/暗红/宋体气质）。
- `tests/works-versions-db.test.mjs`：PGlite 行为测试（回填、RPC、RLS、偏移校验、越权拦截）。
- `tests/data-service.test.mjs`：demo 版本/批注行为 + supabase RPC 契约测试。
- `tests/static-checks.mjs`：迁移/schema 静态断言 + 前端路由/功能断言。
- `tests/browser-check.cjs`：编辑作品生成版本、历史版本页、选区批注浏览器断言。

---

### Task 1: 数据库迁移与 RPC（work_versions / comment_quotes / RLS / 回填）

**Files:**
- Create: `supabase/migrations/20260808_work_versions_and_quotes.sql`
- Modify: `supabase/schema.sql`（末尾追加 VERSIONS_QUOTES 块）
- Create: `tests/works-versions-db.test.mjs`
- Modify: `tests/static-checks.mjs`

**Interfaces:**
- `create_work_version(p_work_id uuid, p_expected_version_number integer, p_title text, p_excerpt text, p_category text, p_content text, p_change_summary text) returns jsonb`
  - `p_work_id is null` → 全新作品，创建第 1 版；否则为既有作品创建下一版。
  - 既有作品必须由作者操作，且 `p_change_summary` 非空（1–200 字）；新作品忽略修改说明（落库 `'初次发布'`）。
  - `p_expected_version_number` 非空时与当前最新版本号比对，不一致报「作品已被他人修改，请重新载入后重试」。
  - 返回 `{ work_id, version_id, version_number, change_summary, is_new }`。
- `restore_work_version(p_work_id uuid, p_source_version_id uuid, p_expected_version_number integer, p_change_summary text) returns jsonb`
  - 复制来源版本内容生成新的最新版本，`restored_from_version_id = p_source_version_id`；修改说明必填。
  - 返回 `{ work_id, version_id, version_number, restored_from_version_id, change_summary }`。
- `create_quoted_comment(p_work_id uuid, p_work_version_id uuid, p_quote_text text, p_start_offset integer, p_end_offset integer, p_content text) returns jsonb`
  - 校验版本属于作品、`quote_text` 为展示串 `[start,end)` 子串；同一事务插入 `comments` + `comment_quotes`。
  - 返回 `{ comment: {...}, quote: {...} }`。
- `list_work_versions(p_work_id uuid) returns jsonb`：返回该作品全部版本（按版本号降序）；非已发布/非作者/非管理员报「作品不存在」。
- `list_work_quotes(p_work_id uuid) returns jsonb`：返回该作品全部批注（按 `start_offset` 升序）。

- [ ] **Step 1: 写失败的 schema/迁移静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("版本与批注迁移新增两张表、五个 RPC 并收回作品直接写", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260808_work_versions_and_quotes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.work_versions/i);
  assert.match(migration, /create table if not exists public\.comment_quotes/i);
  assert.match(migration, /current_version_id uuid references public\.work_versions/i);
  assert.match(migration, /revoke insert on table public\.works from authenticated/i);
  assert.match(migration, /revoke update on table public\.works from authenticated/i);
  for (const fn of ["create_work_version", "restore_work_version", "create_quoted_comment", "list_work_versions", "list_work_quotes"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
  }
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
});

test("schema 的版本批注块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- VERSIONS_QUOTES_START/);
  assert.match(schema, /-- VERSIONS_QUOTES_END/);
  assert.match(schema, /create table if not exists public\.work_versions/i);
  assert.match(schema, /create table if not exists public\.comment_quotes/i);
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 两条新增测试 FAIL（迁移与 schema 块均不存在）。

- [ ] **Step 3: 写失败的 PGlite 行为测试**

创建 `tests/works-versions-db.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const accountMigrationUrl = new URL(
  "../supabase/migrations/20260802_account_recovery_security.sql",
  import.meta.url,
);
const browseMigrationUrl = new URL(
  "../supabase/migrations/20260806_browse_works_and_discussions.sql",
  import.meta.url,
);
const versionsMigrationUrl = new URL(
  "../supabase/migrations/20260808_work_versions_and_quotes.sql",
  import.meta.url,
);

const BROWSE_START = "-- BROWSE_READ_START";
const BROWSE_END = "-- BROWSE_READ_END";
const VERSIONS_START = "-- VERSIONS_QUOTES_START";
const VERSIONS_END = "-- VERSIONS_QUOTES_END";
const ACCOUNT_START = "-- ACCOUNT_RECOVERY_SECURITY_START";
const ACCOUNT_END = "-- ACCOUNT_RECOVERY_SECURITY_END";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";
const USER_C = "10000000-0000-4000-8000-000000000003";
const ADMIN_D = "10000000-0000-4000-8000-000000000004";
const WORK_1 = "20000000-0000-4000-8000-000000000001";

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
  const schema = stripBlock(
    stripBlock(await readFile(schemaUrl, "utf8"), BROWSE_START, BROWSE_END),
    VERSIONS_START,
    VERSIONS_END,
  );
  await db.exec(schema);
  await db.exec(await readFile(accountMigrationUrl, "utf8"));
  await db.exec(await readFile(browseMigrationUrl, "utf8"));
  return db;
}

async function seed(db, { withAdmin = false } = {}) {
  const users = [
    [USER_A, "a@x.test", "松声"],
    [USER_B, "b@x.test", "白露"],
    [USER_C, "c@x.test", "杏雨"],
  ];
  if (withAdmin) users.push([ADMIN_D, "d@x.test", "编辑部"]);
  for (const [id, email, penName] of users) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, jsonb_build_object('pen_name', $3))`,
      [id, email, penName],
    );
  }
  if (withAdmin) {
    await db.exec(`update public.profiles set role = 'admin' where id = '${ADMIN_D}'`);
  }
  await db.exec(`
    insert into public.works (id, author_id, title, excerpt, content, category, status, created_at)
    values
      ('${WORK_1}', '${USER_A}', '末班车', '友谊校区', '第一段正文。\n\n第二段正文。', '散文', 'published', now() - '10 minutes'::interval),
      ('20000000-0000-4000-8000-000000000002', '${USER_B}', '白露集', '白露', '白露的正文。', '新诗', 'published', now() - '5 minutes'::interval)
  `);
  await db.exec(`
    insert into public.comments (id, work_id, user_id, content, created_at)
    values
      ('30000000-0000-4000-8000-000000000001', '${WORK_1}', '${USER_B}', '评论一', now() - '1 minutes'::interval)
  `);
}

async function applyVersionsMigration(db) {
  await db.exec(await readFile(versionsMigrationUrl, "utf8"));
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

function displayString(content) {
  return String(content)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n");
}
```

然后追加以下测试用例（粘贴到文件末尾）：

```js
test("回填：每篇作品恰好一个第 1 版，快照与作者一致", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows } = await db.query(`
      select
        w.id, w.author_id, w.content, w.current_version_id,
        v.version_number, v.title, v.excerpt, v.content as v_content, v.category,
        v.change_summary, v.created_by
      from public.works w
      join public.work_versions v on v.work_id = w.id
    `);
    assert.equal(rows.length, 2, "每篇作品恰好一条版本");
    for (const row of rows) {
      assert.equal(row.version_number, 1);
      assert.equal(row.change_summary, "初次发布");
      assert.equal(row.v_content, row.content, "第 1 版正文快照等于作品当前内容");
      assert.equal(row.created_by, row.author_id, "第 1 版创建者等于作者");
      assert.equal(row.current_version_id, row.id, "current_version_id 指向第 1 版");
    }
  } finally {
    await db.close();
  }
});

test("create_work_version 全新作品创建第 1 版并同步 works 缓存", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, '新标题', '', '新诗', '新正文。', '') as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.is_new, true);
    assert.equal(payload.version_number, 1);
    const { rows: workRows } = await db.query(
      "select author_id, title, content, status, is_featured, current_version_id from public.works where id = $1",
      [payload.work_id],
    );
    const work = workRows[0];
    assert.equal(work.author_id, USER_A);
    assert.equal(work.title, "新标题");
    assert.equal(work.content, "新正文。");
    assert.equal(work.status, "published");
    assert.equal(work.is_featured, false);
    assert.equal(work.current_version_id, payload.version_id);
    const { rows: verRows } = await db.query(
      "select count(*)::int as n, max(version_number)::int as mx from public.work_versions where work_id = $1",
      [payload.work_id],
    );
    assert.equal(verRows[0].n, 1);
    assert.equal(verRows[0].mx, 1);
  } finally {
    await db.close();
  }
});

test("作者创建新版本：版本递增、历史保留、缓存与指针更新", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version('${WORK_1}', 1, '末班车·修订', '友谊校区', '散文', '第一段正文。\n\n第二段正文。\n\n第三段新增。', '补充第三段') as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.is_new, false);
    assert.equal(payload.version_number, 2);
    const { rows: workRows } = await db.query(
      "select content, current_version_id from public.works where id = $1",
      [WORK_1],
    );
    assert.match(workRows[0].content, /第三段新增/);
    assert.equal(workRows[0].current_version_id, payload.version_id);
    const { rows: verRows } = await db.query(`
      select version_number, content, change_summary
      from public.work_versions where work_id = $1 order by version_number
    `, [WORK_1]);
    assert.equal(verRows.length, 2);
    assert.doesNotMatch(verRows[0].content, /第三段新增/, "第 1 版历史不被覆盖");
    assert.equal(verRows[1].change_summary, "补充第三段");
  } finally {
    await db.close();
  }
});

test("版本冲突：预期版本号不匹配被拒绝", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const error = await expectError(asRole(db, "authenticated", USER_A, `
      select public.create_work_version('${WORK_1}', 99, 'x', '', '散文', 'y', '说明') as payload
    `));
    assert.match(error.message, /已被他人修改/);
  } finally {
    await db.close();
  }
});

test("非作者与管理员都不能为他人作品创建版本", async () => {
  const db = await createDatabase();
  try {
    await seed(db, { withAdmin: true });
    await applyVersionsMigration(db);
    const memberError = await expectError(asRole(db, "authenticated", USER_B, `
      select public.create_work_version('${WORK_1}', 1, 'x', '', '散文', 'y', '说明') as payload
    `));
    assert.match(memberError.message, /只有作者/);
    const adminError = await expectError(asRole(db, "authenticated", ADMIN_D, `
      select public.create_work_version('${WORK_1}', 1, 'x', '', '散文', 'y', '说明') as payload
    `));
    assert.match(adminError.message, /只有作者/, "管理员不能冒充作者改正文");
  } finally {
    await db.close();
  }
});

test("未验证账号在 write_gate=enforce 时所有版本写操作被拒", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    // USER_B 未绑定找回邮箱
    const error = await expectError(asRole(db, "authenticated", USER_B, `
      select public.create_work_version(null, null, 't', '', '散文', 'c', '') as payload
    `));
    assert.match(error.message, /找回邮箱/);
    // USER_A 已绑定 → 成功
    await db.exec(`
      insert into public.account_recovery_emails (user_id, email_normalized, verified_at)
      values ('${USER_A}', 'a-recovery@x.test', now())
    `);
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, 't', '', '散文', 'c', '') as payload
    `);
    assert.equal(rows[0].payload.version_number, 1);
  } finally {
    await db.close();
  }
});

test("restore_work_version 复制旧版为新版且历史不丢失", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    await asRole(db, "authenticated", USER_A, `
      select public.create_work_version('${WORK_1}', 1, '末班车·修订', '友谊校区', '散文', '第三段新增。', '补充第三段') as payload
    `);
    const { rows: verRows } = await db.query(
      "select id, version_number from public.work_versions where work_id = $1 order by version_number",
      [WORK_1],
    );
    const v1 = verRows[0];
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.restore_work_version('${WORK_1}', '${v1.id}', 2, '回到初稿') as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.version_number, 3);
    assert.equal(payload.restored_from_version_id, v1.id);
    const { rows: finalRows } = await db.query(`
      select count(*)::int as n, min(version_number)::int as mn, max(version_number)::int as mx
      from public.work_versions where work_id = $1
    `, [WORK_1]);
    assert.equal(finalRows[0].n, 3, "恢复不丢失任何历史");
    assert.equal(finalRows[0].mn, 1);
    assert.equal(finalRows[0].mx, 3);
  } finally {
    await db.close();
  }
});

test("create_quoted_comment 保存正确版本、原文与位置", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [WORK_1],
    );
    const v1 = verRows[0].id;
    // 展示串 = "第一段正文。\n第二段正文。"；offset 7..11 是"第二段正文。"
    const { rows } = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第二段正文。', 7, 12, '这句最准。') as payload
    `);
    const payload = rows[0].payload;
    assert.equal(payload.comment.work_id, WORK_1);
    assert.equal(payload.comment.user_id, USER_B);
    assert.equal(payload.quote.work_version_id, v1);
    assert.equal(payload.quote.quote_text, "第二段正文。");
    const { rows: commentRows } = await db.query(
      "select count(*)::int as n from public.comments where work_id = $1",
      [WORK_1],
    );
    assert.equal(commentRows[0].n, 2, "批注同时是一条评论");
    const { rows: quoteRows } = await db.query(
      "select comment_id, work_version_id, quote_text, start_offset, end_offset from public.comment_quotes where comment_id = $1",
      [payload.comment.id],
    );
    assert.equal(quoteRows[0].start_offset, 7);
    assert.equal(quoteRows[0].end_offset, 12);
    const { rows: quoteList } = await asRole(db, "anon", null, `
      select public.list_work_quotes('${WORK_1}') as payload
    `);
    assert.equal(quoteList[0].payload[0].quote_text, "第二段正文。");
    assert.equal(quoteList[0].payload[0].comment_content, "这句最准。");
    assert.equal(quoteList[0].payload[0].user_pen_name, "白露");
  } finally {
    await db.close();
  }
});

test("引用位置与原文不符被拒绝（不可伪造）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [WORK_1],
    );
    const v1 = verRows[0].id;
    const wrongText = await expectError(asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '伪造的原文', 0, 5, '内容') as payload
    `));
    assert.match(wrongText.message, /不符/);
    const wrongOffset = await expectError(asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第一段正文。', 99, 103, '内容') as payload
    `));
    assert.match(wrongOffset.message, /不符/);
  } finally {
    await db.close();
  }
});

test("authenticated 无法直接写入 works 或新表（只能经 RPC）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const workInsert = await expectError(asRole(db, "authenticated", USER_A, `
      insert into public.works (author_id, title, content, category) values ('${USER_A}', 't', 'c', '散文')
    `));
    assert.match(workInsert.message, /permission denied|violates row-level security|permission/i);
    const versionInsert = await expectError(asRole(db, "authenticated", USER_A, `
      insert into public.work_versions (work_id, version_number, title, content, category, change_summary, created_by)
      values ('${WORK_1}', 99, 't', 'c', '散文', '说明', '${USER_A}')
    `));
    assert.match(versionInsert.message, /permission denied|violates row-level security|permission/i);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 4: 运行 PGlite 测试验证 RED**

Run: `node --test tests/works-versions-db.test.mjs`
Expected: FAIL（迁移文件不存在 → ENOENT）。

- [ ] **Step 5: 写生产增量迁移**

创建 `supabase/migrations/20260808_work_versions_and_quotes.sql`：

```sql
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
```

- [ ] **Step 6: 同步 schema.sql 追加 VERSIONS_QUOTES 块**

在 `supabase/schema.sql` 末尾追加：

```sql
-- VERSIONS_QUOTES_START
-- work_versions、comment_quotes、五个 RPC 与 RLS/授权收口与
-- supabase/migrations/20260808_work_versions_and_quotes.sql 完全一致。
-- VERSIONS_QUOTES_END
```

然后在 `-- VERSIONS_QUOTES_START` 与 `-- VERSIONS_QUOTES_END` 之间，逐字粘贴迁移文件中从 `create table if not exists public.work_versions (` 到 `grant execute on function public.list_work_quotes(uuid) to anon, authenticated;` 的全部语句（含 `alter table works add column`、回填两段、RLS、revoke/grant、五个函数）。注意保留 `begin;`/`commit;` 之外的内容。

- [ ] **Step 7: 运行全部相关测试验证 GREEN**

Run:
```bash
node --test tests/works-versions-db.test.mjs
node --test tests/static-checks.mjs
node --test tests/works-browse-db.test.mjs
```
Expected: 全部 PASS（既有 browse 测试不受回填/授权收口影响）。

- [ ] **Step 8: 提交**

```bash
git add supabase/migrations/20260808_work_versions_and_quotes.sql supabase/schema.sql tests/works-versions-db.test.mjs tests/static-checks.mjs
git commit -m "feat: add immutable work version history, restore RPC and versioned quote annotations"
```

---

### Task 2: demo 数据服务版本与批注

**Files:**
- Modify: `js/data-service.mjs`（demo 服务）
- Test: `tests/data-service.test.mjs`

**Interfaces（demo 与 supabase 一致）：**
- `service.listWorkVersions(workId)` → 版本数组（按 `version_number` 降序）
- `service.createWorkVersion({ workId, expectedVersionNumber, title, excerpt, category, content, changeSummary })` → 富化的作品
- `service.restoreWorkVersion({ workId, sourceVersionId, expectedVersionNumber, changeSummary })` → 富化的作品
- `service.listWorkQuotes(workId)` → 批注数组（按 `start_offset` 升序）
- `service.createQuotedComment({ workId, workVersionId, quoteText, startOffset, endOffset, content })` → `{ comment, quote }`
- `createWork(input)` 保持不变返回富化作品，但 demo 内部同时落第 1 版版本记录；`getWork` 返回含 `current_version_id` 与 `current_version_number`。

- [ ] **Step 1: 写失败的 demo 版本/批注测试**

在 `tests/data-service.test.mjs` 末尾追加：

```js
test("演示服务记录版本历史、编辑生成新版本且恢复不丢历史", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "初稿",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。",
  });
  assert.equal(created.current_version_number, 1);

  const versions1 = await service.listWorkVersions(created.id);
  assert.equal(versions1.length, 1);
  assert.equal(versions1[0].version_number, 1);
  assert.equal(versions1[0].change_summary, "初次发布");

  const edited = await service.createWorkVersion({
    workId: created.id,
    expectedVersionNumber: 1,
    title: "初稿·修订",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。\n\n第三段。",
    changeSummary: "补第三段",
  });
  assert.equal(edited.current_version_number, 2);

  const versions2 = await service.listWorkVersions(created.id);
  assert.equal(versions2.length, 2);
  assert.equal(versions2[0].version_number, 2);
  assert.doesNotMatch(versions2[1].content, /第三段/, "第 1 版不被覆盖");

  const restored = await service.restoreWorkVersion({
    workId: created.id,
    sourceVersionId: versions2[1].id,
    expectedVersionNumber: 2,
    changeSummary: "回到初稿",
  });
  assert.equal(restored.current_version_number, 3);
  const versions3 = await service.listWorkVersions(created.id);
  assert.equal(versions3.length, 3);
  assert.equal(versions3[0].restored_from_version_id, versions2[1].id);
});

test("演示服务版本冲突、非作者与缺失修改说明被拒绝", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "冲突测试",
    excerpt: "",
    category: "散文",
    content: "正文",
  });
  await assert.rejects(
    service.createWorkVersion({
      workId: created.id,
      expectedVersionNumber: 99,
      title: "x",
      excerpt: "",
      category: "散文",
      content: "y",
      changeSummary: "说明",
    }),
    /已被他人修改/,
  );
  await assert.rejects(
    service.createWorkVersion({
      workId: created.id,
      expectedVersionNumber: 1,
      title: "x",
      excerpt: "",
      category: "散文",
      content: "y",
      changeSummary: "",
    }),
    /修改说明/,
  );
});

test("演示服务批注：保存正确版本原文位置，位置不符被拒", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "批注测试",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。",
  });
  const versions = await service.listWorkVersions(created.id);
  const v1 = versions[0];
  // 展示串 = "第一段。\n第二段。"
  const result = await service.createQuotedComment({
    workId: created.id,
    workVersionId: v1.id,
    quoteText: "第二段。",
    startOffset: 7,
    endOffset: 11,
    content: "这句写得准。",
  });
  assert.equal(result.quote.work_version_id, v1.id);
  assert.equal(result.comment.content, "这句写得准。");
  const quotes = await service.listWorkQuotes(created.id);
  assert.equal(quotes[0].quote_text, "第二段。");
  await assert.rejects(
    service.createQuotedComment({
      workId: created.id,
      workVersionId: v1.id,
      quoteText: "伪造原文",
      startOffset: 0,
      endOffset: 4,
      content: "内容",
    }),
    /不符/,
  );
});
```

- [ ] **Step 2: 运行测试验证 RED**

Run: `node --test tests/data-service.test.mjs`
Expected: 新增三条测试 FAIL（`listWorkVersions is not a function`）。

- [ ] **Step 3: demo 服务新增版本与批注状态**

在 `createDemoService` 的 `state` 初始处添加版本/批注存储与惰性初始化辅助。先定位 `const state = { ... }` 里的 `works` 数组，在其后加入：

```js
    workVersions: new Map(), // work_id -> version 数组（按版本号降序）
    commentQuotes: [], // { comment_id, work_id, work_version_id, quote_text, start_offset, end_offset, created_at }
```

在 `const makeId = ...` 与 `enrichWork` 附近添加辅助函数（放在 `createDemoService` 内、`const service = {` 之前）：

```js
  const ensureVersion1 = (work) => {
    if (state.workVersions.has(work.id)) return state.workVersions.get(work.id);
    const version = {
      id: makeId("version"),
      work_id: work.id,
      version_number: 1,
      title: work.title,
      excerpt: work.excerpt,
      content: work.content,
      category: work.category,
      change_summary: "初次发布",
      restored_from_version_id: null,
      created_by: work.author_id,
      created_at: work.created_at,
    };
    state.workVersions.set(work.id, [version]);
    work.current_version_id = version.id;
    work.current_version_number = 1;
    return state.workVersions.get(work.id);
  };

  const nextVersionNumber = (workId) =>
    (state.workVersions.get(workId) ?? []).reduce(
      (max, version) => Math.max(max, version.version_number),
      0,
    ) + 1;

  const displayStringDemo = (content) =>
    String(content)
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .join("\n");
```

把 demo `enrichWork` 的对象展开处加上 `current_version_id: work.current_version_id ?? null, current_version_number: work.current_version_number ?? 1`（若 `enrichWork` 是显式字段则追加两个字段）。

在 demo `createWork` 里，`state.works.push(work);` 之后追加 `ensureVersion1(work);`，并在 `work` 对象上补 `current_version_id: null, current_version_number: 1`。

- [ ] **Step 4: demo 服务实现五个方法**

在 demo `service` 对象里 `addComment` 之后追加：

```js
    async listWorkVersions(workId) {
      const work = state.works.find((item) => item.id === workId);
      if (!work) throw new Error("作品不存在");
      return ensureVersion1(work).slice().sort(
        (left, right) => right.version_number - left.version_number,
      );
    },

    async createWorkVersion(input) {
      const current = requireVerifiedSession();
      const work = state.works.find((item) => item.id === input.workId);
      if (!work) throw new Error("作品不存在");
      if (work.author_id !== current.profile.id) {
        throw new Error("只有作者可以修改自己的作品");
      }
      const versions = ensureVersion1(work);
      const latest = versions[versions.length - 1].version_number;
      if (
        input.expectedVersionNumber != null &&
        input.expectedVersionNumber !== latest
      ) {
        throw new Error("作品已被他人修改，请重新载入后重试");
      }
      const changeSummary = String(input.changeSummary ?? "").trim();
      if (!changeSummary) throw new Error("请填写简短修改说明");
      const content = requireText(input.content, "正文", 50000);
      const now = new Date().toISOString();
      const version = {
        id: makeId("version"),
        work_id: work.id,
        version_number: latest + 1,
        title: requireText(input.title, "标题", 80),
        excerpt:
          String(input.excerpt ?? "").trim() || createExcerpt(content, 96),
        content,
        category: requirePublishableCategory(input.category),
        change_summary: changeSummary,
        restored_from_version_id: null,
        created_by: current.profile.id,
        created_at: now,
      };
      versions.push(version);
      Object.assign(work, {
        title: version.title,
        excerpt: version.excerpt,
        content: version.content,
        category: version.category,
        updated_at: now,
        current_version_id: version.id,
        current_version_number: version.version_number,
      });
      return enrichWork(work);
    },

    async restoreWorkVersion(input) {
      const current = requireVerifiedSession();
      const work = state.works.find((item) => item.id === input.workId);
      if (!work) throw new Error("作品不存在");
      if (work.author_id !== current.profile.id) {
        throw new Error("只有作者可以修改自己的作品");
      }
      const versions = ensureVersion1(work);
      const source = versions.find(
        (version) => version.id === input.sourceVersionId,
      );
      if (!source) throw new Error("要恢复的版本不存在");
      const latest = versions[versions.length - 1].version_number;
      if (
        input.expectedVersionNumber != null &&
        input.expectedVersionNumber !== latest
      ) {
        throw new Error("作品已被他人修改，请重新载入后重试");
      }
      const changeSummary = String(input.changeSummary ?? "").trim();
      if (!changeSummary) throw new Error("请填写简短修改说明");
      const now = new Date().toISOString();
      const version = {
        id: makeId("version"),
        work_id: work.id,
        version_number: latest + 1,
        title: source.title,
        excerpt: source.excerpt,
        content: source.content,
        category: source.category,
        change_summary: changeSummary,
        restored_from_version_id: source.id,
        created_by: current.profile.id,
        created_at: now,
      };
      versions.push(version);
      Object.assign(work, {
        title: version.title,
        excerpt: version.excerpt,
        content: version.content,
        category: version.category,
        updated_at: now,
        current_version_id: version.id,
        current_version_number: version.version_number,
      });
      return enrichWork(work);
    },

    async listWorkQuotes(workId) {
      if (!state.works.some((item) => item.id === workId)) {
        throw new Error("作品不存在");
      }
      return state.commentQuotes
        .filter((quote) => quote.work_id === workId)
        .map((quote) => {
          const comment = state.comments.find(
            (item) => item.id === quote.comment_id,
          );
          const author = comment
            ? getProfileRecord(comment.user_id)
            : null;
          return {
            ...quote,
            comment_content: comment?.content ?? "",
            is_deleted: comment?.is_deleted ?? true,
            user_id: comment?.user_id ?? null,
            user_pen_name: author?.pen_name ?? "佚名",
          };
        })
        .sort((left, right) => left.start_offset - right.start_offset);
    },

    async createQuotedComment(input) {
      const current = requireVerifiedSession();
      const work = state.works.find((item) => item.id === input.workId);
      if (!work) throw new Error("作品不存在");
      const versions = ensureVersion1(work);
      const version = versions.find(
        (item) => item.id === input.workVersionId,
      );
      if (!version) throw new Error("批注对应的作品版本不存在");
      const quoteText = String(input.quoteText ?? "").trim();
      const display = displayStringDemo(version.content);
      const start = Number(input.startOffset);
      const end = Number(input.endOffset);
      if (
        quoteText.length < 1 ||
        quoteText.length > 500 ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        end <= start ||
        display.slice(start, end) !== quoteText
      ) {
        throw new Error("引用原文与所选位置不符，请重新选择");
      }
      const now = new Date().toISOString();
      const comment = {
        id: makeId("comment"),
        work_id: work.id,
        user_id: current.profile.id,
        parent_id: null,
        content: requireText(input.content, "评论", 2000),
        is_deleted: false,
        created_at: now,
        updated_at: now,
      };
      state.comments.push(comment);
      const quote = {
        id: makeId("quote"),
        comment_id: comment.id,
        work_id: work.id,
        work_version_id: version.id,
        quote_text: quoteText,
        start_offset: start,
        end_offset: end,
        created_at: now,
      };
      state.commentQuotes.push(quote);
      return { comment: enrichComment(comment), quote };
    },
```

- [ ] **Step 5: 运行测试验证 GREEN**

Run: `node --test tests/data-service.test.mjs`
Expected: 全部 PASS（含既有测试）。

- [ ] **Step 6: 提交**

```bash
git add js/data-service.mjs tests/data-service.test.mjs
git commit -m "feat: add demo work version history and quote annotations to data service"
```

---

### Task 3: Supabase 数据服务版本与批注（RPC 转发）

**Files:**
- Modify: `js/data-service.mjs`（supabase 服务 + `createWork` 改走 RPC）
- Test: `tests/data-service.test.mjs`

- [ ] **Step 1: 写失败的 supabase 契约测试**

在 `tests/data-service.test.mjs` 末尾追加（沿用既有 `fakeClient` 模式；先读文件中现有 fakeClient 构造，若已有 `rpc` 分支则在其基础上扩展）：

```js
test("Supabase 服务通过 RPC 创建版本、恢复版本并返回版本/批注", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: "u-1", email: "a@x.test" },
            access_token: "t",
          },
        },
        error: null,
      }),
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            table === "works"
              ? {
                  data: {
                    id: "work-1",
                    author_id: "u-1",
                    title: "修订",
                    excerpt: "",
                    content: "正文",
                    category: "散文",
                    status: "published",
                    is_featured: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    current_version_id: "v-2",
                    work_versions: { version_number: 2 },
                    profiles: { pen_name: "松声", bio: "", role: "member" },
                  },
                  error: null,
                }
              : { data: null, error: null },
        }),
      }),
    }),
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name === "create_work_version") {
        return {
          data: { work_id: "work-1", version_id: "v-2", version_number: 2, change_summary: "补第三段", is_new: false },
          error: null,
        };
      }
      if (name === "restore_work_version") {
        return {
          data: { work_id: "work-1", version_id: "v-3", version_number: 3, restored_from_version_id: "v-1", change_summary: "回到初稿" },
          error: null,
        };
      }
      if (name === "list_work_versions") {
        return {
          data: [
            { id: "v-2", version_number: 2, title: "修订", excerpt: "", content: "正文", category: "散文", change_summary: "补第三段", restored_from_version_id: null, created_by: "u-1", created_at: new Date().toISOString() },
            { id: "v-1", version_number: 1, title: "初稿", excerpt: "", content: "正文", category: "散文", change_summary: "初次发布", restored_from_version_id: null, created_by: "u-1", created_at: new Date().toISOString() },
          ],
          error: null,
        };
      }
      if (name === "create_quoted_comment") {
        return {
          data: {
            comment: { id: "c-1", work_id: "work-1", user_id: "u-2", content: "这句写得准。", is_deleted: false, created_at: new Date().toISOString() },
            quote: { id: "q-1", work_version_id: "v-1", quote_text: "第二段。", start_offset: 7, end_offset: 11 },
          },
          error: null,
        };
      }
      if (name === "list_work_quotes") {
        return {
          data: [{ comment_id: "c-1", work_version_id: "v-1", quote_text: "第二段。", start_offset: 7, end_offset: 11, comment_content: "这句写得准。", is_deleted: false, user_id: "u-2", user_pen_name: "白露", created_at: new Date().toISOString() }],
          error: null,
        };
      }
      return { data: null, error: { message: "unknown" } };
    },
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });

  const edited = await service.createWorkVersion({
    workId: "work-1",
    expectedVersionNumber: 1,
    title: "修订",
    excerpt: "",
    category: "散文",
    content: "正文",
    changeSummary: "补第三段",
  });
  assert.equal(edited.current_version_number, 2);
  assert.deepEqual(invoked.at(-1), [
    "create_work_version",
    { p_work_id: "work-1", p_expected_version_number: 1, p_title: "修订", p_excerpt: "", p_category: "散文", p_content: "正文", p_change_summary: "补第三段" },
  ]);

  const restored = await service.restoreWorkVersion({
    workId: "work-1",
    sourceVersionId: "v-1",
    expectedVersionNumber: 2,
    changeSummary: "回到初稿",
  });
  assert.equal(restored.current_version_number, 3);

  const versions = await service.listWorkVersions("work-1");
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version_number, 2);

  const quoted = await service.createQuotedComment({
    workId: "work-1",
    workVersionId: "v-1",
    quoteText: "第二段。",
    startOffset: 7,
    endOffset: 11,
    content: "这句写得准。",
  });
  assert.equal(quoted.quote.work_version_id, "v-1");
  assert.deepEqual(invoked.at(-1), [
    "create_quoted_comment",
    { p_work_id: "work-1", p_work_version_id: "v-1", p_quote_text: "第二段。", p_start_offset: 7, p_end_offset: 11, p_content: "这句写得准。" },
  ]);

  const quotes = await service.listWorkQuotes("work-1");
  assert.equal(quotes[0].quote_text, "第二段。");
});
```

同时更新既有 `createWork` 契约测试：把「从 `from("works").insert` 断言」改为断言 `create_work_version` RPC 调用（`p_work_id: null`）并返回富化作品。定位既有测试中 `createWork` 的 fakeClient 分支，新增：

```js
      if (name === "create_work_version") {
        return {
          data: { work_id: "work-new", version_id: "v-1", version_number: 1, change_summary: "初次发布", is_new: true },
          error: null,
        };
      }
```

并让 `from("works").select(...)` 对新作品返回该行数据（含 `work_versions: { version_number: 1 }`）。

- [ ] **Step 2: 运行测试验证 RED**

Run: `node --test tests/data-service.test.mjs`
Expected: 新增测试 FAIL（supabase service 无这些方法）；既有 `createWork` 契约断言 FAIL。

- [ ] **Step 3: supabase 服务实现版本/批注方法**

在 `createSupabaseService` 的 `enrichRemoteWorks` 之后新增辅助 `fetchWorkById`：

```js
  const fetchWorkById = async (client, workId) => {
    const { data, error } = await client
      .from("works")
      .select(
        "*, profiles!works_author_id_fkey(id,pen_name,bio,role,created_at), work_versions!works_current_version_id_fkey(version_number)",
      )
      .eq("id", workId)
      .single();
    if (error) throw new Error(error.message);
    const [enriched] = await enrichRemoteWorks(client, [data]);
    enriched.current_version_number =
      data.work_versions?.version_number ?? null;
    return enriched;
  };
```

把 supabase `getWork` 的 select 加上 `work_versions!works_current_version_id_fkey(version_number)`，并在返回前设 `current_version_number`。

把 supabase `createWork` 改为走 RPC：

```js
    async createWork(input) {
      const current = await requireRemoteSession();
      const content = requireText(input.content, "正文", 50000);
      const client = await getClient();
      const { data, error } = await client.rpc("create_work_version", {
        p_work_id: null,
        p_expected_version_number: null,
        p_title: requireText(input.title, "标题", 80),
        p_excerpt:
          String(input.excerpt ?? "").trim() || createExcerpt(content, 96),
        p_category: requirePublishableCategory(input.category),
        p_content: content,
        p_change_summary: "",
      });
      if (error) throw new Error(error.message);
      return fetchWorkById(client, data.work_id);
    },
```

在 supabase `service` 对象里 `createWork` 之后追加：

```js
    async createWorkVersion(input) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("create_work_version", {
        p_work_id: input.workId,
        p_expected_version_number: input.expectedVersionNumber ?? null,
        p_title: input.title,
        p_excerpt: input.excerpt ?? "",
        p_category: input.category,
        p_content: input.content,
        p_change_summary: input.changeSummary ?? "",
      });
      if (error) throw new Error(error.message);
      return fetchWorkById(client, data.work_id);
    },

    async restoreWorkVersion(input) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("restore_work_version", {
        p_work_id: input.workId,
        p_source_version_id: input.sourceVersionId,
        p_expected_version_number: input.expectedVersionNumber ?? null,
        p_change_summary: input.changeSummary ?? "",
      });
      if (error) throw new Error(error.message);
      return fetchWorkById(client, data.work_id);
    },

    async listWorkVersions(workId) {
      const client = await getClient();
      const { data, error } = await client.rpc("list_work_versions", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },

    async createQuotedComment(input) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("create_quoted_comment", {
        p_work_id: input.workId,
        p_work_version_id: input.workVersionId,
        p_quote_text: input.quoteText,
        p_start_offset: input.startOffset,
        p_end_offset: input.endOffset,
        p_content: input.content,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async listWorkQuotes(workId) {
      const client = await getClient();
      const { data, error } = await client.rpc("list_work_quotes", {
        p_work_id: workId,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },
```

- [ ] **Step 4: 运行测试验证 GREEN**

Run: `node --test tests/data-service.test.mjs`
Expected: 全部 PASS（含更新后的 `createWork` 契约断言）。

- [ ] **Step 5: 提交**

```bash
git add js/data-service.mjs tests/data-service.test.mjs
git commit -m "feat: add Supabase RPC-backed version history and quote annotations"
```

---

### Task 4: 前端历史版本页与入口

**Files:**
- Modify: `js/app.js`（路由 + `renderWorkVersions` + 阅读页入口）
- Modify: `tests/static-checks.mjs`
- Modify: `tests/browser-check.cjs`

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("前端实现历史版本页、恢复入口与阅读页版本入口", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /renderWorkVersions/);
  assert.match(app, /route\.name === "versions"/);
  assert.match(app, /listWorkVersions\(/);
  assert.match(app, /restoreWorkVersion\(/);
  assert.match(app, /查看历史版本/);
  assert.match(app, /恢复此版本/);
  assert.match(app, /change_summary/);
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL。

- [ ] **Step 3: 扩展路由**

在 `parseRoute` 的哈希解析里，新增 `#/works/:id/versions` 与 `#/works/:id/edit` 两个形态。定位现有 `works` 分支（`segments[0] === "works"`），在其解析后追加：

```js
      if (segments[1] && segments[2] === "versions") {
        return { name: "versions", id: decodeURIComponent(segments[1]) };
      }
      if (segments[1] && segments[2] === "edit") {
        return { name: "editWork", id: decodeURIComponent(segments[1]) };
      }
```

在 `renderCurrentRoute()` 的分支里（`route.name === "work"` 附近）追加：

```js
    else if (route.name === "versions") await renderWorkVersions(route.id);
    else if (route.name === "editWork") await renderWrite({ workId: route.id });
```

在 `state` 对象加 `editingWork: null`。

- [ ] **Step 4: 实现 renderWorkVersions**

在 `renderWork` 之后新增：

```js
async function renderWorkVersions(workId) {
  showLoading("正在打开历史版本");
  try {
    const [work, versions] = await Promise.all([
      service.getWork(workId),
      service.listWorkVersions(workId),
    ]);
    const shell = element("div", { className: "page-shell versions-shell" });
    shell.append(
      createPageHeader(
        "VERSIONS",
        "历史版本",
        "每次修改都会留下一个公开版本。恢复旧版本会生成新的最新版本，不会删除任何历史。",
      ),
      element("p", { className: "profile-meta" }, [
        element("span", { text: work.title }),
        element("span", { text: ` · 共 ${versions.length} 个版本` }),
        element("a", {
          className: "inline-link",
          href: `#/works/${encodeURIComponent(work.id)}`,
          text: "返回正文",
        }),
      ]),
    );
    const list = element("ol", { className: "version-list" });
    versions.forEach((version) => {
      const item = element("li", { className: "version-card" });
      const isCurrent = work.current_version_number === version.version_number;
      item.append(
        element("div", { className: "version-card-head" }, [
          element("span", {
            className: "version-badge",
            text: `第 ${version.version_number} 版`,
          }),
          isCurrent
            ? element("span", { className: "featured-mark", text: "当前版本" })
            : null,
          element("time", {
            text: formatDate(version.created_at),
            attrs: { datetime: version.created_at },
          }),
        ]),
        element("p", {
          className: "version-summary",
          text: version.change_summary,
        }),
        version.restored_from_version_id
          ? element("p", {
              className: "profile-meta",
              text: `由第 ${versions.find((v) => v.id === version.restored_from_version_id)?.version_number ?? "?"} 版恢复而来`,
            })
          : null,
        element("details", { className: "version-body" }, [
          element("summary", { text: "查看正文快照" }),
          renderParagraphs(version.content, version.category),
        ]),
      );
      if (userCanManage(work.author_id) && !isCurrent) {
        item.append(
          element("button", {
            className: "quiet-button",
            type: "button",
            text: "恢复此版本",
            dataset: {
              action: "restore-version",
              workId: work.id,
              sourceVersionId: version.id,
              versionNumber: String(version.version_number),
            },
          }),
        );
      }
      list.append(item);
    });
    shell.append(list);
    replaceContent(app, shell);
  } catch (error) {
    showError("历史版本无法打开", error.message, true);
  }
}
```

- [ ] **Step 5: 阅读页加「历史版本」入口**

在 `renderWork` 的 `actionBar` 里、`likeButton` 之后追加：

```js
    actionBar.append(
      element("a", {
        className: "secondary-button",
        href: `#/works/${encodeURIComponent(work.id)}/versions`,
        text: "查看历史版本",
      }),
    );
```

在 `handleAction` 分支新增恢复动作（放在 `action === "delete-work"` 附近）：

```js
  } else if (action === "restore-version") {
    const workId = trigger.dataset.workId;
    const sourceVersionId = trigger.dataset.sourceVersionId;
    const versionNumber = trigger.dataset.versionNumber;
    const changeSummary = window.prompt(
      `恢复到第 ${versionNumber} 版。请填写一句修改说明（必填）：`,
      `恢复第 ${versionNumber} 版`,
    );
    if (changeSummary === null) return;
    trigger.disabled = true;
    try {
      const versions = await service.listWorkVersions(workId);
      const expected = versions[0]?.version_number ?? null;
      await service.restoreWorkVersion({
        workId,
        sourceVersionId,
        expectedVersionNumber: expected,
        changeSummary: String(changeSummary).trim(),
      });
      await refreshWorks();
      showToast("已恢复旧版本。", "success");
      window.location.hash = `#/works/${encodeURIComponent(workId)}/versions`;
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    } finally {
      if (trigger.isConnected) trigger.disabled = false;
    }
  }
```

（`handleAction` 目前是同步 `else if` 链；若外层已是 `async`，直接 `await`；否则把该分支改为调用独立 `async` 函数 `handleRestoreVersion(trigger)`。）

- [ ] **Step 6: 运行静态 + 单元测试验证 GREEN**

Run:
```bash
node --test tests/static-checks.mjs
node --test tests/data-service.test.mjs
```
Expected: 全部 PASS。

- [ ] **Step 7: 运行浏览器桌面流程验证**

Run: `node tests/run-browser-check.cjs`
Expected: 桌面流程通过；阅读页出现「查看历史版本」，进入历史版本页显示版本卡。

- [ ] **Step 8: 提交**

```bash
git add js/app.js tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: add public version history page with restore entry for authors"
```

---

### Task 5: 前端写作台编辑模式与修改说明

**Files:**
- Modify: `js/app.js`（`renderWrite` 支持 `{ workId }`、编辑表单、提交分支）
- Modify: `tests/static-checks.mjs`
- Modify: `tests/browser-check.cjs`

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("写作台支持编辑既有作品并强制填写修改说明", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /renderWrite\(\s*\{[\s\S]*?workId/);
  assert.match(app, /name:\s*"changeSummary"/);
  assert.match(app, /createWorkVersion\(/);
  assert.match(app, /修改作品/);
  assert.match(app, /保存新版本/);
  assert.match(app, /当前为第\s*[\s\S]*?版|当前版本/);
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL。

- [ ] **Step 3: renderWrite 支持编辑模式**

把 `function renderWrite() {` 改为 `async function renderWrite(options = {}) {`，在 `requireVerifiedWrite("#/write")` 之后、读取 draft 之前加入编辑加载：

```js
  state.editingWork = null;
  let draft = readDraft();
  let editing = null;
  if (options.workId) {
    try {
      editing = await service.getWork(options.workId);
      const versions = await service.listWorkVersions(options.workId);
      state.editingWork = {
        work: editing,
        latestVersionNumber: versions[0]?.version_number ?? 1,
      };
      draft = {
        title: editing.title,
        excerpt: editing.excerpt,
        category: editing.category,
        content: editing.content,
      };
    } catch (error) {
      showError("作品无法编辑", error.message, true);
      return;
    }
  }
```

标题、提交按钮与版本提示按编辑态切换。把 `form.append(...)` 里的标题元素改为：

```js
      element("h1", {
        text: editing ? "修改作品" : "写一篇新作",
      }),
      editing
        ? element("p", {
            className: "profile-meta",
            text: `当前为第 ${state.editingWork.latestVersionNumber} 版 · 以笔名“${state.session.profile.pen_name}”保存`,
          })
        : element("p", {
            className: "profile-meta",
            text: `以笔名“${state.session.profile.pen_name}”发表`,
          }),
```

在正文 label 之后、`footer` 之前，编辑态追加修改说明字段：

```js
  if (editing) {
    form.append(
      element("label", {}, [
        element("span", { text: "修改说明（必填，1–200 字）" }),
        element("input", {
          name: "changeSummary",
          placeholder: "这版改了什么？例如：补充第三段",
          attrs: { required: true, maxlength: 200, autocomplete: "off" },
        }),
      ]),
    );
  }
```

`footer` 的提交按钮文本改为编辑态 `"保存新版本"`、否则 `"发布作品"`；`word-count` 初始化改用 `draft.content`。

- [ ] **Step 4: 提交分支支持编辑态**

在 `document.addEventListener("submit", ...)` 的 `writingForm` 分支里，`const submit = form.querySelector(...)` 之后按 `state.editingWork` 分流。把 `service.createWork({ ... })` 分支替换为：

```js
      const work = state.editingWork
        ? await service.createWorkVersion({
            workId: state.editingWork.work.id,
            expectedVersionNumber: state.editingWork.latestVersionNumber,
            title: data.get("title"),
            excerpt: data.get("excerpt"),
            category: data.get("category"),
            content: data.get("content"),
            changeSummary: data.get("changeSummary"),
          })
        : await service.createWork({
            title: data.get("title"),
            excerpt: data.get("excerpt"),
            category: data.get("category"),
            content: data.get("content"),
          });
      localStorage.removeItem(DRAFT_KEY);
      state.editingWork = null;
      await refreshWorks();
      showToast(state.editingWork ? "版本已保存。" : "作品已发布。", "success");
      window.location.hash = `#/works/${encodeURIComponent(work.id)}`;
```

注意把 `showToast` 的文案与 `state.editingWork` 置空顺序放对（先保存 `wasEditing = Boolean(state.editingWork)`，再置空）。

- [ ] **Step 5: 阅读页给作者加「修改作品」入口**

在 `renderWork` 的 `adminActions` 里、删除按钮之前追加：

```js
        element("button", {
          className: "quiet-button",
          type: "button",
          text: "修改作品",
          dataset: { action: "edit-work", workId: work.id },
        }),
```

在 `handleAction` 分支新增：

```js
  } else if (action === "edit-work") {
    const workId = trigger.dataset.workId;
    window.location.hash = `#/works/${encodeURIComponent(workId)}/edit`;
  }
```

- [ ] **Step 6: 运行静态 + 单元测试验证 GREEN**

Run:
```bash
node --test tests/static-checks.mjs
node --test tests/data-service.test.mjs
```
Expected: 全部 PASS。

- [ ] **Step 7: 运行浏览器流程验证**

Run: `node tests/run-browser-check.cjs`
Expected: 桌面流程通过；demo 中作者进入编辑页填写修改说明保存后回到作品页且版本号 +1。

- [ ] **Step 8: 提交**

```bash
git add js/app.js tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: add edit-mode writing desk that saves a new version with change summary"
```

---

### Task 6: 前端阅读页选区批注

**Files:**
- Modify: `js/app.js`（阅读页批注渲染 + 选区处理 + 提交）
- Modify: `assets/styles.css`
- Modify: `tests/static-checks.mjs`
- Modify: `tests/browser-check.cjs`

- [ ] **Step 1: 写失败的静态断言**

在 `tests/static-checks.mjs` 末尾追加：

```js
test("阅读页支持选区批注、浮动入口与批注列表", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /listWorkQuotes\(/);
  assert.match(app, /createQuotedComment\(/);
  assert.match(app, /添加批注/);
  assert.match(app, /getSelection\(\)/);
  assert.match(app, /data-annotatable/);
  assert.match(app, /quote_text/);
});
```

- [ ] **Step 2: 运行静态检查验证 RED**

Run: `node --test tests/static-checks.mjs`
Expected: 新增断言 FAIL。

- [ ] **Step 3: renderWork 并行拉取批注并渲染**

在 `renderWork` 里把 `const work = await service.getWork(workId);` 改为：

```js
    const [work, quotes] = await Promise.all([
      service.getWork(workId),
      service.listWorkQuotes(workId),
    ]);
```

在 `renderParagraphs(work.content, work.category)` 返回的 body 上打标注属性。把 `shell.append(...)` 里 `renderParagraphs(...)` 改为：

```js
      (() => {
        const body = renderParagraphs(work.content, work.category);
        body.dataset.workId = work.id;
        body.dataset.versionId = work.current_version_id ?? "";
        body.dataset.annotatable = "";
        return body;
      })(),
```

在 `authorNote` 之前追加批注块：

```js
    const quotesBlock = element("section", {
      className: "quotes-block",
      attrs: { "aria-labelledby": "quotes-title" },
    });
    quotesBlock.append(
      element("p", { className: "eyebrow", text: "ANNOTATIONS" }),
      element("h2", {
        id: "quotes-title",
        text: `批注 · ${quotes.length}`,
      }),
    );
    if (quotes.length) {
      const quoteList = element("ol", { className: "quote-list" });
      quotes.forEach((quote) => {
        const item = element("li", { className: "quote-item" }, [
          element("blockquote", { className: "quote-text", text: `“${quote.quote_text}”` }),
          element("p", {
            text: quote.is_deleted ? "该批注已删除" : quote.comment_content,
          }),
          element("div", { className: "discussion-meta" }, [
            element("span", { text: quote.user_pen_name }),
            element("time", {
              text: formatDate(quote.created_at),
              attrs: { datetime: quote.created_at },
            }),
          ]),
        ]);
        quoteList.append(item);
      });
      quotesBlock.append(quoteList);
    } else {
      quotesBlock.append(
        element("p", {
          className: "profile-meta",
          text: "还没有批注。选中正文中的一句话，写下你的发现。",
        }),
      );
    }
```

把 `quotesBlock` 插入 `shell.append` 中 `authorNote` 之前。

- [ ] **Step 4: 选区处理与浮动入口**

新增选区监听与浮动按钮（放在 `document.addEventListener` 之外定义，`initialize()` 里挂载一次）。在 `renderWork` 附近新增：

```js
let annotateButton = null;

function computeQuoteSelection(versionId) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const body = document.querySelector("[data-annotatable]");
  if (!body) return null;
  const anchorPara = selection.anchorNode?.parentElement?.closest("p");
  const focusPara = selection.focusNode?.parentElement?.closest("p");
  if (!anchorPara || anchorPara !== focusPara) {
    return { error: "请在同一段落内选择连续文字" };
  }
  if (!body.contains(anchorPara)) return null;
  const paragraphs = Array.from(body.querySelectorAll("p"));
  const paraIndex = paragraphs.indexOf(anchorPara);
  if (paraIndex < 0) return null;
  let displayOffset = 0;
  for (let i = 0; i < paraIndex; i += 1) {
    displayOffset += paragraphs[i].textContent.length + 1;
  }
  const text = anchorPara.textContent;
  const start = Math.min(selection.anchorOffset, selection.focusOffset);
  const end = Math.max(selection.anchorOffset, selection.focusOffset);
  if (end <= start) return null;
  return {
    quoteText: text.slice(start, end),
    startOffset: displayOffset + start,
    endOffset: displayOffset + end,
    versionId,
  };
}

function showAnnotateButton(event) {
  const body = event.target?.closest?.("[data-annotatable]");
  if (!body) return;
  const selection = computeQuoteSelection(body.dataset.versionId);
  if (!selection) return;
  if (selection.error) {
    showToast(selection.error);
    return;
  }
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  if (!annotateButton) {
    annotateButton = element("button", {
      className: "primary-button annotate-float",
      type: "button",
      text: "添加批注",
      dataset: { action: "open-annotation" },
    });
    annotateButton.style.position = "fixed";
    document.body.append(annotateButton);
  }
  annotateButton.style.left = `${Math.max(8, rect.left)}px`;
  annotateButton.style.top = `${rect.bottom + 8}px`;
  annotateButton.dataset.selection = JSON.stringify(selection);
  annotateButton.hidden = false;
}

function hideAnnotateButton() {
  if (annotateButton) annotateButton.hidden = true;
}
```

在 `initialize()` 里挂载事件：

```js
  document.addEventListener("mouseup", showAnnotateButton);
  document.addEventListener("selectionchange", () => {
    if (!window.getSelection()?.isCollapsed) return;
    hideAnnotateButton();
  });
```

在 `handleAction` 分支新增 `open-annotation`：弹出内联输入（用一个 `confirm` 式对话框或在浮动按钮旁追加 textarea）。为保持简洁，用 `window.prompt` 输入批注正文（≤2000 字）：

```js
  } else if (action === "open-annotation") {
    const raw = trigger.dataset.selection;
    if (!raw) return;
    const selection = JSON.parse(raw);
    const body = document.querySelector("[data-annotatable]");
    const content = window.prompt("写下这条批注（1–2000 字）：");
    if (content === null) return;
    const text = String(content).trim();
    if (!text) return;
    try {
      const result = await service.createQuotedComment({
        workId: body.dataset.workId,
        workVersionId: selection.versionId || body.dataset.versionId,
        quoteText: selection.quoteText,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        content: text,
      });
      showToast("批注已发表。", "success");
      hideAnnotateButton();
      await renderWork(body.dataset.workId);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    }
  }
```

（`handleAction` 分支链若为同步函数，将本分支提为独立 `async function handleOpenAnnotation(trigger)` 并调用。）

- [ ] **Step 5: 批注样式**

在 `assets/styles.css` 追加：

```css
.quotes-block {
  margin: 3rem 0;
  border-top: 1px solid var(--hairline);
}
.quote-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.quote-item {
  padding: 1.25rem 0;
  border-bottom: 1px solid var(--hairline);
}
.quote-text {
  margin: 0 0 0.5rem;
  color: var(--cinnabar, #9a3b2e);
  font-style: normal;
}
.annotate-float {
  z-index: 50;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
}
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.version-card {
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--hairline);
}
.version-card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: baseline;
}
.version-badge {
  font-family: var(--utility);
  color: var(--soft-ink);
}
.version-summary {
  margin: 0.5rem 0;
}
.version-body summary {
  cursor: pointer;
  font-family: var(--utility);
  color: var(--soft-ink);
}
```

（`--cinnabar`/`--hairline` 若未定义，改用现有 CSS 变量名，并在文件中替换为已存在的变量。）

- [ ] **Step 6: 运行静态 + 单元测试验证 GREEN**

Run:
```bash
node --test tests/static-checks.mjs
node --test tests/data-service.test.mjs
```
Expected: 全部 PASS。

- [ ] **Step 7: 浏览器验证选区批注**

在 `tests/browser-check.cjs` 的桌面流程追加（用 demo 数据，进入某篇作品，选中正文第一段的一部分，出现浮动按钮，提交批注后批注数 +1）——若浏览器流程暂难稳定驱动选区，至少断言阅读页出现「批注 · N」块与「查看历史版本」入口。

- [ ] **Step 8: 提交**

```bash
git add js/app.js assets/styles.css tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: add text-selection annotation entry and versioned quotes on reading page"
```

---

### Task 7: 全量回归与发布前检查

**Files:**
- 全仓库只读检查；必要时更新 `README.md`、`SECURITY.md`、`docs/superpowers/plans/2026-08-08-...` 备注。

- [ ] **Step 1: 全量测试**

Run:
```bash
npm test
```
Expected: 单元 + 浏览器全部通过（既有 206 + 新增版本/批注测试全绿）。

- [ ] **Step 2: 行为差异复核**

Run: `node tests/run-browser-check.cjs`
手动核对：demo 中创作 → 编辑填修改说明保存 → 版本号 +1；历史版本页显示全部版本、作者可「恢复此版本」；阅读页选句出「添加批注」、提交后「批注 · N」出现且进入讨论列表；既有四流程无回归。

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

向用户汇报：新迁移 `20260808_work_versions_and_quotes.sql` 需在测试项目（ref `rcrqosnbkojaarppvcac`）SQL Editor 执行、验证回填（每篇作品第 1 版）、`create_work_version`/`restore_work_version`/`create_quoted_comment`/`list_work_versions`/`list_work_quotes` 行为；**必须停下请求用户批准后再向 staging 写入。**

- [ ] **Step 6: 提交文档更新（若改动了 README/SECURITY）**

```bash
git add README.md SECURITY.md
git commit -m "docs: record release-3 version and annotation rollout order"
```

---

## Self-Review

**Spec 覆盖核对（设计文档阶段 C / 第 5.4/5.5/6/8/13 节 + 待办清单「发布3」）：**

- 新增 `work_versions`（work_id、单调递增 version_number、标题/摘要/分类/正文快照、修改说明、restored_from_version_id、创建者、创建时间）→ Task 1 表定义 + `create_work_version`/`restore_work_version`。
- `works` 增加当前版本指针并保留身份/作者/状态/推荐 + 最新内容缓存 → Task 1 `current_version_id` 列 + RPC 同事务更新缓存。
- 迁移现有作品为第 1 版 → Task 1 回填 + 测试「回填」。
- 受保护 RPC（同一事务）：创建新版本（作者必填修改说明、携带版本号、版本变化拒绝覆盖）、恢复旧版本（复制为新版、记录来源、不删历史）、创建引用批注（记录当前可见版本号）→ Task 1 三个 RPC。
- `comment_quotes`：评论 ID、作品版本 ID、引用原文、起止位置、创建时间，引用不随后续版本变化 → Task 1 表 + 测试「保存正确版本原文与位置」。
- RLS：已发布历史公开；只有作者能建新版本；管理员不能冒充作者改正文；引用不可伪造 → Task 1 策略 + 测试「非作者与管理员」「引用位置不符」「无法直接写入」。
- 阅读页只显示最新版；历史入口公开展示全部版本号/时间/修改说明/正文快照；作者可恢复、读者只读 → Task 4。
- 写作台改「产生新版本」，保存前填修改说明 → Task 5。
- 读者选当前可见版本连续文字建公开批注；桌面正文旁/移动正文下集中显示；批注进作品讨论与全站讨论 → Task 6 + `browse_discussions` 天然包含批注评论（既有功能）。
- 测试：版本单调递增、修改不覆盖历史、恢复不丢历史 → Task 1/2 测试；迁移前后数量/作者/快照/版本数一致 → Task 1「回填」测试；四类身份 RLS → Task 1「未验证」「非作者与管理员」。

**占位符扫描：** 无 TBD/TODO；每个代码步骤含完整实现。`window.prompt` 用于批注/恢复的临时交互，后续发布5 可升级为对话框组件（不阻塞本发布）。

**类型一致性：** 版本对象 `version_number/change_summary/restored_from_version_id/created_by/created_at` 在 demo、supabase RPC、DB 三处一致；批注偏移为「展示串」0 基字符偏移，前端 `computeQuoteSelection` 与 SQL `create_quoted_comment` 用同一分段/修剪规则；RPC 参数名 `p_work_id/p_expected_version_number/p_source_version_id/p_quote_text/p_start_offset/p_end_offset/p_content/p_change_summary` 前后端一致。

**已知边界：** 批注仅支持同一段落内的连续选区（跨段选区提示重新选择）；`window.prompt` 为轻量交互占位。这两点已在计划中显式声明，不阻塞功能完成。
