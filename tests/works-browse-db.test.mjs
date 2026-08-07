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
      (case when i % 3 = 1 then '${USER_A}' when i % 3 = 0 then '${USER_B}' else '${USER_C}' end)::uuid,
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
    insert into public.comments (id, work_id, user_id, content, is_deleted, created_at)
    values
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '${USER_B}', '评论一', false, now() - '2 minutes'::interval),
      ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '${USER_A}', '评论二', false, now() - '1 minutes'::interval),
      ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '${USER_C}', '评论三', false, now() - '3 minutes'::interval),
      ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '${USER_C}', '已删除评论', true, now() - '4 minutes'::interval)
  `);
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
    assert.equal("content" in first, true, "分页列表每页返回正文 content");
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
    assert.equal(payload.discussions.length, 4);
    assert.equal(payload.next_cursor, null);
    assert.equal(payload.discussions[0].work_title, "作品标题1");
    assert.equal(payload.discussions[0].user_pen_name, "松声");
    const ids = payload.discussions.map((d) => d.id);
    assert.equal(new Set(ids).size, 4, "讨论不重复");
    const deleted = payload.discussions.find(
      (d) => d.id === "30000000-0000-4000-8000-000000000004",
    );
    assert.equal(deleted.is_deleted, true, "软删除评论带标记返回");
  } finally {
    await db.close();
  }
});

test("browse_works comment_count 排除已删除评论", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows } = await asRole(db, "anon", null, `
      select public.browse_works('', '全部', 'discussions', null, 10) as payload
    `);
    const work1 = rows[0].payload.works.find(
      (w) => w.id === "20000000-0000-4000-8000-000000000001",
    );
    assert.equal(work1.comment_count, 2, "已删除评论不应计入 comment_count");
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
