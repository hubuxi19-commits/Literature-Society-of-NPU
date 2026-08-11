import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const socialMigrationUrl = new URL(
  "../supabase/migrations/20260810_social_and_notifications.sql",
  import.meta.url,
);

const USER_A = "10000000-0000-4000-8000-000000000001"; // 松声
const USER_B = "10000000-0000-4000-8000-000000000002"; // 白露
const USER_C = "10000000-0000-4000-8000-000000000003"; // 杏雨
const ADMIN_D = "10000000-0000-4000-8000-000000000004"; // 编辑部
const USER_E = "10000000-0000-4000-8000-000000000005"; // 星野
const WORK_1 = "20000000-0000-4000-8000-000000000001"; // 作者 A
const WORK_2 = "20000000-0000-4000-8000-000000000002"; // 作者 B
const COMMENT_1 = "30000000-0000-4000-8000-000000000001"; // B 在 WORK_1 的顶层评论
const COMMENT_2 = "30000000-0000-4000-8000-000000000002"; // C 对 COMMENT_1 的回复

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
  await db.exec(await readFile(socialMigrationUrl, "utf8"));
  return db;
}

async function seed(db) {
  for (const [id, email, penName] of [
    [USER_A, "a@x.test", "松声"],
    [USER_B, "b@x.test", "白露"],
    [USER_C, "c@x.test", "杏雨"],
    [ADMIN_D, "d@x.test", "编辑部"],
    [USER_E, "e@x.test", "星野"],
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
    values
      ('${COMMENT_1}', '${WORK_1}', '${USER_B}', null, '评论一', now() - '3 minutes'::interval),
      ('${COMMENT_2}', '${WORK_1}', '${USER_C}', '${COMMENT_1}', '回复一', now() - '2 minutes'::interval)
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

test("四张新表结构与授权收口（revoke 直接表访问）", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: tables } = await db.query(`
      select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public'
        and c.relname in ('follows', 'bookmarks', 'comment_likes', 'notifications')
      order by c.relname, a.attnum
    `);
    const byTable = {};
    for (const row of tables) {
      byTable[row.tbl] = byTable[row.tbl] ?? [];
      byTable[row.tbl].push(row.col);
    }
    for (const col of ["follower_id", "following_id", "created_at"]) {
      assert.ok(byTable.follows.includes(col), `follows.${col}`);
    }
    for (const col of ["user_id", "work_id", "created_at"]) {
      assert.ok(byTable.bookmarks.includes(col), `bookmarks.${col}`);
    }
    for (const col of ["user_id", "comment_id", "created_at"]) {
      assert.ok(byTable.comment_likes.includes(col), `comment_likes.${col}`);
    }
    for (const col of [
      "id", "user_id", "event_type", "target_work_id", "target_comment_id",
      "actor_ids", "actor_count", "last_event_at", "is_read", "agg_key",
    ]) {
      assert.ok(byTable.notifications.includes(col), `notifications.${col}`);
    }
    const insertError = await expectError(asRole(db, "authenticated", USER_A, `
      insert into public.follows (follower_id, following_id)
      values ('${USER_A}', '${USER_B}')
    `));
    assert.match(insertError.message, /permission denied/);
    const selectError = await expectError(asRole(db, "authenticated", USER_B, `
      select * from public.follows
    `));
    assert.match(selectError.message, /permission denied/);
  } finally {
    await db.close();
  }
});

test("follow 聚合：同目标 +N 折叠、最近者居前、去重幂等、预览 cap 3", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", ADMIN_D, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_E, "select public.follow_user($1)", [USER_A]);
    let rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1, "同目标同类型只聚合一条");
    assert.equal(rows[0].event_type, "follow");
    assert.equal(rows[0].actor_count, 4, "4 个不同 actor 计数正确");
    assert.deepEqual(rows[0].actor_ids, [USER_E, ADMIN_D, USER_B], "最近事件者居前，预览 cap 3");
    assert.equal(rows[0].agg_key, "follow:");
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_count, 4, "重复关注不重复计数");
  } finally {
    await db.close();
  }
});

test("follow 撤销：逐人收缩、归零删行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_C, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.follow_user($1)", [USER_A]);
    await asRole(db, "authenticated", USER_B, "select public.unfollow_user($1)", [USER_A]);
    let rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_count, 1);
    assert.deepEqual(rows[0].actor_ids, [USER_C]);
    await asRole(db, "authenticated", USER_C, "select public.unfollow_user($1)", [USER_A]);
    rows = await notificationsFor(db, USER_A);
    assert.equal(rows.length, 0, "count 归零后删除整行");
  } finally {
    await db.close();
  }
});

test("禁止自我通知：作者点赞/评论自己的作品不产生通知", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    const { rows: likeRows } = await asRole(db, "authenticated", USER_A,
      "select public.toggle_like_work($1) as payload", [WORK_1]);
    assert.equal(likeRows[0].payload.liked, true);
    await asRole(db, "authenticated", USER_A,
      "select public.create_comment($1, $2, null)", [WORK_1, "自评"]);
    assert.equal((await notificationsFor(db, USER_A)).length, 0, "自我通知被短路");
    const selfFollow = await expectError(asRole(db, "authenticated", USER_A,
      "select public.follow_user($1)", [USER_A]));
    assert.match(selfFollow.message, /不能关注自己/);
  } finally {
    await db.close();
  }
});

test("不同目标独立聚合（agg_key 唯一）：同一 actor 点赞/收藏不同作品各自成条", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await asRole(db, "authenticated", USER_B,
      "select public.toggle_like_work($1)", [WORK_1]);
    await asRole(db, "authenticated", USER_B, "select public.bookmark_work($1)", [WORK_1]);
    await asRole(db, "authenticated", USER_C,
      "select public.toggle_like_work($1)", [WORK_2]);
    const aRows = await notificationsFor(db, USER_A);
    assert.equal(aRows.length, 2, "work_like 与 work_bookmark 各自聚合");
    assert.deepEqual(aRows.map((r) => r.event_type).sort(), ["work_bookmark", "work_like"]);
    const bRows = await notificationsFor(db, USER_B);
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].event_type, "work_like");
    assert.equal(bRows[0].target_work_id, WORK_2);
  } finally {
    await db.close();
  }
});

test("关注往返：列表 owner 可见、计数公开、取关归零", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // A 关注 B
    const { rows: followRows } = await asRole(db, "authenticated", USER_A,
      "select public.follow_user($1) as payload", [USER_B]);
    assert.equal(followRows[0].payload.following_id, USER_B);
    // A 的关注列表（owner）
    const { rows: following } = await asRole(db, "authenticated", USER_A,
      "select public.list_my_following(null, 20) as payload");
    assert.equal(following[0].payload.following.length, 1);
    assert.equal(following[0].payload.following[0].pen_name, "白露");
    // B 的粉丝列表（owner 侧）
    const { rows: followers } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_followers(null, 20) as payload");
    assert.equal(followers[0].payload.followers.length, 1);
    assert.equal(followers[0].payload.followers[0].id, USER_A);
    // 公开计数：B 的 followers_count=1，A 视角 followed_by_current_user=true
    const { rows: counts } = await asRole(db, "authenticated", USER_A,
      "select public.get_profile_social_counts($1) as payload", [USER_B]);
    assert.equal(counts[0].payload.followers_count, 1);
    assert.equal(counts[0].payload.following_count, 0);
    assert.equal(counts[0].payload.followed_by_current_user, true);
    // anon 也能读公开计数（无登录态 → followed_by_current_user=false）
    const { rows: anonCounts } = await asRole(db, "anon", null,
      "select public.get_profile_social_counts($1) as payload", [USER_B]);
    assert.equal(anonCounts[0].payload.followers_count, 1);
    assert.equal(anonCounts[0].payload.followed_by_current_user, false);
    // 取关 → 计数归零、B 粉丝列表空
    await asRole(db, "authenticated", USER_A, "select public.unfollow_user($1)", [USER_B]);
    const { rows: after } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_followers(null, 20) as payload");
    assert.equal(after[0].payload.followers.length, 0);
  } finally {
    await db.close();
  }
});

test("收藏往返：计数公开 + 我的收藏态、列表私密、取消归零", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // B 收藏 WORK_1（作者 A）
    const { rows: bm } = await asRole(db, "authenticated", USER_B,
      "select public.bookmark_work($1) as payload", [WORK_1]);
    assert.equal(bm[0].payload.work_id, WORK_1);
    // 公开计数：bookmark_count=1，B 视角 bookmarked_by_current_user=true
    const { rows: counts } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(counts[0].payload.bookmark_count, 1);
    assert.equal(counts[0].payload.bookmarked_by_current_user, true);
    // anon 视角：计数可见、态为 false
    const { rows: anonCounts } = await asRole(db, "anon", null,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(anonCounts[0].payload.bookmark_count, 1);
    assert.equal(anonCounts[0].payload.bookmarked_by_current_user, false);
    // B 的收藏列表（owner）
    const { rows: list } = await asRole(db, "authenticated", USER_B,
      "select public.list_my_bookmarks(null, 20) as payload");
    assert.equal(list[0].payload.bookmarks.length, 1);
    assert.equal(list[0].payload.bookmarks[0].title, "末班车");
    assert.equal(list[0].payload.bookmarks[0].author_pen_name, "松声");
    // 幂等：重复收藏不重复计数
    await asRole(db, "authenticated", USER_B, "select public.bookmark_work($1)", [WORK_1]);
    const { rows: after } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(after[0].payload.bookmark_count, 1);
    // 取消收藏 → 计数归零
    await asRole(db, "authenticated", USER_B, "select public.unbookmark_work($1)", [WORK_1]);
    const { rows: zero } = await asRole(db, "authenticated", USER_B,
      "select public.get_work_social_counts($1) as payload", [WORK_1]);
    assert.equal(zero[0].payload.bookmark_count, 0);
  } finally {
    await db.close();
  }
});

test("评论点赞往返：计数公开 + 我的点赞态、取消归零、禁止赞自己", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    // A 点赞 B 的顶层评论 COMMENT_1
    const { rows: liked } = await asRole(db, "authenticated", USER_A,
      "select public.like_comment($1) as payload", [COMMENT_1]);
    assert.equal(liked[0].payload.comment_id, COMMENT_1);
    // 公开态：like_count=1，A 视角 liked_by_current_user=true
    const { rows: state } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(state[0].payload.comments[0].like_count, 1);
    assert.equal(state[0].payload.comments[0].liked_by_current_user, true);
    // anon 视角：计数可见、态为 false
    const { rows: anonState } = await asRole(db, "anon", null,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(anonState[0].payload.comments[0].like_count, 1);
    assert.equal(anonState[0].payload.comments[0].liked_by_current_user, false);
    // 幂等：重复点赞不重复计数
    await asRole(db, "authenticated", USER_A, "select public.like_comment($1)", [COMMENT_1]);
    const { rows: after } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(after[0].payload.comments[0].like_count, 1);
    // 取消点赞 → 归零，且 comment_id 仍在返回中（零赞评论不并入 NULL 组）
    await asRole(db, "authenticated", USER_A, "select public.unlike_comment($1)", [COMMENT_1]);
    const { rows: zero } = await asRole(db, "authenticated", USER_A,
      "select public.get_comment_like_state(array[$1::uuid]) as payload", [COMMENT_1]);
    assert.equal(zero[0].payload.comments[0].comment_id, COMMENT_1);
    assert.equal(zero[0].payload.comments[0].like_count, 0);
    assert.equal(zero[0].payload.comments[0].liked_by_current_user, false);
    // 禁止赞自己的评论：C 评论了 COMMENT_1 的回复（COMMENT_2 属 C），C 赞自己的 COMMENT_2 → 被拒
    const selfLikeError = await expectError(asRole(db, "authenticated", USER_C,
      "select public.like_comment($1)", [COMMENT_2]));
    assert.match(selfLikeError.message, /不能赞自己的评论/);
    assert.equal((await notificationsFor(db, USER_C)).length, 0, "赞自己评论不产生通知");
  } finally {
    await db.close();
  }
});

test("write_gate=enforce 时未验证邮箱的写交互被拒，绑定后放行", async () => {
  const db = await createDatabase();
  try {
    await seed(db);
    await db.exec(`
      update public.site_settings
      set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
      where key = 'account_security';
    `);
    // USER_B 未绑定找回邮箱 → 所有写交互被拒
    const followError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.follow_user($1)", [USER_A]));
    assert.match(followError.message, /找回邮箱/);
    const bookmarkError = await expectError(asRole(db, "authenticated", USER_B,
      "select public.bookmark_work($1)", [WORK_1]));
    assert.match(bookmarkError.message, /找回邮箱/);
    // USER_B 绑定后放行
    await db.exec(`
      insert into public.account_recovery_emails (user_id, email_normalized, verified_at)
      values ('${USER_B}', 'b-recovery@x.test', now())
    `);
    const { rows } = await asRole(db, "authenticated", USER_B,
      "select public.follow_user($1) as payload", [USER_A]);
    assert.equal(rows[0].payload.following_id, USER_A);
  } finally {
    await db.close();
  }
});
