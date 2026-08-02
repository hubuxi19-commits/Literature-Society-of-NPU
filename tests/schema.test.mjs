import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);

test("schema 为全部业务表启用 RLS 且不创建密码或学号字段", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  for (const table of [
    "profiles",
    "works",
    "likes",
    "comments",
    "site_settings",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `alter table public\\.${table} enable row level security`,
        "i",
      ),
    );
  }
  assert.doesNotMatch(sql, /\bpassword\b/i);
  assert.doesNotMatch(sql, /\bstudent_(?:number|id)\b/i);
});

test("schema 使用 Auth 触发器、所有者判断和管理员函数", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(sql, /handle_new_user/i);
  assert.match(sql, /on auth\.users/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /is_admin\(\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set_work_featured/i);
  assert.match(sql, /soft_delete_comment/i);
});

test("schema 对点赞唯一性、评论父子关系和字段长度设置约束", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(sql, /primary key\s*\(work_id,\s*user_id\)/i);
  assert.match(sql, /parent_id uuid references public\.comments/i);
  assert.match(sql, /validate_comment_parent/i);
  assert.match(sql, /char_length\(title\)\s+between\s+1\s+and\s+80/i);
  assert.match(sql, /char_length\(content\)\s+between\s+1\s+and\s+50000/i);
});

test("schema 允许新诗和旧诗并使用更新后的征稿文案", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(
    sql,
    /category\s+in\s*\(\s*'新诗',\s*'旧诗',\s*'散文',\s*'小说',\s*'随笔',\s*'其他'\s*\)/i,
  );
  assert.match(
    sql,
    /'body',\s*'新诗、旧诗、散文、小说、随笔与其他文字均可投稿。/,
  );
});

test("schema 禁止直接更新笔名并通过加锁 RPC 限制七天一次", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(
    sql,
    /category in\s*\(\s*'新诗',\s*'旧诗',\s*'散文',\s*'小说',\s*'随笔',\s*'其他'\s*\)/i,
  );
  assert.match(
    sql,
    /grant update\s*\(\s*bio,\s*updated_at\s*\)\s*on table public\.profiles/i,
  );
  assert.doesNotMatch(
    sql,
    /grant update\s*\([^)]*pen_name[^)]*\)\s*on table public\.profiles/i,
  );
  assert.match(sql, /pen_name_changed_at timestamptz/i);
  assert.match(sql, /create or replace function public\.update_own_profile/i);
  assert.match(sql, /where id = auth\.uid\(\)\s+for update/i);
  assert.match(sql, /pen_name_changed_at \+ interval '7 days'/i);
  assert.match(
    sql,
    /grant execute on function public\.update_own_profile\(text, text\) to authenticated/i,
  );
});

test("生产迁移先转换旧诗歌再添加目标约束", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /update public\.works\s+set category = '新诗'\s+where category = '诗歌'/i,
  );
  assert.match(
    migration,
    /revoke update\s*\(\s*pen_name,\s*bio,\s*updated_at\s*\)\s*on table public\.profiles from authenticated/i,
  );
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
});

test("笔名迁移增加冷却字段、行锁 RPC 并保持列级权限", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260802_allow_weekly_pen_name_changes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /begin;/i);
  assert.match(migration, /add column if not exists pen_name_changed_at timestamptz/i);
  assert.match(migration, /where id = auth\.uid\(\)\s+for update/i);
  assert.match(migration, /pen_name_changed_at \+ interval '7 days'/i);
  assert.match(
    migration,
    /grant update\s*\(\s*bio,\s*updated_at\s*\)\s*on table public\.profiles to authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.update_own_profile\(text, text\) to authenticated/i,
  );
  assert.match(migration, /commit;/i);
});

test("前端管理员推荐操作调用受保护 RPC", async () => {
  const source = await readFile(
    new URL("../js/data-service.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.rpc\("set_work_featured"/);
});

test("前端资料更新调用笔名冷却 RPC", async () => {
  const source = await readFile(
    new URL("../js/data-service.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.rpc\("update_own_profile"/);
  assert.match(source, /requested_pen_name:\s*penName/);
});
