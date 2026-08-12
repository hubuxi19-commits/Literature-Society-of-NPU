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
