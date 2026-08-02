import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createAccountEmailHandler,
} from "../supabase/functions/account-email/logic.mjs";
import {
  buildAdminClientOptions,
  buildUserClientOptions,
  parseSupabaseSecretKeys,
} from "../supabase/functions/_shared/clients-core.mjs";
import { createAccountStore } from "../supabase/functions/_shared/account-store.ts";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-02T08:00:00.000Z");
const ORIGIN = "https://wenyuan.example";

function claims(overrides = {}) {
  return {
    sub: USER_ID,
    iat: Math.floor(NOW.getTime() / 1000),
    ...overrides,
  };
}

function request(body, { origin = ORIGIN, headers = {} } = {}) {
  return new Request("https://edge.example/functions/v1/account-email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "cf-connecting-ip": "203.0.113.42",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function assertPublicState(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [
    "maskedEmail",
    "nextSendAt",
    "state",
  ]);
  assert.deepEqual(value, expected);
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "person@example.com",
    "next@example.net",
    USER_ID,
    "123456",
    "654321",
    "2026123456",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(".", "\\.")));
  }
}

class MemoryAccountStore {
  constructor(events) {
    this.events = events;
    this.recoveryByUser = new Map();
    this.tokens = [];
    this.nextTokenId = 1;
    this.rateLimitResults = [true, true, true];
  }

  async getRecoveryEmail(userId) {
    this.events.push(["get-recovery", userId]);
    return this.recoveryByUser.get(userId) ?? null;
  }

  async getLatestActiveToken({ userId, purposes, now }) {
    this.events.push(["get-active-token", userId, [...purposes], now]);
    return [...this.tokens]
      .reverse()
      .find((token) =>
        token.userId === userId &&
        purposes.includes(token.purpose) &&
        token.usedAt === null &&
        token.expiresAt > now
      ) ?? null;
  }

  async consumeRateLimit(input) {
    this.events.push(["rate-limit", { ...input }]);
    return this.rateLimitResults.shift() ?? true;
  }

  async isEmailOwnedByAnother({ emailNormalized, userId }) {
    this.events.push(["unique-check", emailNormalized, userId]);
    return [...this.recoveryByUser.entries()].some(
      ([ownerId, row]) =>
        ownerId !== userId && row.emailNormalized === emailNormalized,
    );
  }

  async invalidateUnusedTokens({ userId, purposes, usedAt }) {
    this.events.push(["invalidate", userId, [...purposes], usedAt]);
    for (const token of this.tokens) {
      if (
        token.userId === userId &&
        purposes.includes(token.purpose) &&
        token.usedAt === null
      ) token.usedAt = usedAt;
    }
  }

  async insertToken(input) {
    const token = {
      id: `token-${this.nextTokenId++}`,
      attemptCount: 0,
      usedAt: null,
      createdAt: NOW.toISOString(),
      ...input,
    };
    this.events.push(["insert-token", { ...token }]);
    this.tokens.push(token);
    return token;
  }

  async markTokenUsed({ tokenId, usedAt }) {
    this.events.push(["mark-used", tokenId, usedAt]);
    const token = this.tokens.find(({ id }) => id === tokenId);
    if (token) token.usedAt = usedAt;
  }

  async consumeToken({ tokenDigest, purpose, userId, maxAttempts }) {
    this.events.push([
      "consume-token",
      { tokenDigest, purpose, userId, maxAttempts },
    ]);
    const token = [...this.tokens]
      .reverse()
      .find((candidate) =>
        candidate.userId === userId &&
        candidate.purpose === purpose &&
        candidate.usedAt === null
      );
    if (
      !token ||
      token.expiresAt <= NOW.toISOString() ||
      token.attemptCount >= Math.min(token.maxAttempts, maxAttempts)
    ) return null;
    token.attemptCount += 1;
    if (token.tokenDigest !== tokenDigest) return null;
    token.usedAt = NOW.toISOString();
    return { ...token };
  }

  async upsertRecoveryEmail({ userId, emailNormalized, verifiedAt }) {
    this.events.push(["upsert-recovery", userId, emailNormalized, verifiedAt]);
    if (await this.isEmailOwnedByAnother({ emailNormalized, userId })) {
      const error = new Error("duplicate");
      error.code = "email_conflict";
      throw error;
    }
    this.recoveryByUser.set(userId, { emailNormalized, verifiedAt });
  }

  async updateRecoveryEmail({ userId, emailNormalized, verifiedAt }) {
    this.events.push(["update-recovery", userId, emailNormalized, verifiedAt]);
    if (!this.recoveryByUser.has(userId)) throw new Error("missing recovery");
    if (await this.isEmailOwnedByAnother({ emailNormalized, userId })) {
      const error = new Error("duplicate");
      error.code = "email_conflict";
      throw error;
    }
    this.recoveryByUser.set(userId, { emailNormalized, verifiedAt });
  }

  async updateAuthEmail() {
    this.events.push(["forbidden-auth-email-update"]);
    throw new Error("account-email must never update auth.users.email");
  }
}

function createHarness({ captchaFailure = false, sendFailure = false } = {}) {
  const events = [];
  const sent = [];
  const logs = [];
  const store = new MemoryAccountStore(events);
  const codes = ["123456", "654321", "111111"];
  const handler = createAccountEmailHandler({
    store,
    allowedOrigins: [ORIGIN],
    now: () => new Date(NOW),
    createCode: () => codes.shift(),
    createRequestId: () => "req_public_123",
    tokenPepper: "test-token-pepper",
    rateLimitPepper: "test-rate-pepper",
    verifyTurnstile: async (token, requestId) => {
      events.push(["turnstile", token, requestId]);
      if (captchaFailure) throw new Error("captcha leaked person@example.com");
      if (!token) throw new Error("captcha rejected");
    },
    sendSecurityEmail: async (message) => {
      events.push(["send-email", { ...message }]);
      if (sendFailure) throw new Error("provider exposed recipient");
      sent.push({ ...message });
      return { messageId: `message-${sent.length}` };
    },
    logger: (entry) => logs.push(entry),
  });
  return { events, handler, logs, sent, store };
}

test("status exposes only the four public states and masked timing data", async () => {
  const { handler, store } = createHarness();

  let response = await handler(request({ action: "status" }), {
    userClaims: claims(),
  });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "unbound",
    maskedEmail: null,
    nextSendAt: null,
  });

  response = await handler(request({
    action: "request-bind",
    email: " Person@Example.com ",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "pending",
    maskedEmail: "p***n@e***e.com",
    nextSendAt: "2026-08-02T08:01:00.000Z",
  });

  response = await handler(request({ action: "verify-bind", code: "123456" }), {
    userClaims: claims(),
  });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "verified",
    maskedEmail: "p***n@e***e.com",
    nextSendAt: null,
  });

  response = await handler(request({
    action: "request-change",
    newEmail: "NEXT@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "changing",
    maskedEmail: "p***n@e***e.com",
    nextSendAt: "2026-08-02T08:01:00.000Z",
  });

  response = await handler(request({ action: "status" }), {
    userClaims: claims(),
  });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "changing",
    maskedEmail: "p***n@e***e.com",
    nextSendAt: "2026-08-02T08:01:00.000Z",
  });
  assert.equal(store.recoveryByUser.get(USER_ID).emailNormalized, "person@example.com");
});

test("request-bind validates auth and email before every external check", async () => {
  const { events, handler } = createHarness();
  let response = await handler(request({
    action: "request-bind",
    email: "not-an-email",
    captchaToken: "captcha-secret",
  }), { userClaims: claims({ sub: undefined }) });
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error.code, "unauthorized");
  assert.deepEqual(events, []);

  response = await handler(new Request("https://edge.example/account-email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: "{not-json",
  }), {});
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error.code, "unauthorized");
  assert.deepEqual(events, []);

  response = await handler(request({
    action: "request-bind",
    email: "not-an-email",
    captchaToken: "captcha-secret",
  }), { userClaims: claims() });
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_email");
  assert.deepEqual(events, []);
});

test("request-bind performs captcha, three digest limits, uniqueness, invalidation, insert, then send", async () => {
  const { events, handler, sent, store } = createHarness();
  const response = await handler(request({
    action: "request-bind",
    email: " Person@Example.com ",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    events.map(([name]) => name),
    [
      "turnstile",
      "rate-limit",
      "rate-limit",
      "rate-limit",
      "unique-check",
      "get-recovery",
      "invalidate",
      "insert-token",
      "send-email",
    ],
  );
  const rateCalls = events.filter(([name]) => name === "rate-limit");
  assert.deepEqual(rateCalls.map(([, input]) => input.scope), ["user", "email", "ip"]);
  for (const [, input] of rateCalls) {
    assert.match(input.keyDigest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(input.keyDigest, /person|203\.0\.113|10000000/);
  }
  const inserted = store.tokens[0];
  assert.equal(inserted.emailNormalized, "person@example.com");
  assert.equal(inserted.expiresAt, "2026-08-02T08:10:00.000Z");
  assert.equal(inserted.maxAttempts, 5);
  assert.match(inserted.tokenDigest, /^[a-f0-9]{64}$/);
  assert.equal(sent[0].to, "person@example.com");
  assert.equal(sent[0].purpose, "bind_email");
  assert.equal(sent[0].code, "123456");
  assert.equal(sent[0].expiresMinutes, 10);
});

test("request-bind consumes all rate-limit buckets and returns a generic 429", async () => {
  const { events, handler, store } = createHarness();
  store.rateLimitResults = [true, false, true];
  const response = await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  assert.equal(response.status, 429);
  assert.equal((await bodyOf(response)).error.code, "rate_limited");
  assert.deepEqual(
    events.map(([name]) => name),
    ["turnstile", "rate-limit", "rate-limit", "rate-limit"],
  );
  assert.equal(store.tokens.length, 0);
});

test("request-bind compensates a delivery failure by consuming the inserted token", async () => {
  const { events, handler, logs, store } = createHarness({ sendFailure: true });
  const response = await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "delivery_failed");
  assert.equal(store.tokens.length, 1);
  assert.equal(store.tokens[0].usedAt, NOW.toISOString());
  assert.deepEqual(events.slice(-2).map(([name]) => name), ["send-email", "mark-used"]);
  const publicSurface = JSON.stringify({ body, logs });
  for (const secret of [
    "person@example.com",
    "123456",
    store.tokens[0].tokenDigest,
    USER_ID,
  ]) assert.doesNotMatch(publicSurface, new RegExp(secret.replace(".", "\\.")));
});

test("duplicate recovery email never discloses its owner", async () => {
  const { handler, store } = createHarness();
  store.recoveryByUser.set(OTHER_USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });
  const response = await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "email_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /person@example\.com|10000000-0000/);
});

test("request-bind cannot replace an already verified recovery email", async () => {
  const { events, handler, store } = createHarness();
  store.recoveryByUser.set(USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });
  const response = await handler(request({
    action: "request-bind",
    email: "next@example.net",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "recovery_email_already_verified");
  assert.equal(events.some(([name]) => name === "insert-token"), false);
  assert.equal(events.some(([name]) => name === "send-email"), false);
  assert.equal(store.recoveryByUser.get(USER_ID).emailNormalized, "person@example.com");
});

test("captcha and database failures use safe, consistent public errors", async () => {
  let harness = createHarness({ captchaFailure: true });
  let response = await harness.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  let body = await bodyOf(response);
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "captcha_failed");
  assert.doesNotMatch(JSON.stringify({ body, logs: harness.logs }), /person@example\.com/);

  harness = createHarness();
  harness.store.consumeRateLimit = async () => {
    const error = new Error("database leaked person@example.com");
    error.code = "storage_unavailable";
    throw error;
  };
  response = await harness.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.doesNotMatch(JSON.stringify({ body, logs: harness.logs }), /person@example\.com/);
});

test("verify-bind atomically consumes the code and upserts the same authenticated UUID", async () => {
  const { events, handler, store } = createHarness();
  await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  events.length = 0;
  const response = await handler(request({ action: "verify-bind", code: "123456" }), {
    userClaims: claims(),
  });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "verified",
    maskedEmail: "p***n@e***e.com",
    nextSendAt: null,
  });
  assert.deepEqual(events.map(([name]) => name), [
    "consume-token",
    "upsert-recovery",
    "unique-check",
  ]);
  assert.equal(events[0][1].purpose, "bind_email");
  assert.equal(events[0][1].userId, USER_ID);
  assert.equal(events[0][1].maxAttempts, 5);
  assert.equal(store.recoveryByUser.get(USER_ID).emailNormalized, "person@example.com");
});

test("request-change requires a verified email and a JWT issued within five minutes", async () => {
  const { events, handler, store } = createHarness();
  let response = await handler(request({
    action: "request-change",
    newEmail: "next@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims({ iat: Math.floor(NOW.getTime() / 1000) - 301 }) });
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error.code, "recent_login_required");
  assert.equal(events.some(([name]) => name === "send-email"), false);

  events.length = 0;
  response = await handler(request({
    action: "request-change",
    newEmail: "next@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims({ iat: Math.floor(NOW.getTime() / 1000) - 300 }) });
  assert.equal(response.status, 409);
  assert.equal((await bodyOf(response)).error.code, "recovery_email_unverified");
  assert.equal(events.some(([name]) => name === "send-email"), false);

  store.recoveryByUser.set(USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });
  events.length = 0;
  response = await handler(request({
    action: "request-change",
    newEmail: "next@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims({ iat: Math.floor(NOW.getTime() / 1000) - 300 }) });
  assert.equal(response.status, 200);
});

test("two-step change sends new code only after old code consumption and never updates auth email", async () => {
  const { events, handler, sent, store } = createHarness();
  store.recoveryByUser.set(USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });

  let response = await handler(request({
    action: "request-change",
    newEmail: " NEXT@example.net ",
    captchaToken: "captcha-change",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { to: sent[0].to, purpose: sent[0].purpose },
    { to: "person@example.com", purpose: "change_email_old" },
  );
  const oldToken = store.tokens.at(-1);
  assert.equal(oldToken.nextEmailNormalized, "next@example.net");

  events.length = 0;
  response = await handler(request({
    action: "confirm-change-old",
    code: "999999",
  }), { userClaims: claims() });
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_code");
  assert.deepEqual(events.map(([name]) => name), ["consume-token"]);
  assert.equal(sent.length, 1);

  events.length = 0;
  response = await handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.deepEqual(events.map(([name]) => name), [
    "consume-token",
    "unique-check",
    "invalidate",
    "insert-token",
    "send-email",
  ]);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    { to: sent[1].to, purpose: sent[1].purpose },
    { to: "next@example.net", purpose: "change_email_new" },
  );

  events.length = 0;
  response = await handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assertPublicState(await bodyOf(response), {
    state: "verified",
    maskedEmail: "n***t@e***e.net",
    nextSendAt: null,
  });
  assert.deepEqual(events.map(([name]) => name), [
    "consume-token",
    "unique-check",
    "update-recovery",
    "unique-check",
  ]);
  assert.equal(events.some(([name]) => name === "forbidden-auth-email-update"), false);
  assert.equal(store.recoveryByUser.get(USER_ID).emailNormalized, "next@example.net");
});

test("origin, method, JSON, action, and request IDs use one public error envelope", async () => {
  const { handler } = createHarness();
  let response = await handler(request({ action: "status" }, {
    origin: "https://evil.example",
  }), { userClaims: claims() });
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), {
    error: {
      code: "origin_not_allowed",
      message: "请求来源不受信任",
      requestId: "req_public_123",
    },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);

  response = await handler(new Request("https://edge.example/account-email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: "{not-json",
  }), { userClaims: claims() });
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_json");
  assert.equal(response.headers.get("x-request-id"), "req_public_123");
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);

  response = await handler(new Request("https://edge.example/account-email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-request-id": "student-password-2026123456",
    },
    body: "{not-json",
  }), { userClaims: claims() });
  assert.equal(response.headers.get("x-request-id"), "req_public_123");
  assert.doesNotMatch(JSON.stringify(await bodyOf(response)), /student-password|2026123456/);

  response = await handler(request({ action: "unknown" }), {
    userClaims: claims(),
  });
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "unsupported_action");

  response = await handler(new Request("https://edge.example/account-email", {
    method: "GET",
    headers: { origin: ORIGIN },
  }), { userClaims: claims() });
  assert.equal(response.status, 405);
  assert.equal((await bodyOf(response)).error.code, "method_not_allowed");

  response = await handler(new Request("https://edge.example/account-email", {
    method: "OPTIONS",
    headers: { origin: ORIGIN },
  }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/i);
  assert.match(response.headers.get("access-control-allow-headers"), /apikey/i);
});

test("Supabase key parsing keeps user JWT bearer separate from API keys", () => {
  assert.deepEqual(
    parseSupabaseSecretKeys(JSON.stringify({
      default: "sb_secret_default",
      secondary: "sb_secret_secondary",
    })),
    { default: "sb_secret_default", secondary: "sb_secret_secondary" },
  );
  assert.throws(() => parseSupabaseSecretKeys("{}"), /配置/);

  const userOptions = buildUserClientOptions({
    jwt: "user.jwt.value",
    publishableKey: "sb_publishable_public",
  });
  assert.deepEqual(userOptions.global.headers, {
    Authorization: "Bearer user.jwt.value",
    apikey: "sb_publishable_public",
  });
  assert.equal(userOptions.auth.persistSession, false);

  const adminOptions = buildAdminClientOptions();
  assert.equal(adminOptions.global?.headers?.Authorization, undefined);
  assert.equal(JSON.stringify(adminOptions).includes("sb_secret"), false);
  assert.deepEqual(adminOptions.auth, {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  });
});

test("account store uses only atomic RPCs for rate limiting and code consumption", async () => {
  const rpcCalls = [];
  const client = {
    rpc: async (name, params) => {
      rpcCalls.push([name, params]);
      if (name === "consume_auth_rate_limit") return { data: true, error: null };
      if (name === "consume_account_action_token") {
        return {
          data: {
            id: "token-atomic",
            user_id: USER_ID,
            purpose: "bind_email",
            token_digest: "\\xdeadbeef",
            email_normalized: "person@example.com",
            next_email_normalized: null,
            expires_at: "2026-08-02T08:10:00.000Z",
            attempt_count: 1,
            max_attempts: 5,
            used_at: NOW.toISOString(),
            created_at: NOW.toISOString(),
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from() {
      throw new Error("atomic operations must not use table read/write chains");
    },
  };
  const store = createAccountStore(client);
  assert.equal(await store.consumeRateLimit({
    action: "request_bind",
    keyDigest: "a".repeat(64),
    windowSeconds: 900,
    maxRequests: 5,
  }), true);
  const token = await store.consumeToken({
    tokenDigest: "deadbeef",
    purpose: "bind_email",
    userId: USER_ID,
    maxAttempts: 5,
  });
  assert.equal(token.id, "token-atomic");
  assert.deepEqual(rpcCalls, [
    ["consume_auth_rate_limit", {
      p_action: "request_bind",
      p_key_digest: "\\x" + "a".repeat(64),
      p_window_seconds: 900,
      p_max_requests: 5,
    }],
    ["consume_account_action_token", {
      p_presented_token_digest: "\\xdeadbeef",
      p_purpose: "bind_email",
      p_user_id: USER_ID,
      p_caller_max_attempts: 5,
    }],
  ]);
});

test("Supabase function configuration enforces JWT only on account-email", async () => {
  const config = await readFile(
    new URL("../supabase/config.toml", import.meta.url),
    "utf8",
  );
  assert.match(config, /\[functions\.account-email\]\s*verify_jwt\s*=\s*true/);
  assert.match(config, /\[functions\.password-recovery\]\s*verify_jwt\s*=\s*false/);
});
