import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);
const migrationUrl = new URL(
  "../supabase/migrations/20260802_account_recovery_security.sql",
  import.meta.url,
);

const SECURITY_BLOCK_START = "-- ACCOUNT_RECOVERY_SECURITY_START";
const SECURITY_BLOCK_END = "-- ACCOUNT_RECOVERY_SECURITY_END";
const SOCIAL_BLOCK_START = "-- SOCIAL_NOTIFICATIONS_START";
const SOCIAL_BLOCK_END = "-- SOCIAL_NOTIFICATIONS_END";

const WRITER_ID = "20000000-0000-4000-8000-000000000001";
const WORK_ID = "20000000-0000-4000-8000-000000000002";
const COMMENT_ID = "20000000-0000-4000-8000-000000000003";

async function readMigrationOrEmpty() {
  try {
    return await readFile(migrationUrl, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function createSupabaseDatabase() {
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
    returns uuid
    language sql
    stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  return db;
}

function withoutAccountSecurityBlock(sql) {
  const start = sql.indexOf(SECURITY_BLOCK_START);
  if (start === -1) return sql;
  const end = sql.indexOf(SECURITY_BLOCK_END, start);
  if (end === -1) {
    throw new Error("fresh schema account-security block is not closed");
  }
  const after = sql.slice(
    end + SECURITY_BLOCK_END.length,
  );
  // 社交通知迁移经自身测试单独加载，增量模式跳过 SOCIAL 块以避免
  // 其 RPC 依赖的 work_versions/comment_quotes 与 is_account_write_allowed 出现缺口。
  const socialStart = after.indexOf(SOCIAL_BLOCK_START);
  if (socialStart !== -1) {
    const socialEnd = after.indexOf(SOCIAL_BLOCK_END, socialStart);
    if (socialEnd !== -1) {
      return (
        sql.slice(0, start) +
        after.slice(0, socialStart) +
        after.slice(socialEnd + SOCIAL_BLOCK_END.length)
      );
    }
  }
  return sql.slice(0, start) + after;
}

async function createIncrementalDatabase() {
  const db = await createSupabaseDatabase();
  const schema = withoutAccountSecurityBlock(
    await readFile(schemaUrl, "utf8"),
  );
  await db.exec(schema);
  const migration = await readMigrationOrEmpty();
  if (migration) await db.exec(migration);
  return db;
}

async function createFreshDatabase() {
  const db = await createSupabaseDatabase();
  await db.exec(await readFile(schemaUrl, "utf8"));
  return db;
}

async function queryAsRole(db, role, userId, sql, params = []) {
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false)",
    [userId ?? ""],
  );
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
    await db.query(
      "select set_config('request.jwt.claim.sub', '', false)",
    );
  }
}

async function scalarAsRole(db, role, userId, sql, params = []) {
  const result = await queryAsRole(db, role, userId, sql, params);
  return Object.values(result.rows[0])[0];
}

async function scalar(db, sql, params = []) {
  const result = await db.query(sql, params);
  return Object.values(result.rows[0])[0];
}

async function createUser(db, {
  id,
  email,
  penName,
  role = "member",
}) {
  await db.query(`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      $1,
      $2,
      jsonb_build_object('pen_name', $3::text)
    )
  `, [id, email, penName]);
  if (role !== "member") {
    await db.query(
      "update public.profiles set role = $2 where id = $1",
      [id, role],
    );
  }
}

async function setWriteGate(db, mode) {
  await db.query(`
    update public.site_settings
    set value = jsonb_build_object('write_gate', $1::text)
    where key = 'account_security'
  `, [mode]);
}

async function verifyRecoveryEmail(db, userId, email) {
  await db.query(`
    insert into public.account_recovery_emails (
      user_id, email_normalized, verified_at
    )
    values ($1, lower(btrim($2)), now())
    on conflict (user_id) do update
    set email_normalized = excluded.email_normalized,
        verified_at = excluded.verified_at,
        updated_at = now()
  `, [userId, email]);
}

test("增量迁移创建三个私有账号安全表", async () => {
  const db = await createIncrementalDatabase();
  try {
    const result = await db.query(`
      select tablename
      from pg_catalog.pg_tables
      where schemaname = 'public'
        and tablename in (
          'account_recovery_emails',
          'account_action_tokens',
          'auth_rate_limits'
        )
      order by tablename
    `);
    assert.deepEqual(
      result.rows.map(({ tablename }) => tablename),
      ["account_action_tokens", "account_recovery_emails", "auth_rate_limits"],
    );
  } finally {
    await db.close();
  }
});

test("增量迁移默认关闭账号写门禁", async () => {
  const db = await createIncrementalDatabase();
  try {
    const result = await db.query(`
      select value ->> 'write_gate' as write_gate
      from public.site_settings
      where key = 'account_security'
    `);
    assert.deepEqual(result.rows, [{ write_gate: "off" }]);
  } finally {
    await db.close();
  }
});

test("私有账号安全表启用 RLS、无策略且浏览器角色没有表权限", async () => {
  const db = await createIncrementalDatabase();
  try {
    const result = await db.query(`
      select
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        count(p.policyname)::integer as policy_count,
        has_table_privilege(
          'anon',
          format('%I.%I', n.nspname, c.relname),
          'select,insert,update,delete'
        ) as anon_access,
        has_table_privilege(
          'authenticated',
          format('%I.%I', n.nspname, c.relname),
          'select,insert,update,delete'
        ) as authenticated_access
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_policies p
        on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public'
        and c.relname in (
          'account_recovery_emails',
          'account_action_tokens',
          'auth_rate_limits'
        )
      group by c.relname, c.relrowsecurity, n.nspname
      order by c.relname
    `);
    assert.deepEqual(result.rows, [
      {
        table_name: "account_action_tokens",
        rls_enabled: true,
        policy_count: 0,
        anon_access: false,
        authenticated_access: false,
      },
      {
        table_name: "account_recovery_emails",
        rls_enabled: true,
        policy_count: 0,
        anon_access: false,
        authenticated_access: false,
      },
      {
        table_name: "auth_rate_limits",
        rls_enabled: true,
        policy_count: 0,
        anon_access: false,
        authenticated_access: false,
      },
    ]);
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(
        queryAsRole(
          db,
          role,
          null,
          "select * from public.account_recovery_emails",
        ),
        /permission denied/i,
      );
    }
  } finally {
    await db.close();
  }
});

test("账号写门禁在 off 和 warn 放行，在 enforce 只放行已验证用户", async () => {
  const db = await createIncrementalDatabase();
  const userId = "10000000-0000-4000-8000-000000000001";
  try {
    await db.query(`
      insert into auth.users (id, email, raw_user_meta_data)
      values (
        $1,
        'writer@example.com',
        '{"pen_name":"测试作者"}'::jsonb
      )
    `, [userId]);
    assert.equal(
      await scalarAsRole(
        db,
        "authenticated",
        userId,
        "select public.is_account_write_allowed()",
      ),
      true,
    );
    await db.exec(`
      update public.site_settings
      set value = '{"write_gate":"warn"}'::jsonb
      where key = 'account_security'
    `);
    assert.equal(
      await scalarAsRole(
        db,
        "authenticated",
        userId,
        "select public.is_account_write_allowed()",
      ),
      true,
    );
    await db.exec(`
      update public.site_settings
      set value = '{"write_gate":"enforce"}'::jsonb
      where key = 'account_security'
    `);
    assert.equal(
      await scalarAsRole(
        db,
        "authenticated",
        userId,
        "select public.is_account_write_allowed()",
      ),
      false,
    );
    await db.query(`
      insert into public.account_recovery_emails (
        user_id, email_normalized, verified_at
      ) values ($1, 'writer@example.com', now())
    `, [userId]);
    assert.equal(
      await scalarAsRole(
        db,
        "authenticated",
        userId,
        "select public.is_account_write_allowed()",
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

const coreWritePolicyCases = [
  {
    name: "profiles_update_own 阻止未验证资料更新",
    setup: [],
    write: {
      sql: `
        update public.profiles
        set bio = '受门禁保护的简介'
        where id = $1
        returning bio
      `,
      params: [WRITER_ID],
    },
    denial: "empty",
    observe: {
      sql: "select bio from public.profiles where id = $1",
      params: [WRITER_ID],
      before: "",
      after: "受门禁保护的简介",
    },
  },
  {
    name: "likes_insert_own 阻止未验证点赞",
    setup: [
      {
        sql: `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '点赞作品', '正文', '新诗')
        `,
        params: [WORK_ID, WRITER_ID],
      },
    ],
    write: {
      sql: `
        insert into public.likes (work_id, user_id)
        values ($1, $2)
        returning user_id
      `,
      params: [WORK_ID, WRITER_ID],
    },
    denial: "error",
    observe: {
      sql: `
        select count(*)::integer
        from public.likes
        where work_id = $1 and user_id = $2
      `,
      params: [WORK_ID, WRITER_ID],
      before: 0,
      after: 1,
    },
  },
  {
    name: "likes_delete_own 阻止未验证取消点赞",
    setup: [
      {
        sql: `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '点赞作品', '正文', '新诗')
        `,
        params: [WORK_ID, WRITER_ID],
      },
      {
        sql: `
          insert into public.likes (work_id, user_id)
          values ($1, $2)
        `,
        params: [WORK_ID, WRITER_ID],
      },
    ],
    write: {
      sql: `
        delete from public.likes
        where work_id = $1 and user_id = $2
        returning user_id
      `,
      params: [WORK_ID, WRITER_ID],
    },
    denial: "empty",
    observe: {
      sql: `
        select count(*)::integer
        from public.likes
        where work_id = $1 and user_id = $2
      `,
      params: [WORK_ID, WRITER_ID],
      before: 1,
      after: 0,
    },
  },
  {
    name: "comments_insert_own 阻止未验证评论",
    setup: [
      {
        sql: `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '评论作品', '正文', '新诗')
        `,
        params: [WORK_ID, WRITER_ID],
      },
    ],
    write: {
      sql: `
        insert into public.comments (
          id, work_id, user_id, content
        ) values ($1, $2, $3, '门禁评论')
        returning id
      `,
      params: [COMMENT_ID, WORK_ID, WRITER_ID],
    },
    denial: "error",
    observe: {
      sql: "select count(*)::integer from public.comments where id = $1",
      params: [COMMENT_ID],
      before: 0,
      after: 1,
    },
  },
  {
    name: "site_settings_admin_insert 阻止未验证管理员新增设置",
    role: "admin",
    setup: [],
    write: {
      sql: `
        insert into public.site_settings (key, value)
        values ('gated_insert', '{"enabled":true}'::jsonb)
        returning key
      `,
      params: [],
    },
    denial: "error",
    observe: {
      sql: `
        select count(*)::integer
        from public.site_settings
        where key = 'gated_insert'
      `,
      params: [],
      before: 0,
      after: 1,
    },
  },
  {
    name: "site_settings_admin_update 阻止未验证管理员更新设置",
    role: "admin",
    setup: [
      {
        sql: `
          insert into public.site_settings (key, value)
          values ('gated_update', '{"version":1}'::jsonb)
        `,
        params: [],
      },
    ],
    write: {
      sql: `
        update public.site_settings
        set value = '{"version":2}'::jsonb
        where key = 'gated_update'
        returning value ->> 'version' as version
      `,
      params: [],
    },
    denial: "empty",
    observe: {
      sql: `
        select value ->> 'version'
        from public.site_settings
        where key = 'gated_update'
      `,
      params: [],
      before: "1",
      after: "2",
    },
  },
  {
    name: "site_settings_admin_delete 阻止未验证管理员删除设置",
    role: "admin",
    setup: [
      {
        sql: `
          insert into public.site_settings (key, value)
          values ('gated_delete', '{}'::jsonb)
        `,
        params: [],
      },
    ],
    write: {
      sql: `
        delete from public.site_settings
        where key = 'gated_delete'
        returning key
      `,
      params: [],
    },
    denial: "empty",
    observe: {
      sql: `
        select count(*)::integer
        from public.site_settings
        where key = 'gated_delete'
      `,
      params: [],
      before: 1,
      after: 0,
    },
  },
];

for (const scenario of coreWritePolicyCases) {
  test(scenario.name, async () => {
    const db = await createIncrementalDatabase();
    try {
      await createUser(db, {
        id: WRITER_ID,
        email: "writer@example.com",
        penName: "写作者",
        role: scenario.role,
      });
      for (const statement of scenario.setup) {
        await db.query(statement.sql, statement.params);
      }
      await setWriteGate(db, "enforce");

      if (scenario.denial === "error") {
        await assert.rejects(
          queryAsRole(
            db,
            "authenticated",
            WRITER_ID,
            scenario.write.sql,
            scenario.write.params,
          ),
          /row-level security/i,
        );
      } else {
        const denied = await queryAsRole(
          db,
          "authenticated",
          WRITER_ID,
          scenario.write.sql,
          scenario.write.params,
        );
        assert.deepEqual(denied.rows, []);
      }
      assert.equal(
        await scalar(db, scenario.observe.sql, scenario.observe.params),
        scenario.observe.before,
      );

      await verifyRecoveryEmail(db, WRITER_ID, "writer@example.com");
      const allowed = await queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        scenario.write.sql,
        scenario.write.params,
      );
      assert.equal(allowed.rows.length, 1);
      assert.equal(
        await scalar(db, scenario.observe.sql, scenario.observe.params),
        scenario.observe.after,
      );
    } finally {
      await db.close();
    }
  });
}

test("works 直接 insert/update/delete 已收回：无论是否验证邮箱都被权限拒绝", async () => {
  const db = await createIncrementalDatabase();
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await db.query(`
      insert into public.works (id, author_id, title, content, category)
      values ($1, $2, '待改作品', '正文', '新诗')
    `, [WORK_ID, WRITER_ID]);
    await setWriteGate(db, "enforce");
    const directWrites = [
      [
        `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '门禁投稿', '正文', '新诗')
        `,
        [WORK_ID, WRITER_ID],
      ],
      [
        "update public.works set title = '新题' where id = $1",
        [WORK_ID],
      ],
      [
        "delete from public.works where id = $1",
        [WORK_ID],
      ],
    ];
    for (const [sql, params] of directWrites) {
      await assert.rejects(
        queryAsRole(db, "authenticated", WRITER_ID, sql, params),
        /permission denied/i,
      );
    }
    await verifyRecoveryEmail(db, WRITER_ID, "writer@example.com");
    for (const [sql, params] of directWrites) {
      await assert.rejects(
        queryAsRole(db, "authenticated", WRITER_ID, sql, params),
        /permission denied/i,
        "验证后直接写仍被权限拒绝",
      );
    }
  } finally {
    await db.close();
  }
});

test("作品写受保护 RPC 执行账号门禁：create_work_version / delete_work", async () => {
  const db = await createIncrementalDatabase();
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await setWriteGate(db, "enforce");
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        "select * from public.create_work_version(null, null, '标题', '', '新诗', '正文', '')",
      ),
      /请先验证找回邮箱后再进行此操作/,
    );
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        "select * from public.delete_work($1)",
        [WORK_ID],
      ),
      /请先验证找回邮箱后再进行此操作/,
    );
    await verifyRecoveryEmail(db, WRITER_ID, "writer@example.com");
    const created = await queryAsRole(
      db,
      "authenticated",
      WRITER_ID,
      "select public.create_work_version(null, null, '标题', '', '新诗', '正文', '') as payload",
    );
    assert.equal(created.rows[0].payload.version_number, 1);
    const newWorkId = created.rows[0].payload.work_id;
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        "delete from public.works where id = $1",
        [newWorkId],
      ),
      /permission denied/i,
      "验证后直接 delete 仍被权限拒绝，只能经 delete_work RPC",
    );
    await queryAsRole(
      db,
      "authenticated",
      WRITER_ID,
      "select * from public.delete_work($1)",
      [newWorkId],
    );
    assert.equal(
      await scalar(
        db,
        "select count(*)::integer from public.works where id = $1",
        [newWorkId],
      ),
      0,
    );
  } finally {
    await db.close();
  }
});

const securityDefinerRpcCases = [
  {
    name: "update_own_profile RPC 阻止未验证资料更新",
    setup: [],
    call: {
      sql: `
        select *
        from public.update_own_profile('新笔名', 'RPC 新简介')
      `,
      params: [],
    },
    observe: {
      sql: "select bio from public.profiles where id = $1",
      params: [WRITER_ID],
      before: "",
      after: "RPC 新简介",
    },
  },
  {
    name: "soft_delete_comment RPC 阻止未验证软删除",
    setup: [
      {
        sql: `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '评论作品', '正文', '新诗')
        `,
        params: [WORK_ID, WRITER_ID],
      },
      {
        sql: `
          insert into public.comments (
            id, work_id, user_id, content
          ) values ($1, $2, $3, '待删除评论')
        `,
        params: [COMMENT_ID, WORK_ID, WRITER_ID],
      },
    ],
    call: {
      sql: "select * from public.soft_delete_comment($1)",
      params: [COMMENT_ID],
    },
    observe: {
      sql: "select is_deleted from public.comments where id = $1",
      params: [COMMENT_ID],
      before: false,
      after: true,
    },
  },
  {
    name: "set_work_featured RPC 阻止未验证管理员推荐",
    role: "admin",
    setup: [
      {
        sql: `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, '待推荐作品', '正文', '新诗')
        `,
        params: [WORK_ID, WRITER_ID],
      },
    ],
    call: {
      sql: "select * from public.set_work_featured($1, true)",
      params: [WORK_ID],
    },
    observe: {
      sql: "select is_featured from public.works where id = $1",
      params: [WORK_ID],
      before: false,
      after: true,
    },
  },
];

for (const scenario of securityDefinerRpcCases) {
  test(scenario.name, async () => {
    const db = await createIncrementalDatabase();
    try {
      await createUser(db, {
        id: WRITER_ID,
        email: "writer@example.com",
        penName: "写作者",
        role: scenario.role,
      });
      for (const statement of scenario.setup) {
        await db.query(statement.sql, statement.params);
      }
      await setWriteGate(db, "enforce");

      await assert.rejects(
        queryAsRole(
          db,
          "authenticated",
          WRITER_ID,
          scenario.call.sql,
          scenario.call.params,
        ),
        /请先验证找回邮箱后再进行此操作/,
      );
      assert.equal(
        await scalar(db, scenario.observe.sql, scenario.observe.params),
        scenario.observe.before,
      );

      await verifyRecoveryEmail(db, WRITER_ID, "writer@example.com");
      const allowed = await queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        scenario.call.sql,
        scenario.call.params,
      );
      assert.equal(allowed.rows.length, 1);
      assert.equal(
        await scalar(db, scenario.observe.sql, scenario.observe.params),
        scenario.observe.after,
      );
    } finally {
      await db.close();
    }
  });
}

test("限速 RPC 原子计数并只放行窗口内前 N 次请求", async () => {
  const db = await createIncrementalDatabase();
  const call = `
    select public.consume_auth_rate_limit(
      'reset_password',
      decode('aabbcc', 'hex'),
      60,
      2
    )
  `;
  try {
    assert.equal(
      await scalarAsRole(db, "service_role", null, call),
      true,
    );
    assert.equal(
      await scalarAsRole(db, "service_role", null, call),
      true,
    );
    assert.equal(
      await scalarAsRole(db, "service_role", null, call),
      false,
    );
    assert.equal(
      await scalar(
        db,
        `
          select request_count
          from public.auth_rate_limits
          where action = 'reset_password'
            and key_digest = decode('aabbcc', 'hex')
        `,
      ),
      3,
    );
    await assert.rejects(
      scalarAsRole(db, "authenticated", WRITER_ID, call),
      /permission denied/i,
    );
  } finally {
    await db.close();
  }
});

test("限速 RPC 在新窗口重新计算额度", async () => {
  const db = await createIncrementalDatabase();
  try {
    await db.exec(`
      insert into public.auth_rate_limits (
        action,
        key_digest,
        window_started_at,
        request_count
      ) values (
        'send_code',
        decode('ddeeff', 'hex'),
        date_trunc('minute', now()) - interval '2 minutes',
        9
      )
    `);
    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        `
          select public.consume_auth_rate_limit(
            'send_code',
            decode('ddeeff', 'hex'),
            60,
            1
          )
        `,
      ),
      true,
    );
    const result = await db.query(`
      select request_count
      from public.auth_rate_limits
      where action = 'send_code'
        and key_digest = decode('ddeeff', 'hex')
      order by window_started_at
    `);
    assert.deepEqual(
      result.rows.map(({ request_count }) => request_count),
      [9, 1],
    );
  } finally {
    await db.close();
  }
});

test("令牌 RPC 锁定最新未使用令牌并为错误摘要原子计次", async () => {
  const db = await createIncrementalDatabase();
  const olderId = "30000000-0000-4000-8000-000000000001";
  const newerId = "30000000-0000-4000-8000-000000000002";
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await db.query(`
      insert into public.account_action_tokens (
        id,
        user_id,
        purpose,
        token_digest,
        expires_at,
        created_at
      ) values
        (
          $1,
          $3,
          'reset_password',
          decode('aaaa', 'hex'),
          now() + interval '10 minutes',
          now() - interval '1 minute'
        ),
        (
          $2,
          $3,
          'reset_password',
          decode('bbbb', 'hex'),
          now() + interval '10 minutes',
          now()
        )
    `, [olderId, newerId, WRITER_ID]);

    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        `
          select (
            public.consume_account_action_token(
              decode('cccc', 'hex'),
              'reset_password',
              $1,
              5
            )
          ).id
        `,
        [WRITER_ID],
      ),
      null,
    );
    const result = await db.query(`
      select id, attempt_count
      from public.account_action_tokens
      order by created_at, id
    `);
    assert.deepEqual(result.rows, [
      { id: olderId, attempt_count: 0 },
      { id: newerId, attempt_count: 1 },
    ]);
    await assert.rejects(
      scalarAsRole(
        db,
        "authenticated",
        WRITER_ID,
        `
          select (
            public.consume_account_action_token(
              decode('bbbb', 'hex'),
              'reset_password',
              $1,
              5
            )
          ).id
        `,
        [WRITER_ID],
      ),
      /permission denied/i,
    );
  } finally {
    await db.close();
  }
});

test("令牌 RPC 允许调用方阈值内第 5 次匹配并且只能消费一次", async () => {
  const db = await createIncrementalDatabase();
  const tokenId = "30000000-0000-4000-8000-000000000003";
  const call = `
    select (
      public.consume_account_action_token(
        decode('dddd', 'hex'),
        'reset_password',
        $1,
        5
      )
    ).id
  `;
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await db.query(`
      insert into public.account_action_tokens (
        id,
        user_id,
        purpose,
        token_digest,
        expires_at,
        attempt_count,
        max_attempts
      ) values (
        $1,
        $2,
        'reset_password',
        decode('dddd', 'hex'),
        now() + interval '10 minutes',
        4,
        10
      )
    `, [tokenId, WRITER_ID]);

    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        call,
        [WRITER_ID],
      ),
      tokenId,
    );
    const consumed = await db.query(`
      select attempt_count, used_at is not null as used
      from public.account_action_tokens
      where id = $1
    `, [tokenId]);
    assert.deepEqual(consumed.rows, [{ attempt_count: 5, used: true }]);

    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        call,
        [WRITER_ID],
      ),
      null,
    );
    assert.equal(
      await scalar(
        db,
        `
          select attempt_count
          from public.account_action_tokens
          where id = $1
        `,
        [tokenId],
      ),
      5,
    );
  } finally {
    await db.close();
  }
});

test("令牌 RPC 在行阈值第 5 次错误后拒绝第 6 次", async () => {
  const db = await createIncrementalDatabase();
  const tokenId = "30000000-0000-4000-8000-000000000004";
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await db.query(`
      insert into public.account_action_tokens (
        id,
        user_id,
        purpose,
        token_digest,
        expires_at,
        attempt_count,
        max_attempts
      ) values (
        $1,
        $2,
        'reset_password',
        decode('eeee', 'hex'),
        now() + interval '10 minutes',
        4,
        5
      )
    `, [tokenId, WRITER_ID]);

    for (const presentedHex of ["ffff", "eeee"]) {
      assert.equal(
        await scalarAsRole(
          db,
          "service_role",
          null,
          `
            select (
              public.consume_account_action_token(
                decode('${presentedHex}', 'hex'),
                'reset_password',
                $1,
                10
              )
            ).id
          `,
          [WRITER_ID],
        ),
        null,
      );
    }
    assert.equal(
      await scalar(
        db,
        `
          select attempt_count
          from public.account_action_tokens
          where id = $1
        `,
        [tokenId],
      ),
      5,
    );
  } finally {
    await db.close();
  }
});

test("令牌 RPC 对过期候选返回空且不增加尝试次数", async () => {
  const db = await createIncrementalDatabase();
  const tokenId = "30000000-0000-4000-8000-000000000005";
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await db.query(`
      insert into public.account_action_tokens (
        id, user_id, purpose, token_digest, expires_at
      ) values (
        $1,
        $2,
        'reset_password',
        decode('abab', 'hex'),
        now() - interval '1 second'
      )
    `, [tokenId, WRITER_ID]);
    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        `
          select (
            public.consume_account_action_token(
              decode('abab', 'hex'),
              'reset_password',
              $1,
              5
            )
          ).id
        `,
        [WRITER_ID],
      ),
      null,
    );
    const expired = await db.query(`
      select attempt_count, used_at
      from public.account_action_tokens
      where id = $1
    `, [tokenId]);
    assert.deepEqual(expired.rows, [{ attempt_count: 0, used_at: null }]);
  } finally {
    await db.close();
  }
});

test("fresh schema 创建完整私有对象、RLS 与默认门禁", async () => {
  const db = await createFreshDatabase();
  try {
    const tables = await db.query(`
      select c.relname as table_name, c.relrowsecurity as rls_enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'account_recovery_emails',
          'account_action_tokens',
          'auth_rate_limits'
        )
      order by c.relname
    `);
    assert.deepEqual(tables.rows, [
      { table_name: "account_action_tokens", rls_enabled: true },
      { table_name: "account_recovery_emails", rls_enabled: true },
      { table_name: "auth_rate_limits", rls_enabled: true },
    ]);
    const functions = await db.query(`
      select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'is_recovery_email_verified',
          'is_account_write_allowed',
          'consume_auth_rate_limit',
          'consume_account_action_token'
        )
      order by p.proname
    `);
    assert.deepEqual(
      functions.rows.map(({ proname }) => proname),
      [
        "consume_account_action_token",
        "consume_auth_rate_limit",
        "is_account_write_allowed",
        "is_recovery_email_verified",
      ],
    );
    assert.equal(
      await scalar(
        db,
        `
          select value ->> 'write_gate'
          from public.site_settings
          where key = 'account_security'
        `,
      ),
      "off",
    );
  } finally {
    await db.close();
  }
});

test("fresh schema 的直接 works 写已收回，受保护 RPC 执行同一账号门禁", async () => {
  const db = await createFreshDatabase();
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    await setWriteGate(db, "enforce");
    // 直接 insert 已在权限层收回：无论是否验证邮箱都是 permission denied
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, 'Fresh 投稿', '正文', '新诗')
        `,
        [WORK_ID, WRITER_ID],
      ),
      /permission denied/i,
    );
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        "select * from public.update_own_profile('新笔名', '新简介')",
      ),
      /请先验证找回邮箱后再进行此操作/,
    );
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        "select * from public.create_work_version(null, null, 'Fresh 投稿', '', '新诗', '正文', '')",
      ),
      /请先验证找回邮箱后再进行此操作/,
    );

    await verifyRecoveryEmail(db, WRITER_ID, "writer@example.com");
    await assert.rejects(
      queryAsRole(
        db,
        "authenticated",
        WRITER_ID,
        `
          insert into public.works (
            id, author_id, title, content, category
          ) values ($1, $2, 'Fresh 投稿', '正文', '新诗')
        `,
        [WORK_ID, WRITER_ID],
      ),
      /permission denied/i,
      "验证后直接 insert 仍被权限拒绝",
    );
    const profile = await queryAsRole(
      db,
      "authenticated",
      WRITER_ID,
      "select * from public.update_own_profile('新笔名', '新简介')",
    );
    assert.equal(profile.rows[0].bio, "新简介");
    const created = await queryAsRole(
      db,
      "authenticated",
      WRITER_ID,
      "select public.create_work_version(null, null, 'Fresh 投稿', '', '新诗', '正文', '') as payload",
    );
    assert.equal(created.rows[0].payload.version_number, 1);
  } finally {
    await db.close();
  }
});

test("fresh schema 的两个原子 RPC 只经 service_role 执行真实写入", async () => {
  const db = await createFreshDatabase();
  const tokenId = "30000000-0000-4000-8000-000000000006";
  try {
    await createUser(db, {
      id: WRITER_ID,
      email: "writer@example.com",
      penName: "写作者",
    });
    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        `
          select public.consume_auth_rate_limit(
            'fresh_check',
            decode('1234', 'hex'),
            60,
            1
          )
        `,
      ),
      true,
    );
    await db.query(`
      insert into public.account_action_tokens (
        id, user_id, purpose, token_digest, expires_at
      ) values (
        $1,
        $2,
        'reset_password',
        decode('5678', 'hex'),
        now() + interval '10 minutes'
      )
    `, [tokenId, WRITER_ID]);
    assert.equal(
      await scalarAsRole(
        db,
        "service_role",
        null,
        `
          select (
            public.consume_account_action_token(
              decode('5678', 'hex'),
              'reset_password',
              $1,
              5
            )
          ).id
        `,
        [WRITER_ID],
      ),
      tokenId,
    );
    assert.equal(
      await scalar(
        db,
        `
          select request_count
          from public.auth_rate_limits
          where action = 'fresh_check'
        `,
      ),
      1,
    );
    assert.equal(
      await scalar(
        db,
        `
          select attempt_count
          from public.account_action_tokens
          where id = $1
        `,
        [tokenId],
      ),
      1,
    );
  } finally {
    await db.close();
  }
});
