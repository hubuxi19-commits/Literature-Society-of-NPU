import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const governanceMigrationUrl = new URL(
  "../supabase/migrations/20260811_governance_and_admin.sql",
  import.meta.url,
);

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
  await db.exec(await readFile(schemaUrl, "utf8"));
  await db.exec(await readFile(governanceMigrationUrl, "utf8"));
  return db;
}

test("治理四张新表结构 + RLS + revoke 直接访问", async () => {
  const db = await createDatabase();
  try {
    const { rows } = await db.query(`
      select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public'
        and c.relname in ('work_editorial_notes', 'comment_highlights', 'reports', 'moderation_actions')
      order by c.relname, a.attnum
    `);
    const byTable = {};
    for (const row of rows) byTable[row.tbl] = [...(byTable[row.tbl] ?? []), row.col];
    for (const col of ["work_id", "note_type", "content", "admin_id"]) {
      assert.ok(byTable.work_editorial_notes.includes(col), `work_editorial_notes.${col}`);
    }
    for (const col of ["comment_id", "work_id", "reason", "admin_id"]) {
      assert.ok(byTable.comment_highlights.includes(col), `comment_highlights.${col}`);
    }
    for (const col of ["reporter_id", "target_type", "target_id", "reason_type", "status"]) {
      assert.ok(byTable.reports.includes(col), `reports.${col}`);
    }
    for (const col of ["report_id", "target_type", "target_id", "decision", "action_type", "internal_note", "admin_id"]) {
      assert.ok(byTable.moderation_actions.includes(col), `moderation_actions.${col}`);
    }
    for (const tbl of ["work_editorial_notes", "comment_highlights", "reports", "moderation_actions"]) {
      const { rows: rls } = await db.query(
        `select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`, [tbl]);
      assert.equal(rls[0].relrowsecurity, true, `${tbl} RLS 开启`);
      assert.equal(
        (await db.query(`select has_table_privilege('authenticated', 'public.${tbl}', 'SELECT') as ok`)).rows[0].ok,
        false, `${tbl} authenticated SELECT 被 revoke`);
    }
    // 通知表 payload 列 + 新事件类型约束
    const { rows: payloadCol } = await db.query(`
      select count(*)::int as n from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'notifications' and a.attname = 'payload' and not a.attisdropped
    `);
    assert.equal(payloadCol[0].n, 1, "notifications.payload 列存在");
  } finally {
    await db.close();
  }
});

const USER_A = "10000000-0000-4000-8000-000000000001"; // 松声
const USER_B = "10000000-0000-4000-8000-000000000002"; // 白露
const USER_C = "10000000-0000-4000-8000-000000000003"; // 杏雨
const ADMIN_D = "10000000-0000-4000-8000-000000000004"; // 编辑部
const WORK_1 = "20000000-0000-4000-8000-000000000001"; // 作者 A
const WORK_2 = "20000000-0000-4000-8000-000000000002"; // 作者 B
const COMMENT_1 = "30000000-0000-4000-8000-000000000001"; // B 在 WORK_1 的顶层评论

async function seed(db) {
  for (const [id, email, penName] of [
    [USER_A, "a@x.test", "松声"],
    [USER_B, "b@x.test", "白露"],
    [USER_C, "c@x.test", "杏雨"],
    [ADMIN_D, "d@x.test", "编辑部"],
  ]) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, jsonb_build_object('pen_name', $3::text))`,
      [id, email, penName],
    );
  }
  await db.exec(`update public.profiles set role = 'admin' where id = '${ADMIN_D}'`);
  await db.exec(`
    insert into public.works (id, author_id, title, excerpt, content, category, status, created_at)
    values
      ('${WORK_1}', '${USER_A}', '末班车', '友谊校区', '第一段正文。\n\n第二段正文。', '散文', 'published', now() - '10 minutes'::interval),
      ('${WORK_2}', '${USER_B}', '白露集', '白露', '白露的正文。', '新诗', 'published', now() - '5 minutes'::interval)
  `);
  await db.exec(`
    insert into public.comments (id, work_id, user_id, parent_id, content, created_at)
    values ('${COMMENT_1}', '${WORK_1}', '${USER_B}', null, '评论一', now() - '3 minutes'::interval)
  `);
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

async function notificationsFor(db, userId) {
  const { rows } = await db.query(
    "select * from public.notifications where user_id = $1 order by last_event_at desc",
    [userId],
  );
  return rows;
}

test("举报：幂等、禁止自举报、目标不存在拒绝", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // B 举报 WORK_1（作者 A）
    const { rows: first } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload",
      ["work", WORK_1, "violation", "疑似抄袭"]);
    assert.equal(first[0].payload.status, "reported");
    // 幂等：重复举报返回 already_reported
    const { rows: again } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload",
      ["work", WORK_1, "violation", "再次"]);
    assert.equal(again[0].payload.status, "already_reported");
    // 自举报拒绝：A 举报自己的作品
    const selfError = await expectError(asRole(db, "authenticated", USER_A,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(selfError.message, /不能举报自己的内容/);
    // 目标不存在
    const missingError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4)",
      ["work", "99999999-0000-4000-8000-000000000000", "violation", "x"]));
    assert.match(missingError.message, /举报目标不存在/);
    // 未登录拒绝：report_content 已从 public revoke、仅授 authenticated，
    // anon 在函数边界即被拒（函数体内 '请先登录' 检查不可达）
    const anonError = await expectError(asRole(db, "anon", null,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(anonError.message, /permission denied/);
  } finally {
    await db.close();
  }
});

test("write_gate=enforce 未验证用户举报被拒，绑定后放行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    const rejected = await expectError(asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "x"]));
    assert.match(rejected.message, /找回邮箱/);
    await db.exec(`
      insert into public.account_recovery_emails (user_id, email_normalized, verified_at)
      values ('${USER_B}', 'b-recovery@x.test', now())
    `);
    const { rows } = await asRole(db, "authenticated", USER_B,
      "select public.report_content($1, $2, $3, $4) as payload", ["work", WORK_1, "violation", "x"]);
    assert.equal(rows[0].payload.status, "reported");
  } finally {
    await db.close();
  }
});

test("举报越权读取：非管理员读不到他人举报，管理员可见", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "spam", "垃圾内容"]);
    // 非管理员 list_reports 被拒
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.list_reports('pending')"));
    assert.match(denied.message, /没有权限/);
    // 管理员可见举报者身份
    const { rows } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    assert.equal(rows[0].payload.reports.length, 1);
    assert.equal(rows[0].payload.reports[0].reporter_pen_name, "杏雨");
    assert.equal(rows[0].payload.reports[0].target_preview, "末班车");
  } finally {
    await db.close();
  }
});

test("处置成立 hide_work：作品隐藏、浏览排除、审计记录、moderation_outcome 通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "内容违规"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    // 非管理员处置被拒
    const denied = await expectError(asRole(db, "authenticated", USER_B,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "resolved", "hide_work", "确认违规"]));
    assert.match(denied.message, /没有权限/);
    // 管理员处置成立 → hide_work
    const { rows: acted } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId, "resolved", "hide_work", "确认违规"]);
    assert.equal(acted[0].payload.status, "resolved");
    assert.equal(acted[0].payload.action_type, "hide_work");
    // 作品状态隐藏
    const { rows: work } = await db.query(
      "select status from public.works where id = $1", [WORK_1]);
    assert.equal(work[0].status, "hidden");
    // 审计记录
    const { rows: audit } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_moderation_actions() as payload");
    assert.equal(audit[0].payload.actions.length, 1);
    assert.equal(audit[0].payload.actions[0].internal_note, "确认违规");
    assert.equal(audit[0].payload.actions[0].admin_pen_name, "编辑部");
    // 被举报者收到 moderation_outcome 通知，含决策不含内部说明
    const aRows = await notificationsFor(db, USER_A);
    const outcome = aRows.find((n) => n.event_type === "moderation_outcome");
    assert.ok(outcome, "作者 A 收到处置结果通知");
    assert.equal(outcome.payload.decision, "resolved");
    assert.equal(outcome.payload.action_type, "hide_work");
    assert.ok(!JSON.stringify(outcome.payload).includes("确认违规"), "内部说明不进入通知");
    // 重复处置被拒
    const againError = await expectError(asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "dismissed", null, "重复"]));
    assert.match(againError.message, /已处置/);
  } finally {
    await db.close();
  }
});

test("list_notifications 透传 payload：moderation_outcome 含 decision/action_type", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["work", WORK_1, "violation", "内容违规"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4)", [reportId, "resolved", "hide_work", "确认"]);
    // 作者 A 调用 list_notifications 应能读到 payload
    const { rows } = await asRole(db, "authenticated", USER_A,
      "select public.list_notifications() as payload");
    const n = rows[0].payload.notifications.find((x) => x.event_type === "moderation_outcome");
    assert.ok(n, "作者 A 收到处置结果通知");
    assert.equal(n.payload.decision, "resolved");
    assert.equal(n.payload.action_type, "hide_work");
  } finally {
    await db.close();
  }
});

test("处置驳回与 hide_comment：不成立写审计且不隐藏，成立隐藏评论", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // 举报评论
    await asRole(db, "authenticated", USER_C,
      "select public.report_content($1, $2, $3, $4)", ["comment", COMMENT_1, "spam", "广告"]);
    const { rows: list } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId = list[0].payload.reports[0].id;
    // 驳回：不填动作
    const { rows: dismissed } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId, "dismissed", null, "证据不足"]);
    assert.equal(dismissed[0].payload.status, "dismissed");
    const { rows: cm } = await db.query(
      "select is_deleted from public.comments where id = $1", [COMMENT_1]);
    assert.equal(cm[0].is_deleted, false, "驳回不隐藏评论");
    const { rows: audit } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_moderation_actions() as payload");
    assert.equal(audit[0].payload.actions[0].decision, "dismissed");
    assert.equal(audit[0].payload.actions[0].action_type, null);
    // 新举报后 hide_comment
    // 注：USER_C 已举报过 COMMENT_1（reports 有 unique(reporter_id,target_type,target_id)），
    // 同一举报人不能再次举报，改用 USER_A（作品作者，非评论作者）举报。
    await asRole(db, "authenticated", USER_A,
      "select public.report_content($1, $2, $3, $4)", ["comment", COMMENT_1, "violation", "违规"]);
    const { rows: list2 } = await asRole(db, "authenticated", ADMIN_D,
      "select public.list_reports('pending') as payload");
    const reportId2 = list2[0].payload.reports[0].id;
    const { rows: acted } = await asRole(db, "authenticated", ADMIN_D,
      "select public.moderate_report($1, $2, $3, $4) as payload",
      [reportId2, "resolved", "hide_comment", "确认违规"]);
    assert.equal(acted[0].payload.action_type, "hide_comment");
    const { rows: cm2 } = await db.query(
      "select is_deleted from public.comments where id = $1", [COMMENT_1]);
    assert.equal(cm2[0].is_deleted, true, "hide_comment 软删评论");
    // 评论作者 B 收到处置通知
    const bRows = await notificationsFor(db, USER_B);
    assert.ok(bRows.some((n) => n.event_type === "moderation_outcome"), "评论作者收到通知");
  } finally {
    await db.close();
  }
});

test("编辑点评与推荐理由：非管理员被拒、管理员 upsert、公开可读", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.set_work_editorial_note($1, $2, $3)",
      [WORK_1, "editorial_note", "这句写得好"]));
    assert.match(denied.message, /没有权限/);
    // 管理员 upsert 推荐理由
    const { rows: rec } = await asRole(db, "authenticated", ADMIN_D,
      "select public.set_work_editorial_note($1, $2, $3) as payload",
      [WORK_1, "recommendation_reason", "本期编辑推荐"]);
    assert.equal(rec[0].payload.note_type, "recommendation_reason");
    // upsert 覆盖
    await asRole(db, "authenticated", ADMIN_D,
      "select public.set_work_editorial_note($1, $2, $3)", [WORK_1, "recommendation_reason", "新推荐语"]);
    // 公开读（anon）
    const { rows: anonEd } = await asRole(db, "anon", null,
      "select public.get_work_editorial($1) as payload", [WORK_1]);
    assert.equal(anonEd[0].payload.recommendation_reason.content, "新推荐语");
    assert.equal(anonEd[0].payload.recommendation_reason.admin_pen_name, "编辑部");
    assert.equal(anonEd[0].payload.editorial_note.content, null, "无编辑点评时 content 为 null");
  } finally {
    await db.close();
  }
});

test("优质评论推荐：非管理员被拒、管理员推荐触发通知、取消推荐", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const denied = await expectError(asRole(db, "authenticated", USER_A,
      "select public.highlight_comment($1, $2)", [COMMENT_1, "值得一读"]));
    assert.match(denied.message, /没有权限/);
    const { rows: hl } = await asRole(db, "authenticated", ADMIN_D,
      "select public.highlight_comment($1, $2) as payload", [COMMENT_1, "观点清晰"]);
    assert.equal(hl[0].payload.comment_id, COMMENT_1);
    // 评论作者 B 收到 comment_highlight 通知
    const bRows = await notificationsFor(db, USER_B);
    const notif = bRows.find((n) => n.event_type === "comment_highlight");
    assert.ok(notif, "评论作者收到推荐通知");
    assert.equal(notif.target_comment_id, COMMENT_1);
    assert.deepEqual(notif.actor_ids, [ADMIN_D]);
    // 公开读 highlights
    const { rows: highlights } = await asRole(db, "anon", null,
      "select public.get_work_highlights($1) as payload", [WORK_1]);
    assert.equal(highlights[0].payload.highlights.length, 1);
    assert.equal(highlights[0].payload.highlights[0].reason, "观点清晰");
    // 取消推荐
    await asRole(db, "authenticated", ADMIN_D,
      "select public.unhighlight_comment($1)", [COMMENT_1]);
    const { rows: after } = await asRole(db, "anon", null,
      "select public.get_work_highlights($1) as payload", [WORK_1]);
    assert.equal(after[0].payload.highlights.length, 0);
  } finally {
    await db.close();
  }
});

test("迁移完整性：治理函数齐全 + 授权面 + moderation_actions 无写策略", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: funcs } = await db.query(`
      select proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and proname in (
          'report_content','moderate_report','set_work_editorial_note',
          'highlight_comment','unhighlight_comment','list_reports',
          'list_moderation_actions','get_work_editorial','get_work_highlights'
        )
    `);
    assert.equal(funcs.length, 9, "9 个治理函数齐全");
    // 写/管理 RPC：authenticated 可执行
    for (const sig of [
      "public.report_content(text, uuid, text, text)",
      "public.moderate_report(uuid, text, text, text)",
      "public.set_work_editorial_note(uuid, text, text)",
      "public.highlight_comment(uuid, text)",
      "public.unhighlight_comment(uuid)",
    ]) {
      assert.equal(
        (await db.query(`select has_function_privilege('authenticated', '${sig}', 'EXECUTE') as ok`)).rows[0].ok,
        true, `${sig} authenticated 可执行`);
    }
    // 公开读 RPC：anon 可执行
    for (const sig of ["public.get_work_editorial(uuid)", "public.get_work_highlights(uuid)"]) {
      assert.equal(
        (await db.query(`select has_function_privilege('anon', '${sig}', 'EXECUTE') as ok`)).rows[0].ok,
        true, `${sig} anon 可执行`);
    }
    // 授权矩阵加固：anon 不可执行写/管理 RPC（安全红线）
    for (const sig of [
      "public.report_content(text, uuid, text, text)",
      "public.moderate_report(uuid, text, text, text)",
      "public.set_work_editorial_note(uuid, text, text)",
      "public.highlight_comment(uuid, text)",
      "public.unhighlight_comment(uuid)",
      "public.list_reports(text)",
      "public.list_moderation_actions()",
    ]) {
      assert.equal(
        (await db.query(`select has_function_privilege('anon', '${sig}', 'EXECUTE') as ok`)).rows[0].ok,
        false, `${sig} anon 不可执行`);
    }
    // moderation_actions 无 update/delete 策略（审计只读红线）：polcmd 'r'=select, 'u'=update, 'd'=delete, 'a'=all
    const { rows: policies } = await db.query(`
      select polname, polcmd
      from pg_policy
      where polrelid = 'public.moderation_actions'::regclass
    `);
    assert.ok(policies.length > 0, "moderation_actions 应至少有一条策略");
    for (const row of policies) {
      assert.ok(!["u", "d", "a"].includes(row.polcmd),
        `moderation_actions 不应有 update/delete/all 策略：${row.polname} (polcmd=${row.polcmd})`);
    }
  } finally {
    await db.close();
  }
});
