# 账号验证、密码找回、限速与生产安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留所有现有用户 UUID、作品归属和“学号＋密码”日常登录方式的前提下，增加私密找回邮箱验证、密码找回、请求限速、未验证账号写入拦截和测试/生产环境防误连。

**Architecture:** 保留 Supabase Auth 内部邮箱 `学号@accounts.wenyuan.invalid` 作为登录标识，找回邮箱单独保存于受 RLS 保护的业务表。两个 Edge Functions 分别承载已登录账号安全操作和公开密码找回操作，共享令牌、Turnstile、Brevo、限速与响应模块；数据库用可回退的 `off/warn/enforce` 开关逐步启用写入门禁。

**Tech Stack:** 静态 HTML/CSS/ES modules、Supabase Auth/Postgres/RLS/Edge Functions、`@supabase/server`、`@supabase/supabase-js@2`、Brevo Transactional Email API、Cloudflare Turnstile、Node test runner、Playwright。

## Global Constraints

- 现有 GitHub Pages + Supabase 架构继续使用，不引入自建 VPS。
- 现有生产 Supabase 项目、用户 UUID、作品 ID、评论和作者归属不得改变。
- 日常登录始终只要求学号和密码；找回邮箱不能替换 Auth 主邮箱。
- 老账号登录后只需绑定并验证一次找回邮箱；未验证账号可以登录和阅读，但不能进行任何写操作。
- 找回邮箱、学号、验证码、令牌和密码不得出现在公开查询、日志、页面源码、Git 提交或站内通知内容中。
- 邮箱只发送验证、更换邮箱和密码找回信息，不发送评论、关注、收藏或站内消息。
- Brevo 免费额度按每天 300 封设计；老账号分批验证每天最多 200 人。
- 同一账号或邮箱 60 秒内不能重发，同用途每天最多三次，同时按来源网络摘要限速。
- 密码不少于八位并同时包含字母和数字。
- 前端只允许使用 Project URL 与 publishable key；`sb_secret_`、`service_role`、数据库密码、Brevo API key、Turnstile secret 和摘要 pepper 只进入 Edge Function secrets。
- 测试项目只使用虚构账号和示例作品；未经用户再次确认不得执行生产迁移、部署生产函数、推送 `main` 或发布 GitHub Pages。
- 所有数据库迁移和函数部署前必须显示并核对目标 project ref；测试与生产 ref 相同则立即停止。
- 旧邮箱不可用时只显示“联系管理员人工核验”；本阶段不提供无审计的直接换绑，管理员核验和审计入口由第五阶段治理计划交付。

## File Structure

- `js/config.mjs`：生产配置和仅本地加载规则；绝不包含测试项目值。
- `js/config.local.example.mjs`：本地测试配置模板。
- `js/config.local.mjs`：被 Git 忽略的实际测试配置。
- `supabase/migrations/20260802_account_recovery_security.sql`：生产增量迁移、RLS 门禁和功能开关。
- `supabase/schema.sql`：新项目完整结构，与增量迁移保持一致。
- `supabase/functions/_shared/security-core.mjs`：Node 与 Edge 都可测试的纯验证、掩码、摘要输入和邮件正文逻辑。
- `supabase/functions/_shared/clients.ts`：创建用户上下文和后台 Supabase 客户端。
- `supabase/functions/_shared/http.ts`：CORS、JSON 输入、请求 ID 和统一错误响应。
- `supabase/functions/_shared/turnstile.ts`：Cloudflare Siteverify 服务端验证。
- `supabase/functions/_shared/brevo.ts`：Brevo 事务邮件发送。
- `supabase/functions/_shared/account-store.ts`：令牌、限速、账号查找和原子 RPC 适配。
- `supabase/functions/account-email/index.ts`：已登录用户绑定、验证、换绑和状态查询。
- `supabase/functions/password-recovery/index.ts`：公开的找回请求和密码重置。
- `supabase/config.toml`：两个函数的认证模式。
- `js/data-service.mjs`：浏览器端账号安全服务接口和演示实现。
- `js/demo-data.mjs`：演示账号的验证状态与虚构邮箱。
- `index.html`、`js/app.js`、`assets/styles.css`：账号安全页、绑定流程、找回密码表单和写入提醒。
- `tests/account-security-core.test.mjs`：纯逻辑、邮件隐私、限速键与错误文案测试。
- `tests/edge-functions.test.mjs`：Edge Function 源码与接口契约测试。
- `tests/account-security-ui.test.mjs`：HTML、配置隔离和 UI 静态契约测试。
- `tests/data-service.test.mjs`、`tests/schema.test.mjs`、`tests/browser-check.cjs`：现有测试扩展。
- `README.md`、`SECURITY.md`：部署、密钥、隐私、回退和冒烟测试说明。

---

### Task 1: 隔离测试配置，防止本地误连生产

**Files:**
- Modify: `.gitignore`
- Modify: `js/config.mjs`
- Modify: `js/config.example.mjs`
- Create: `js/config.local.example.mjs`
- Create locally, never stage: `js/config.local.mjs`
- Test: `tests/account-security-ui.test.mjs`

**Interfaces:**
- Consumes: 浏览器的 `location.hostname`。
- Produces: `config.supabaseUrl: string`、`config.supabasePublishableKey: string`、`config.turnstileSiteKey: string`、`config.environment: "production" | "staging" | "demo"`。

- [ ] **Step 1: Write the failing config-isolation tests**

```js
test("本地 Supabase 配置被忽略且生产配置不声明 staging 环境", async () => {
  const [ignore, config] = await Promise.all([
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../js/config.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(ignore, /^js\/config\.local\.mjs$/m);
  assert.doesNotMatch(config, /environment:\s*"staging"/);
  assert.match(config, /import\("\.\/config\.local\.mjs"\)/);
  assert.match(config, /supabasePublishableKey/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/account-security-ui.test.mjs`
Expected: FAIL because `config.local.mjs` is not ignored and `config.mjs` has no guarded local import.

- [ ] **Step 3: Implement the guarded local configuration**

```js
const productionConfig = Object.freeze({
  mode: "supabase",
  environment: "production",
  supabaseUrl: "https://odfjxtzgekhiaktzaxas.supabase.co",
  supabasePublishableKey: "sb_publishable_JGnMQuwRNV6pTIzUORyqSg_PB-zGT0-",
  turnstileSiteKey: "",
});

let config = productionConfig;
if (["127.0.0.1", "localhost"].includes(globalThis.location?.hostname)) {
  try {
    const localModule = await import("./config.local.mjs");
    config = Object.freeze({ ...localModule.config, environment: "staging" });
  } catch {
    // Missing local config intentionally falls back to production.
  }
}
export { config };
```

Use `supabasePublishableKey` in new code and retain a temporary read fallback to `supabaseAnonKey` inside `createDataService` until all tracked configs are migrated.

Create `js/config.local.example.mjs` with empty public fields and the official always-pass Turnstile test sitekey:

```js
export const config = {
  mode: "supabase",
  environment: "staging",
  supabaseUrl: "",
  supabasePublishableKey: "",
  turnstileSiteKey: "1x00000000000000000000AA",
};
```

Create the ignored `js/config.local.mjs` with the test Project URL and publishable key already supplied by the user. Do not print its contents in tool output.

- [ ] **Step 4: Run the focused and full tests**

Run: `node --test tests/account-security-ui.test.mjs tests/static-checks.mjs`
Expected: PASS.

Run: `npm test`
Expected: 72 existing unit/static tests plus the new test pass; desktop and mobile browser checks pass.

- [ ] **Step 5: Verify no test credential is tracked and commit**

Run: `git grep -n "$env:STAGING_PROJECT_REF" HEAD` after setting that environment variable privately.
Expected: no output.

```bash
git add .gitignore js/config.mjs js/config.example.mjs js/config.local.example.mjs tests/account-security-ui.test.mjs
git commit -m "chore: isolate staging Supabase config"
```

### Task 2: Add private recovery tables, atomic token RPCs, and the rollout-safe write gate

**Files:**
- Create: `supabase/migrations/20260802_account_recovery_security.sql`
- Modify: `supabase/schema.sql`
- Modify: `tests/schema.test.mjs`
- Create: `supabase/tests/account_recovery_security.sql`

**Interfaces:**
- Produces tables: `account_recovery_emails`, `account_action_tokens`, `auth_rate_limits`.
- Produces functions: `is_recovery_email_verified() -> boolean`, `is_account_write_allowed() -> boolean`, `consume_auth_rate_limit(text, bytea, int, int) -> boolean`, `consume_account_action_token(bytea, text, uuid, int) -> account_action_tokens`.
- Consumed by: both Edge Functions and every existing write policy/RPC.

- [ ] **Step 1: Write failing schema contract tests**

```js
test("账号安全迁移创建私有表并默认关闭强制门禁", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20260802_account_recovery_security.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["account_recovery_emails", "account_action_tokens", "auth_rate_limits"]) {
    assert.match(sql, new RegExp("alter table public\\\\." + table + " enable row level security", "i"));
  }
  assert.match(sql, /'account_security'.*'write_gate'.*'off'/is);
  assert.match(sql, /create or replace function public\.is_account_write_allowed/i);
  assert.match(sql, /revoke all on table public\.account_recovery_emails from anon, authenticated/i);
  assert.doesNotMatch(sql, /grant select on table public\.account_recovery_emails to authenticated/i);
});

test("所有现有写策略和安全定义 RPC 都调用账号写门禁", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20260802_account_recovery_security.sql", import.meta.url),
    "utf8",
  );
  for (const name of [
    "works_insert_own", "works_update_own_or_admin", "works_delete_own_or_admin",
    "likes_insert_own", "likes_delete_own", "comments_insert_own",
    "site_settings_admin_insert", "site_settings_admin_update", "site_settings_admin_delete",
  ]) assert.match(sql, new RegExp(name + "[\\\\s\\\\S]+is_account_write_allowed", "i"));
  for (const rpc of ["update_own_profile", "soft_delete_comment", "set_work_featured"]) {
    assert.match(sql, new RegExp("function public\\\\." + rpc + "[\\\\s\\\\S]+is_account_write_allowed", "i"));
  }
});
```

- [ ] **Step 2: Run schema tests and verify RED**

Run: `node --test tests/schema.test.mjs`
Expected: FAIL because the migration and account security functions do not exist.

- [ ] **Step 3: Implement the additive migration**

The migration must run inside `begin; ... commit;` and use these minimum table shapes:

```sql
create table if not exists public.account_recovery_emails (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email_normalized text not null unique
    check (email_normalized = lower(btrim(email_normalized)))
    check (char_length(email_normalized) between 3 and 320),
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_action_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  purpose text not null check (purpose in (
    'bind_email', 'change_email_old', 'change_email_new', 'reset_password'
  )),
  token_digest bytea not null unique,
  email_normalized text,
  next_email_normalized text,
  expires_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.auth_rate_limits (
  action text not null,
  key_digest bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count >= 1),
  primary key (action, key_digest, window_started_at)
);
```

Implement the gate so production remains writable until the final rollout step:

```sql
create or replace function public.is_recovery_email_verified()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.account_recovery_emails
    where user_id = auth.uid() and verified_at is not null
  );
$$;

create or replace function public.is_account_write_allowed()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select value ->> 'write_gate' from public.site_settings where key = 'account_security'),
    'off'
  ) <> 'enforce' or public.is_recovery_email_verified();
$$;
```

Recreate each existing write policy with `public.is_account_write_allowed()` in both `using` and `with check` as applicable. Add the same early guard to `update_own_profile`, `soft_delete_comment`, and `set_work_featured`:

```sql
if not public.is_account_write_allowed() then
  raise exception '请先验证找回邮箱后再进行此操作';
end if;
```

Revoke all table access from `anon, authenticated` for the three private tables. Grant only the two atomic RPCs to `service_role`; new `sb_secret_` clients inherit the privileged backend role.

- [ ] **Step 4: Add SQL behavioral assertions**

`supabase/tests/account_recovery_security.sql` must assert:

```sql
select plan(8);
select has_table('public', 'account_recovery_emails');
select has_table('public', 'account_action_tokens');
select has_table('public', 'auth_rate_limits');
select has_function('public', 'is_recovery_email_verified', array[]::text[]);
select has_function('public', 'is_account_write_allowed', array[]::text[]);
select policies_are(
  'public', 'account_recovery_emails', array[]::text[],
  'recovery emails have no browser-readable policies'
);
select is(
  (select value ->> 'write_gate' from public.site_settings where key = 'account_security'),
  'off',
  'production-safe default'
);
select finish();
```

- [ ] **Step 5: Run static tests and sync `schema.sql`**

Run: `node --test tests/schema.test.mjs`
Expected: PASS.

Copy the final definitions and policy replacements into `supabase/schema.sql` so a fresh test project and production incremental migration create the same security model.

Run: `node --test tests/schema.test.mjs tests/static-checks.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260802_account_recovery_security.sql supabase/schema.sql supabase/tests/account_recovery_security.sql tests/schema.test.mjs
git commit -m "feat: add recovery email security schema"
```

### Task 3: Build and test the shared security, Turnstile, and Brevo modules

**Files:**
- Create: `supabase/functions/_shared/security-core.mjs`
- Create: `supabase/functions/_shared/turnstile.ts`
- Create: `supabase/functions/_shared/brevo.ts`
- Create: `tests/account-security-core.test.mjs`

**Interfaces:**
- Produces: `normalizeRecoveryEmail(value): string`, `maskRecoveryEmail(value): string`, `createNumericCode(randomBytes): string`, `digestSecret(value, pepper): Promise<string>`, `buildSecurityEmail(purpose, code, expiresMinutes): {subject,textContent}`.
- Produces: `verifyTurnstile(token, requestId): Promise<void>`.
- Produces: `sendSecurityEmail({to,purpose,code,expiresMinutes,requestId}): Promise<{messageId:string}>`.

- [ ] **Step 1: Write failing pure-module tests**

```js
test("邮箱规范化和掩码不泄露完整地址", () => {
  assert.equal(normalizeRecoveryEmail("  Reader@Example.COM "), "reader@example.com");
  assert.equal(maskRecoveryEmail("reader@example.com"), "r***r@e***e.com");
  assert.throws(() => normalizeRecoveryEmail("not-an-email"), /邮箱格式/);
});

test("安全邮件只包含验证码和用途，不包含社区资料", () => {
  const email = buildSecurityEmail("reset_password", "123456", 10);
  assert.match(email.subject, /密码/);
  assert.match(email.textContent, /123456/);
  assert.doesNotMatch(email.textContent, /学号|笔名|作品|评论|关注|收藏/);
});

test("相同输入与 pepper 产生相同摘要，不同 pepper 产生不同摘要", async () => {
  const left = await digestSecret("2023123456", "pepper-a");
  assert.equal(left, await digestSecret("2023123456", "pepper-a"));
  assert.notEqual(left, await digestSecret("2023123456", "pepper-b"));
});
```

- [ ] **Step 2: Run the core test and verify RED**

Run: `node --test tests/account-security-core.test.mjs`
Expected: FAIL because `security-core.mjs` does not exist.

- [ ] **Step 3: Implement pure functions with Web Crypto**

Use HMAC-SHA-256, not plain SHA-256, because student numbers and six-digit codes have low entropy:

```js
export async function digestSecret(value, pepper) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

Generate codes from `crypto.getRandomValues(new Uint32Array(1))` and format exactly six digits. Keep token validity at 10 minutes and maximum verification attempts at five.

- [ ] **Step 4: Implement mandatory Turnstile server verification**

```ts
export async function verifyTurnstile(token: string, idempotencyKey: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new Error("验证码服务尚未配置");
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, response: token, idempotency_key: idempotencyKey }),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error("人机验证失败，请刷新后重试");
}
```

Local tests use the official always-pass secret `1x0000000000000000000000000000000AA` from an ignored env file. Production uses a separate Turnstile widget that excludes localhost.

- [ ] **Step 5: Implement Brevo plain-text transactional mail**

```ts
const response = await fetch("https://api.brevo.com/v3/smtp/email", {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "api-key": requiredEnv("BREVO_API_KEY"),
    "Idempotency-Key": requestId,
  },
  body: JSON.stringify({
    sender: {
      name: requiredEnv("BREVO_SENDER_NAME"),
      email: requiredEnv("BREVO_SENDER_EMAIL"),
    },
    to: [{ email: to }],
    subject,
    textContent,
    tags: ["account-security"],
  }),
});
```

Return only Brevo's `messageId`. Never log the request body, recipient, code, API response body, or API key.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/account-security-core.test.mjs`
Expected: PASS.

```bash
git add supabase/functions/_shared/security-core.mjs supabase/functions/_shared/turnstile.ts supabase/functions/_shared/brevo.ts tests/account-security-core.test.mjs
git commit -m "feat: add account security email primitives"
```

### Task 4: Implement authenticated recovery-email binding and two-step email change

**Files:**
- Create: `supabase/functions/_shared/clients.ts`
- Create: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/account-store.ts`
- Create: `supabase/functions/account-email/index.ts`
- Create: `supabase/config.toml`
- Create: `tests/edge-functions.test.mjs`

**Interfaces:**
- Request: `{action:"status"}`.
- Request: `{action:"request-bind", email:string, captchaToken:string}`.
- Request: `{action:"verify-bind", code:string}`.
- Request: `{action:"request-change", newEmail:string, captchaToken:string}` after client reauthentication.
- Request: `{action:"confirm-change-old", code:string}`.
- Request: `{action:"confirm-change-new", code:string}`.
- Response: `{state:"unbound"|"pending"|"verified"|"changing", maskedEmail:string|null, nextSendAt:string|null}`.

- [ ] **Step 1: Write failing Edge contract tests**

```js
test("account-email requires user auth and exposes every approved action", async () => {
  const [config, source] = await Promise.all([
    readFile(new URL("../supabase/config.toml", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/account-email/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(config, /\[functions\.account-email\][\s\S]*verify_jwt = true/);
  for (const action of [
    "status", "request-bind", "verify-bind",
    "request-change", "confirm-change-old", "confirm-change-new",
  ]) assert.match(source, new RegExp('"' + action + '"'));
  assert.match(source, /auth:\s*["']user["']/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*(?:email|code|token|password)/i);
});
```

- [ ] **Step 2: Run the Edge contract test and verify RED**

Run: `node --test tests/edge-functions.test.mjs`
Expected: FAIL because the function and config do not exist.

- [ ] **Step 3: Implement current Supabase user and admin clients**

Use `withSupabase({ auth: "user" })` for the handler. `clients.ts` must parse `SUPABASE_SECRET_KEYS` and create an admin client with:

```ts
createClient(Deno.env.get("SUPABASE_URL")!, secretKeys.default, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
```

Never place a publishable or secret key in the `Authorization` header; browser invocation sends the user JWT as Bearer and the publishable key in `apikey`.

- [ ] **Step 4: Implement status and bind actions**

`request-bind` order is exact:

1. Validate authenticated `ctx.userClaims.sub`.
2. Validate and normalize email.
3. Validate Turnstile.
4. Consume user, email, and IP digest rate limits.
5. Reject if another user already owns the normalized email.
6. Invalidate older unused `bind_email` tokens for this user.
7. Insert one HMAC-digested code with 10-minute expiry.
8. Send Brevo mail.
9. On delivery failure, mark the token used and return a retryable 502 without exposing the email.

`verify-bind` calls the atomic token-consumption RPC, upserts `account_recovery_emails` for the same user UUID, and returns a masked address.

- [ ] **Step 5: Implement old-email plus new-email change**

`request-change` requires the JWT `iat` to be within five minutes; otherwise return code `recent_login_required`. It creates and sends `change_email_old` to the existing verified email while privately storing `next_email_normalized`.

`confirm-change-old` consumes the old code and sends a new `change_email_new` code to `next_email_normalized`.

`confirm-change-new` atomically consumes the new code, checks the unique email constraint, and updates the existing `account_recovery_emails` row. It never changes `auth.users.email`.

- [ ] **Step 6: Configure function authentication and run tests**

```toml
[functions.account-email]
verify_jwt = true

[functions.password-recovery]
verify_jwt = false
```

Run: `node --test tests/account-security-core.test.mjs tests/edge-functions.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml supabase/functions/_shared/clients.ts supabase/functions/_shared/http.ts supabase/functions/_shared/account-store.ts supabase/functions/account-email/index.ts tests/edge-functions.test.mjs
git commit -m "feat: add recovery email edge function"
```

### Task 5: Implement enumeration-safe password recovery

**Files:**
- Create: `supabase/functions/password-recovery/index.ts`
- Modify: `tests/edge-functions.test.mjs`
- Modify: `tests/account-security-core.test.mjs`

**Interfaces:**
- Request: `{action:"request", studentNumber:string, captchaToken:string}`.
- Request: `{action:"complete", studentNumber:string, code:string, newPassword:string, captchaToken:string}`.
- Request response: always `{ok:true, message:"如果账号存在且已绑定邮箱，我们已发送验证码。"}` for valid request shapes.
- Complete response: `{ok:true, message:"密码已更新，请使用新密码登录。"}`.

- [ ] **Step 1: Add failing enumeration and password tests**

```js
test("密码找回请求使用固定外部文案且不返回账号或邮箱", async () => {
  const source = await readFile(
    new URL("../supabase/functions/password-recovery/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /如果账号存在且已绑定邮箱，我们已发送验证码。/);
  assert.match(source, /listUsers/);
  assert.match(source, /updateUserById/);
  assert.doesNotMatch(source, /return.*(?:studentNumber|email_normalized|user_id)/i);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/edge-functions.test.mjs tests/account-security-core.test.mjs`
Expected: FAIL because `password-recovery/index.ts` does not exist.

- [ ] **Step 3: Implement public request flow**

Use `withSupabase({ auth: "publishable" })` with `verify_jwt = false`. Validate Turnstile before account lookup. Compute `studentNumber + "@accounts.wenyuan.invalid"` only in memory.

`findUserByInternalEmail` must call `supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })` page by page, stop at the matching internal email, and stop when a page contains fewer than 200 users. At the expected 500-user scale this is bounded and avoids creating a new student-number lookup table.

For missing accounts, missing recovery emails, and Brevo delivery failures, return the same fixed request message after applying rate limits. Record only request ID, outcome category, and hashed limit keys.

- [ ] **Step 4: Implement complete flow**

Validate:

- student number format,
- password length/letter/digit rule,
- Turnstile token,
- six-digit code shape,
- request limits and maximum five code attempts.

Atomically consume the HMAC digest for purpose `reset_password`, then run:

```ts
const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
  password: newPassword,
});
if (error) throw new PublicError(502, "密码暂时无法更新，请重新申请验证码");
```

Supabase Auth terminates sessions after a password-changing security action; existing access tokens can remain valid until their configured JWT expiry, so production keeps JWT expiry at no more than 3600 seconds.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/account-security-core.test.mjs tests/edge-functions.test.mjs`
Expected: PASS.

```bash
git add supabase/functions/password-recovery/index.ts tests/edge-functions.test.mjs tests/account-security-core.test.mjs
git commit -m "feat: add protected password recovery"
```

### Task 6: Extend the browser data service and demo model

**Files:**
- Modify: `js/data-service.mjs`
- Modify: `js/demo-data.mjs`
- Modify: `tests/data-service.test.mjs`
- Modify: `tests/utils.test.mjs`

**Interfaces:**
- Session adds private `accountSecurity: {state, maskedEmail, nextSendAt}` outside `profile`.
- Produces service methods:
  - `getAccountSecurityStatus()`
  - `requestRecoveryEmail(email, captchaToken)`
  - `verifyRecoveryEmail(code)`
  - `reauthenticate(currentPassword)`
  - `requestRecoveryEmailChange(newEmail, captchaToken)`
  - `confirmRecoveryEmailChangeOld(code)`
  - `confirmRecoveryEmailChangeNew(code)`
  - `requestPasswordRecovery(studentNumber, captchaToken)`
  - `completePasswordRecovery(studentNumber, code, newPassword, captchaToken)`
- Produces `canWrite(): boolean` for consistent UI behavior; database RLS remains authoritative.

- [ ] **Step 1: Write failing demo-service behavior tests**

```js
test("新账号未验证邮箱时可登录阅读但不能写入", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signUp({
    studentNumber: "2024555555",
    password: "newmember88",
    penName: "远岫",
    recoveryEmail: "reader@example.com",
    captchaToken: "test-token",
  });
  assert.equal(session.accountSecurity.state, "pending");
  assert.ok((await service.listWorks()).length > 0);
  await assert.rejects(() => service.createWork({
    title: "未验证", excerpt: "", content: "正文", category: "新诗",
  }), /验证找回邮箱/);
  await service.verifyRecoveryEmail("123456");
  assert.equal(service.canWrite(), true);
});

test("密码找回对存在与不存在账号返回相同文案", async () => {
  const service = createDataService({ mode: "demo" });
  const known = await service.requestPasswordRecovery("2023123456", "test-token");
  const missing = await service.requestPasswordRecovery("2099999999", "test-token");
  assert.equal(known.message, missing.message);
});
```

- [ ] **Step 2: Run service tests and verify RED**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs`
Expected: FAIL because the new session state and methods do not exist.

- [ ] **Step 3: Implement the demo state and uniform write guard**

Existing demo accounts receive verified fictional recovery addresses. Newly registered accounts start at `pending` with demo code `123456`. Add one `requireVerifiedSession()` guard and call it from every demo write method, including admin recommendation and profile updates.

Do not add recovery email fields to `profile`. Keep them in a separate private `state.accountSecurityByUserId` map.

- [ ] **Step 4: Implement Supabase function invocation**

```js
async function invokeFunction(name, body) {
  const client = await getClient();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) throw new Error(data?.message || error.message);
  return data;
}
```

`getSession()` fetches `account-email/status` only after a user session exists and caches the result beside `profile`. `signUp` accepts `recoveryEmail` and a fresh `captchaToken`; the token is consumed only by `account-email/request-bind`. If account creation succeeds but verification delivery fails, return the new session with `deliveryWarning` instead of reporting that registration failed.

`reauthenticate(currentPassword)` calls `signInWithPassword` with `cachedSession.user.email` and the supplied password, then refreshes the cached user before `request-change`.

- [ ] **Step 5: Run service and full tests**

Run: `node --test tests/data-service.test.mjs tests/utils.test.mjs`
Expected: PASS.

Run: `npm test`
Expected: all unit/static and browser checks pass.

- [ ] **Step 6: Commit**

```bash
git add js/data-service.mjs js/demo-data.mjs tests/data-service.test.mjs tests/utils.test.mjs
git commit -m "feat: add account security service contract"
```

### Task 7: Add account-security and password-recovery UI

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`
- Modify: `js/utils.mjs`
- Modify: `assets/styles.css`
- Modify: `tests/account-security-ui.test.mjs`
- Modify: `tests/static-checks.mjs`
- Modify: `tests/browser-check.cjs`

**Interfaces:**
- Adds route `#/account/security`.
- Adds actions `open-password-recovery`, `request-recovery-code`, `verify-recovery-code`, `request-email-change`, `confirm-old-email`, `confirm-new-email`.
- Adds `requireVerifiedWrite(returnHash)` before every browser write interaction.

- [ ] **Step 1: Write failing static and browser assertions**

```js
test("账号安全页和找回密码表单不公开邮箱", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-action="open-password-recovery"/);
  assert.match(app, /account-security/);
  assert.match(app, /requireVerifiedWrite/);
  assert.doesNotMatch(html, /accounts\.wenyuan\.invalid/);
});
```

Extend Playwright to assert:

1. Existing verified demo member can still post.
2. New demo member registers with a recovery email, can read, and receives a write-block reminder.
3. Code `123456` verifies the demo account and enables writing.
4. Password request for known and unknown student numbers renders identical text.
5. Account-security page displays only the masked email.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/account-security-ui.test.mjs tests/static-checks.mjs`
Expected: FAIL because the page, actions, and guard do not exist.

- [ ] **Step 3: Extend registration and login dialogs**

Add required `recoveryEmail` and one Turnstile widget to registration. Its fresh token is sent to `account-email/request-bind` after Auth signup succeeds and is never reused, because Turnstile tokens are single-use. Include this privacy copy:

```html
<p class="privacy-note">
  邮箱仅用于账号验证与找回密码，不接收评论、关注或其他社区消息。
</p>
```

Add “忘记密码” below login. The recovery dialog has two explicit stages: request code, then submit student number + code + new password. Both submissions obtain a fresh Turnstile token.

- [ ] **Step 4: Add the account-security route and write reminder**

The route renders one of four states:

- `unbound`：输入邮箱并发送验证码。
- `pending`：输入六位验证码、显示重发倒计时。
- `verified`：只显示掩码邮箱和“更换邮箱”。
- `changing`：先旧邮箱验证码，再新邮箱验证码。

Every write entry point calls:

```js
function requireVerifiedWrite(returnHash = window.location.hash) {
  if (!state.session) {
    openAuth("login", returnHash);
    return false;
  }
  if (state.session.accountSecurity?.state !== "verified") {
    state.accountSecurityReturnHash = returnHash;
    window.location.hash = "#/account/security";
    showToast("请先验证找回邮箱，再继续操作。", "info");
    return false;
  }
  return true;
}
```

Do not remove server errors: if RLS still rejects a write, surface “请先验证找回邮箱后再进行此操作” and route to the account-security page.

- [ ] **Step 5: Apply the approved visual and accessibility constraints**

- Account metadata is at least 13px.
- Form body text is 16px on mobile.
- Buttons, inputs, tabs, and resend controls are at least 44px high.
- Focus rings remain visible.
- Use the existing rice-paper, ink, and muted vermilion tokens.
- Do not display a complete recovery email after submission.

- [ ] **Step 6: Run focused and full browser tests**

Run: `node --test tests/account-security-ui.test.mjs tests/static-checks.mjs`
Expected: PASS.

Run: `npm test`
Expected: all unit/static tests pass and desktop/mobile browser flows pass.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js js/utils.mjs assets/styles.css tests/account-security-ui.test.mjs tests/static-checks.mjs tests/browser-check.cjs
git commit -m "feat: add recovery email account screens"
```

### Task 8: Document secrets, staging deployment, rollback, and privacy

**Files:**
- Create: `supabase/functions/.env.example`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `tests/static-checks.mjs`

**Interfaces:**
- Required non-secret config names: `ALLOWED_ORIGINS`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`.
- Required secrets: `BREVO_API_KEY`, `TURNSTILE_SECRET_KEY`, `TOKEN_PEPPER`, `RATE_LIMIT_PEPPER`.
- Rollout states: `off -> warn -> enforce`.

- [ ] **Step 1: Write failing documentation safety checks**

```js
test("安全文档列出全部账号秘密且禁止进入前端", async () => {
  const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  for (const name of [
    "BREVO_API_KEY", "TURNSTILE_SECRET_KEY", "TOKEN_PEPPER", "RATE_LIMIT_PEPPER",
  ]) assert.match(security, new RegExp(name));
  assert.match(security, /off.*warn.*enforce/s);
  assert.match(security, /每天最多 200/);
});
```

- [ ] **Step 2: Run static checks and verify RED**

Run: `node --test tests/static-checks.mjs`
Expected: FAIL because the secret and rollout documentation is absent.

- [ ] **Step 3: Add exact staging instructions**

Document this order:

1. Confirm target ref is the empty staging project.
2. Run `20260731`, `20260802_allow_weekly_pen_name_changes.sql`, then `20260802_account_recovery_security.sql`.
3. Confirm all eight business/private tables have RLS enabled.
4. Set Edge secrets through Dashboard; never paste secret values into chat, terminal output, files, screenshots, or Git.
5. Register one Brevo sender and record the provider-replaced transactional sender address in the member help copy.
6. Use official Turnstile test keys locally and a separate production widget later.
7. Deploy `account-email` with JWT verification and `password-recovery` as publishable/public.
8. Use only fictional staging accounts.
9. Set staging `account_security.write_gate` to `enforce`.
10. Run the browser and manual RLS matrix.

`supabase/functions/.env.example` contains names with empty values only:

```dotenv
ALLOWED_ORIGINS=http://127.0.0.1:4173
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=文苑账号安全
TURNSTILE_SECRET_KEY=
TOKEN_PEPPER=
RATE_LIMIT_PEPPER=
```

- [ ] **Step 4: Document production rollout and rollback**

Production remains `off` while schema and functions deploy. Switch to `warn` after smoke tests so UI prompts without blocking database writes. Open binding in batches of at most 200 accounts/day. Only after sampled login, posting, recovery, duplicate-email, rate-limit, and privacy tests pass may the user separately approve `enforce`.

Rollback is one SQL update:

```sql
update public.site_settings
set value = jsonb_set(value, '{write_gate}', '"warn"'::jsonb, true)
where key = 'account_security';
```

Rollback retains verified email rows and tokens; it only stops enforcing the write gate.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/static-checks.mjs tests/schema.test.mjs`
Expected: PASS.

```bash
git add .gitignore supabase/functions/.env.example README.md SECURITY.md tests/static-checks.mjs
git commit -m "docs: add account security rollout guide"
```

### Task 9: Verify locally, then perform an explicit staging-only checkpoint

**Files:**
- No new product files.
- Update test evidence only if the repository already tracks it.

**Interfaces:**
- Consumes the completed Tasks 1–8.
- Produces a clean local branch and a staging deployment checklist requiring user approval for external writes.

- [ ] **Step 1: Run all local verification**

Run: `npm test`
Expected: all unit/static tests pass; desktop and mobile browser flows pass.

Run: `git diff --check`
Expected: no whitespace errors.

Run: `git status --short`
Expected: no uncommitted tracked or untracked product files; ignored `js/config.local.mjs` and local env files do not appear.

- [ ] **Step 2: Run secret scans**

```powershell
git grep -n -E "sb_secret_|service_role|xkeysib-|TURNSTILE_SECRET_KEY=.+|TOKEN_PEPPER=.+" HEAD
```

Expected: only documentation warnings and empty example assignments; no real secret values.

Run a separate exact search for the staging project ref and supplied publishable key.
Expected: neither appears in tracked `HEAD`.

- [ ] **Step 3: Stop before external writes and request staging authorization**

Report:

- commit list,
- local test counts,
- files and migrations prepared,
- exact staging project ref detected from the ignored local config,
- which secrets the user must enter in the Supabase Dashboard,
- that production remains untouched.

Do not run migrations, set secrets, deploy functions, create remote users, or send Brevo mail until the user explicitly authorizes staging-only external writes.

- [ ] **Step 4: After staging authorization, execute the staging matrix**

The matrix must cover:

1. anonymous read succeeds and anonymous writes fail,
2. unverified login/read succeeds and every write fails in `enforce`,
3. verified member writes succeed,
4. admin without verification cannot write,
5. admin after verification can use existing admin writes,
6. duplicate recovery email is rejected without exposing owner,
7. known and unknown student numbers receive the same reset response,
8. sixth wrong code fails after the fifth attempt,
9. fourth same-day email request is rate-limited,
10. password reset preserves the same user UUID and original works,
11. logs contain request IDs but no complete email, student number, code, password, or work content.

- [ ] **Step 5: Commit only test or documentation corrections**

If staging reveals a defect, return to the task that owns it, reproduce with a failing local test, implement one fix, rerun `npm test`, and make a focused commit. Never patch production directly.

## Final Acceptance

- Existing user UUIDs, profile IDs, works, comments, likes, and ownership remain unchanged.
- Existing members still log in using student number and password.
- Unverified users can log in and read.
- In `enforce` mode, every database write by an unverified account fails even if the browser UI is bypassed.
- Recovery emails are unique, private, masked in the UI, and used only for account security.
- Brevo receives only the recipient email and security-message content needed for delivery.
- Password recovery is enumeration-safe and rate-limited.
- Production config and staging config cannot be confused by a local file.
- No secret or staging connection value is committed.
- Production remains unchanged until a separate explicit production authorization.
