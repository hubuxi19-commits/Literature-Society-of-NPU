import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { splitDisplayParagraphs } from "../js/utils.mjs";

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
const SOCIAL_START = "-- SOCIAL_NOTIFICATIONS_START";
const SOCIAL_END = "-- SOCIAL_NOTIFICATIONS_END";
const GOVERNANCE_START = "-- GOVERNANCE_ADMIN_START";
const GOVERNANCE_END = "-- GOVERNANCE_ADMIN_END";

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
    stripBlock(
      stripBlock(
        stripBlock(await readFile(schemaUrl, "utf8"), BROWSE_START, BROWSE_END),
        VERSIONS_START,
        VERSIONS_END,
      ),
      SOCIAL_START,
      SOCIAL_END,
    ),
    GOVERNANCE_START,
    GOVERNANCE_END,
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
       values ($1, $2, jsonb_build_object('pen_name', $3::text))`,
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
  return splitDisplayParagraphs(content).join("\n");
}

test("回填：每篇作品恰好一个第 1 版，快照与作者一致", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows } = await db.query(`
      select
        w.id, w.author_id, w.content, w.current_version_id,
        v.id as version_id, v.version_number, v.title, v.excerpt, v.content as v_content, v.category,
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
      assert.equal(row.current_version_id, row.version_id, "current_version_id 指向第 1 版");
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
    // 展示串 = "第一段正文。\n第二段正文。"；offset [7,13) 是"第二段正文。"
    const { rows } = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第二段正文。', 7, 13, '这句最准。') as payload
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
    assert.equal(quoteRows[0].end_offset, 13);
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
    const workDelete = await expectError(asRole(db, "authenticated", USER_A, `
      delete from public.works where id = '${WORK_1}'
    `));
    assert.match(workDelete.message, /permission/i);
  } finally {
    await db.close();
  }
});

test("批注展示串与前端 renderParagraphs 一致（单空格分隔与全角缩进段）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const content = "第一段。\n \n第二段。\n\n　第三段（全角缩进）";
    const display = displayString(content);
    const middlePara = "第二段。";
    const start = display.indexOf(middlePara);
    const end = start + middlePara.length;
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, '一致性', '', '散文', '${content}', '') as payload
    `);
    const payload = rows[0].payload;
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [payload.work_id],
    );
    const v1 = verRows[0].id;
    const quoted = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${payload.work_id}', '${v1}', '${middlePara}', ${start}, ${end}, '全角缩进也不影响选中。') as payload
    `);
    assert.equal(quoted.rows[0].payload.quote.quote_text, middlePara);
    const { rows: quoteList } = await asRole(db, "anon", null, `
      select public.list_work_quotes('${payload.work_id}') as payload
    `);
    assert.equal(quoteList[0].payload[0].quote_text, middlePara);
  } finally {
    await db.close();
  }
});

test("批注 emoji 正文按码点偏移对齐（char_length/substr 语义，emoji 占 1 码点）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const content = "第一段😀。\n\n第二段。";
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, 'emoji 正文', '', '散文', '${content}', '') as payload
    `);
    const payload = rows[0].payload;
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [payload.work_id],
    );
    const v1 = verRows[0].id;
    // 展示串 = "第一段😀。\n第二段。"；码点偏移 [6,10) 是"第二段。"
    const quoted = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${payload.work_id}', '${v1}', '第二段。', 6, 10, 'emoji 前批注') as payload
    `);
    assert.equal(quoted.rows[0].payload.quote.quote_text, "第二段。");
    const { rows: quoteRows } = await db.query(
      "select start_offset, end_offset from public.comment_quotes where comment_id = $1",
      [quoted.rows[0].payload.comment.id],
    );
    assert.equal(quoteRows[0].start_offset, 6);
    assert.equal(quoteRows[0].end_offset, 10);
  } finally {
    await db.close();
  }
});

test("批注段首 NBSP 不被 trim（展示串与 SQL btrim 字符集一致）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const content = " 第一段。\n\n第二段。";
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, 'NBSP 正文', '', '散文', '${content}', '') as payload
    `);
    const payload = rows[0].payload;
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [payload.work_id],
    );
    const v1 = verRows[0].id;
    // 展示串 = " 第一段。\n第二段。"；码点偏移 [6,10) 是"第二段。"
    const quoted = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${payload.work_id}', '${v1}', '第二段。', 6, 10, 'NBSP 前批注') as payload
    `);
    assert.equal(quoted.rows[0].payload.quote.quote_text, "第二段。");
  } finally {
    await db.close();
  }
});

test("仅含全角空格的空行在展示串中同样被分段", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const content = "第一段。\n　\n第二段。";
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_work_version(null, null, '全角空格空行', '', '散文', '${content}', '') as payload
    `);
    const payload = rows[0].payload;
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [payload.work_id],
    );
    const v1 = verRows[0].id;
    // 展示串 = "第一段。\n第二段。"；码点偏移 [5,9) 是"第二段。"
    const quoted = await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${payload.work_id}', '${v1}', '第二段。', 5, 9, '全角空格空行批注') as payload
    `);
    assert.equal(quoted.rows[0].payload.quote.quote_text, "第二段。");
  } finally {
    await db.close();
  }
});

test("隐藏作品：非作者/非管理员不能创建批注，作者本人不受可见性阻断", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    await db.exec(`update public.works set status = 'hidden' where id = '${WORK_1}'`);
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [WORK_1],
    );
    const v1 = verRows[0].id;
    const memberError = await expectError(asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第二段正文。', 7, 13, '他人不能批注隐藏作品') as payload
    `));
    assert.match(memberError.message, /作品不存在/);
    const { rows } = await asRole(db, "authenticated", USER_A, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第二段正文。', 7, 13, '作者自批') as payload
    `);
    assert.equal(rows[0].payload.quote.quote_text, "第二段正文。");
  } finally {
    await db.close();
  }
});

test("修改说明超过 200 字符被拒绝", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const longSummary = "长".repeat(201);
    const error = await expectError(asRole(db, "authenticated", USER_A, `
      select public.create_work_version('${WORK_1}', 1, 'x', '', '散文', 'y', '${longSummary}') as payload
    `));
    assert.match(error.message, /不能超过 200/);
    const restoreError = await expectError(asRole(db, "authenticated", USER_A, `
      select public.restore_work_version('${WORK_1}', '00000000-0000-4000-8000-000000000000', 1, '${longSummary}') as payload
    `));
    assert.match(restoreError.message, /不能超过 200/);
  } finally {
    await db.close();
  }
});

test("delete_work：作者删除自己的作品并级联清理批注与版本", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const { rows: verRows } = await db.query(
      "select id from public.work_versions where work_id = $1 and version_number = 1",
      [WORK_1],
    );
    const v1 = verRows[0].id;
    await asRole(db, "authenticated", USER_B, `
      select public.create_quoted_comment('${WORK_1}', '${v1}', '第二段正文。', 7, 13, '要一起删掉的批注') as payload
    `);
    await asRole(db, "authenticated", USER_A, `
      select public.delete_work('${WORK_1}')
    `);
    const workCount = await db.query("select count(*)::int as n from public.works where id = $1", [WORK_1]);
    assert.equal(workCount.rows[0].n, 0);
    const verCount = await db.query("select count(*)::int as n from public.work_versions where work_id = $1", [WORK_1]);
    assert.equal(verCount.rows[0].n, 0);
    const commentCount = await db.query("select count(*)::int as n from public.comments where work_id = $1", [WORK_1]);
    assert.equal(commentCount.rows[0].n, 0);
    const quoteCount = await db.query("select count(*)::int as n from public.comment_quotes where work_version_id = $1", [v1]);
    assert.equal(quoteCount.rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("delete_work：非作者删除被拒", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    const error = await expectError(asRole(db, "authenticated", USER_B, `
      select public.delete_work('${WORK_1}')
    `));
    assert.match(error.message, /没有权限/);
  } finally {
    await db.close();
  }
});

test("delete_work：管理员可删除他人作品", async () => {
  const db = await createDatabase();
  try {
    await seed(db, { withAdmin: true });
    await applyVersionsMigration(db);
    await asRole(db, "authenticated", ADMIN_D, `
      select public.delete_work('${WORK_1}')
    `);
    const workCount = await db.query("select count(*)::int as n from public.works where id = $1", [WORK_1]);
    assert.equal(workCount.rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("delete_work：未验证账号在 write_gate=enforce 时被拒", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await applyVersionsMigration(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    const error = await expectError(asRole(db, "authenticated", USER_B, `
      select public.delete_work('${WORK_1}')
    `));
    assert.match(error.message, /找回邮箱/);
  } finally {
    await db.close();
  }
});
