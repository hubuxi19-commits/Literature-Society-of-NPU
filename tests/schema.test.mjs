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

test("前端管理员推荐操作调用受保护 RPC", async () => {
  const source = await readFile(
    new URL("../js/data-service.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.rpc\("set_work_featured"/);
});
