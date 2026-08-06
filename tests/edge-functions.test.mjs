import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createAccountEmailHandler,
} from "../supabase/functions/account-email/logic.mjs";
import {
  buildAdminClientOptions,
  buildUserClientOptions,
  createSupabaseRequestClients,
  parseSupabaseSecretKeys,
} from "../supabase/functions/_shared/clients-core.mjs";
import {
  createAccountEmailProductionHandler,
} from "../supabase/functions/account-email/runtime.mjs";
import {
  createPasswordRecoveryHandler,
} from "../supabase/functions/password-recovery/logic.mjs";
import {
  createPasswordRecoveryProductionHandler,
} from "../supabase/functions/password-recovery/runtime.mjs";
import { createAccountStore } from "../supabase/functions/_shared/account-store.ts";

import { createTrustedDenoServeHandler } from "../supabase/functions/_shared/edge-runtime.mjs";
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
    this.rateLimitResults = [true, true, true, true, true];
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
    if (!token || token.usedAt !== null) return false;
    token.usedAt = usedAt;
    return true;
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

  async restoreConsumedToken({
    tokenId,
    consumedAttemptCount,
    consumedUsedAt,
  }) {
    this.events.push([
      "restore-token",
      tokenId,
      consumedAttemptCount,
      consumedUsedAt,
    ]);
    const token = this.tokens.find(({ id }) => id === tokenId);
    if (
      !token ||
      token.usedAt !== consumedUsedAt ||
      token.attemptCount !== consumedAttemptCount
    ) return false;
    token.usedAt = null;
    token.attemptCount = consumedAttemptCount - 1;
    return true;
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

function createHarness({
  captchaFailure = false,
  sendFailure = false,
  sendFailurePurposes = [],
  trustedNetworkIdentity = "198.51.100.24",
  sendFailureOncePurposes = [],
  serverRequestId = "req_public_123",
} = {}) {
  const events = [];
  const sent = [];
  const logs = [];
  const store = new MemoryAccountStore(events);
  const codes = ["123456", "654321", "111111"];
  const pendingSendFailures = new Set(sendFailureOncePurposes);
  const handler = createAccountEmailHandler({
    store,
    allowedOrigins: [ORIGIN],
    now: () => new Date(NOW),
    createCode: () => codes.shift(),
    createRequestId: () => serverRequestId,
    tokenPepper: "test-token-pepper",
    rateLimitPepper: "test-rate-pepper",
    verifyTurnstile: async (token, requestId) => {
      events.push(["turnstile", token, requestId]);
      if (captchaFailure) throw new Error("captcha leaked person@example.com");
      if (!token) throw new Error("captcha rejected");
    },
    sendSecurityEmail: async (message) => {
      events.push(["send-email", { ...message }]);
      if (sendFailure || sendFailurePurposes.includes(message.purpose)) {
        throw new Error("provider exposed recipient");
      }
      if (pendingSendFailures.delete(message.purpose)) {
        throw new Error("provider exposed recipient once");
      }
      sent.push({ ...message });
      return { messageId: `message-${sent.length}` };
    },
    logger: (entry) => logs.push(entry),
  });
  const actionHandler = handler;
  const trustedHandler = (incomingRequest, context = {}) =>
    actionHandler(incomingRequest, { trustedNetworkIdentity, ...context });
  return { events, handler: trustedHandler, logs, sent, store };
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

test("request-bind consumes cooldown and daily send buckets before persistence", async () => {
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
  assert.deepEqual(
    rateCalls.map(([, input]) => ({
      action: input.action,
      scope: input.scope,
      windowSeconds: input.windowSeconds,
      maxRequests: input.maxRequests,
    })),
    [
      {
        action: "bind_email:account_cooldown",
        scope: "account",
        windowSeconds: 60,
        maxRequests: 1,
      },
      {
        action: "bind_email:email_cooldown",
        scope: "email",
        windowSeconds: 60,
        maxRequests: 1,
      },
      {
        action: "bind_email:account_daily",
        scope: "account",
        windowSeconds: 86400,
        maxRequests: 3,
      },
      {
        action: "bind_email:email_daily",
        scope: "email",
        windowSeconds: 86400,
        maxRequests: 3,
      },
      {
        action: "bind_email:network_daily",
        scope: "network",
        windowSeconds: 86400,
        maxRequests: 20,
      },
    ],
  );
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
  store.rateLimitResults = [true, false, true, true, true];
  const response = await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  assert.equal(response.status, 429);
  assert.equal((await bodyOf(response)).error.code, "rate_limited");
  assert.deepEqual(
    events.map(([name]) => name),
    [
      "turnstile",
      "rate-limit",
      "rate-limit",
      "rate-limit",

      "rate-limit",
      "rate-limit",
    ],
  );
  assert.equal(store.tokens.length, 0);
});

test("send limits derive network digest only from trusted server connection identity", async () => {
  const first = createHarness({ trustedNetworkIdentity: "198.51.100.24" });
  let response = await first.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }, {
    headers: {
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "203.0.113.2",
    },
  }), { userClaims: claims() });
  assert.equal(response.status, 200);

  const second = createHarness({ trustedNetworkIdentity: "198.51.100.24" });
  response = await second.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }, {
    headers: {
      "cf-connecting-ip": "192.0.2.1",
      "x-forwarded-for": "192.0.2.2",
    },
  }), { userClaims: claims() });
  assert.equal(response.status, 200);

  const third = createHarness({ trustedNetworkIdentity: "198.51.100.99" });
  response = await third.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);

  const digestFor = ({ events }) => {
    const call = events.find(([, input]) => input?.scope === "network");
    assert.ok(call, "network daily bucket must be consumed");
    return call[1].keyDigest;
  };
  assert.equal(digestFor(first), digestFor(second));
  assert.notEqual(digestFor(first), digestFor(third));
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
  assert.deepEqual(
    events
      .filter(([name]) => name === "rate-limit")
      .map(([, input]) => input.action),
    ["change_email_old:account_cooldown", "change_email_old:email_cooldown",
      "change_email_old:account_daily", "change_email_old:email_daily",
      "change_email_old:network_daily"],
  );
});

test("request-change rejects missing, future, and nonnumeric JWT iat", async () => {
  for (const issuedAt of [
    undefined,
    Math.floor(NOW.getTime() / 1000) + 1,
    "not-a-number",
  ]) {
    const { events, handler, store } = createHarness();
    store.recoveryByUser.set(USER_ID, {
      emailNormalized: "person@example.com",
      verifiedAt: NOW.toISOString(),
    });
    const response = await handler(request({
      action: "request-change",
      newEmail: "next@example.net",
      captchaToken: "captcha-change",
    }), { userClaims: claims({ iat: issuedAt }) });
    const body = await bodyOf(response);
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "recent_login_required");
    assert.equal(events.some(([name]) => name === "turnstile"), false);
    assert.doesNotMatch(JSON.stringify(body), /person@example\.com|next@example\.net/);
  }
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
    "rate-limit",
    "rate-limit",
    "rate-limit",
    "rate-limit",
    "rate-limit",
    "invalidate",
    "insert-token",
    "send-email",
  ]);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    events
      .filter(([name]) => name === "rate-limit")
      .map(([, input]) => input.action),
    ["change_email_new:account_cooldown", "change_email_new:email_cooldown",
      "change_email_new:account_daily", "change_email_new:email_daily",
      "change_email_new:network_daily"],
  );
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

test("browser CORS rejects missing Origin and accepts Supabase SDK headers", async () => {
  const { handler } = createHarness();
  let response = await handler(new Request("https://edge.example/account-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "status" }),
  }), { userClaims: claims() });
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error.code, "origin_not_allowed");
  assert.equal(response.headers.get("access-control-allow-origin"), null);

  response = await handler(new Request("https://edge.example/account-email", {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-headers":
        "authorization, x-client-info, apikey, content-type",
    },
  }), {});
  assert.equal(response.status, 204);
  const allowedHeaders = response.headers
    .get("access-control-allow-headers")
    .split(",")
    .map((value) => value.trim())
    .sort();
  assert.deepEqual(allowedHeaders, [
    "apikey",
    "authorization",
    "content-type",
    "x-client-info",
  ]);
});

test("server request ID replaces even a valid caller UUID for response and providers", async () => {
  const serverRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const callerRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { events, handler } = createHarness({ serverRequestId });
  const response = await handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }, {
    headers: { "x-request-id": callerRequestId },
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), serverRequestId);
  const turnstile = events.find(([name]) => name === "turnstile");
  const delivery = events.find(([name]) => name === "send-email");
  assert.equal(turnstile[2], serverRequestId);
  assert.equal(delivery[1].requestId, serverRequestId);
  assert.doesNotMatch(
    JSON.stringify({
      responseHeaders: Object.fromEntries(response.headers),
      turnstile,
      delivery,
    }),
    new RegExp(callerRequestId),
  );
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

test("Deno serve adapter injects remote hostname and ignores forwarded IP headers", async () => {
  const seen = [];
  const serveHandler = createTrustedDenoServeHandler(
    async (incomingRequest, serverContext) => {
      seen.push({
        forwarded: incomingRequest.headers.get("x-forwarded-for"),
        serverContext,
      });
      return new Response(null, { status: 204 });
    },
  );
  const response = await serveHandler(new Request("https://edge.example/account-email", {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "x-forwarded-for": "203.0.113.99",
      "cf-connecting-ip": "203.0.113.98",
    },
  }), { remoteAddr: { hostname: "198.51.100.24", port: 443 } });
  assert.equal(response.status, 204);
  assert.deepEqual(seen, [{
    forwarded: "203.0.113.99",
    serverContext: { trustedNetworkIdentity: "198.51.100.24" },
  }]);
});

async function beginEmailChange(harness) {
  harness.store.recoveryByUser.set(USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });
  const response = await harness.handler(request({
    action: "request-change",
    newEmail: "next@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  return harness.store.tokens.find(({ purpose }) => purpose === "change_email_old");
}

test("request-change old-email delivery failure invalidates its token without leakage", async () => {
  const harness = createHarness({
    sendFailurePurposes: ["change_email_old"],
  });
  harness.store.recoveryByUser.set(USER_ID, {
    emailNormalized: "person@example.com",
    verifiedAt: NOW.toISOString(),
  });
  const response = await harness.handler(request({
    action: "request-change",
    newEmail: "next@example.net",
    captchaToken: "captcha-change",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  const oldToken = harness.store.tokens.find(
    ({ purpose }) => purpose === "change_email_old",
  );
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "delivery_failed");
  assert.equal(oldToken.usedAt, NOW.toISOString());
  assert.doesNotMatch(
    JSON.stringify({ body, logs: harness.logs }),
    /person@example\.com|next@example\.net|123456|token-1|10000000-0000/,
  );
});

test("verify-bind restores the atomically consumed token when upsert fails", async () => {
  const harness = createHarness();
  await harness.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  const token = harness.store.tokens[0];
  harness.store.upsertRecoveryEmail = async () => {
    harness.events.push(["upsert-failed"]);
    const error = new Error("database leaked person@example.com");
    error.code = "storage_unavailable";
    throw error;
  };
  const response = await harness.handler(request({
    action: "verify-bind",
    code: "123456",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.equal(token.usedAt, null);
  assert.equal(token.attemptCount, 0);
  assert.deepEqual(
    harness.events.slice(-3).map(([name]) => name),
    ["consume-token", "upsert-failed", "restore-token"],
  );
  assert.doesNotMatch(
    JSON.stringify({ body, logs: harness.logs }),
    /person@example\.com|123456|token-1|10000000-0000/,
  );
});

test("confirm-change-old restores its code after uniqueness or insert failure", async () => {
  for (const scenario of ["uniqueness", "insert"]) {
    const harness = createHarness();
    const oldToken = await beginEmailChange(harness);
    if (scenario === "uniqueness") {
      harness.store.recoveryByUser.set(OTHER_USER_ID, {
        emailNormalized: "next@example.net",
        verifiedAt: NOW.toISOString(),
      });
    } else {
      harness.store.insertToken = async () => {
        harness.events.push(["insert-failed"]);
        const error = new Error("insert leaked next@example.net");
        error.code = "storage_unavailable";
        throw error;
      };
    }
    const response = await harness.handler(request({
      action: "confirm-change-old",
      code: "123456",
    }), { userClaims: claims() });
    const body = await bodyOf(response);
    assert.equal(response.status, scenario === "uniqueness" ? 409 : 503);
    assert.equal(
      body.error.code,
      scenario === "uniqueness" ? "email_unavailable" : "storage_unavailable",
    );
    assert.equal(oldToken.usedAt, null);
    assert.equal(oldToken.attemptCount, 0);
    assert.equal(
      harness.store.tokens.some((token) =>
        token.purpose === "change_email_new" && token.usedAt === null
      ),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify({ body, logs: harness.logs }),
      /person@example\.com|next@example\.net|123456|token-1|10000000-0000/,
    );
  }
});

test("confirm-change-old marks failed new token used and retries the same old code", async () => {
  const harness = createHarness({
    sendFailureOncePurposes: ["change_email_new"],
  });
  const oldToken = await beginEmailChange(harness);
  let response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  let body = await bodyOf(response);
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "delivery_failed");
  assert.equal(oldToken.usedAt, null);
  assert.equal(oldToken.attemptCount, 0);
  const failedNewToken = harness.store.tokens.find(
    ({ purpose }) => purpose === "change_email_new",
  );
  assert.equal(failedNewToken.usedAt, NOW.toISOString());
  assert.doesNotMatch(
    JSON.stringify({ body, logs: harness.logs }),
    /person@example\.com|next@example\.net|123456|654321|token-|10000000-0000/,
  );

  response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.equal(oldToken.usedAt, NOW.toISOString());
  assert.equal(oldToken.attemptCount, 1);
  assert.equal(
    harness.store.tokens.filter((token) =>
      token.purpose === "change_email_new" && token.usedAt === null
    ).length,
    1,
  );
});

test("confirm-change-new restores its code after uniqueness failure", async () => {
  const harness = createHarness();
  await beginEmailChange(harness);
  let response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  const newToken = harness.store.tokens.find(
    ({ purpose }) => purpose === "change_email_new",
  );
  harness.store.recoveryByUser.set(OTHER_USER_ID, {
    emailNormalized: "next@example.net",
    verifiedAt: NOW.toISOString(),
  });
  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "email_unavailable");
  assert.equal(newToken.usedAt, null);
  assert.equal(newToken.attemptCount, 0);

  harness.store.recoveryByUser.delete(OTHER_USER_ID);
  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  assert.equal(
    harness.store.recoveryByUser.get(USER_ID).emailNormalized,
    "next@example.net",
  );
});

test("confirm-change-new restores its code after update failure", async () => {
  const harness = createHarness();
  await beginEmailChange(harness);
  let response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
  const newToken = harness.store.tokens.find(
    ({ purpose }) => purpose === "change_email_new",
  );
  const updateRecoveryEmail = harness.store.updateRecoveryEmail.bind(harness.store);
  harness.store.updateRecoveryEmail = async () => {
    harness.events.push(["update-failed"]);
    const error = new Error("update leaked next@example.net");
    error.code = "storage_unavailable";
    throw error;
  };
  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.equal(newToken.usedAt, null);
  assert.equal(newToken.attemptCount, 0);
  assert.doesNotMatch(
    JSON.stringify({ body, logs: harness.logs }),
    /person@example\.com|next@example\.net|654321|token-|10000000-0000/,
  );

  harness.store.updateRecoveryEmail = updateRecoveryEmail;
  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
});

test("confirm-change-new restores after an update-time email conflict", async () => {
  const harness = createHarness();
  await beginEmailChange(harness);
  let response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);

  const newToken = harness.store.tokens.find(
    ({ purpose }) => purpose === "change_email_new",
  );
  const updateRecoveryEmail = harness.store.updateRecoveryEmail.bind(harness.store);
  harness.store.updateRecoveryEmail = async () => {
    const error = new Error("recovery email already belongs to another user");
    error.code = "email_conflict";
    throw error;
  };

  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "email_unavailable");
  assert.equal(newToken.usedAt, null);
  assert.equal(newToken.attemptCount, 0);

  harness.store.updateRecoveryEmail = updateRecoveryEmail;
  response = await harness.handler(request({
    action: "confirm-change-new",
    code: "654321",
  }), { userClaims: claims() });
  assert.equal(response.status, 200);
});

test("failed token restoration logs only safe metadata and returns 503", async () => {
  const harness = createHarness();
  await harness.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  harness.store.upsertRecoveryEmail = async () => {
    const error = new Error("upsert leaked person@example.com");
    error.code = "storage_unavailable";
    throw error;
  };
  harness.store.restoreConsumedToken = async () => {
    harness.events.push(["restore-failed"]);
    throw new Error("restore leaked token-1 and 123456");
  };
  const response = await harness.handler(request({
    action: "verify-bind",
    code: "123456",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.equal(
    harness.logs.some(({ event }) =>
      event === "account_email_compensation_failed"
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify({ body, logs: harness.logs }),
    /person@example\.com|123456|token-1|10000000-0000/,
  );
});

test("account store restores only the exact consumed token row", async () => {
  const calls = [];
  let matched = true;
  const chain = {
    update(values) {
      calls.push(["update", values]);
      return this;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return this;
    },
    not(column, operator, value) {
      calls.push(["not", column, operator, value]);
      return this;
    },
    select(columns) {
      calls.push(["select", columns]);
      return this;
    },
    async maybeSingle() {
      calls.push(["maybeSingle"]);
      return { data: matched ? { id: "token-atomic" } : null, error: null };
    },
  };
  const store = createAccountStore({
    from(table) {
      calls.push(["from", table]);
      return chain;
    },
    rpc() {
      throw new Error("restore must not call token consumption RPC");
    },
  });
  const consumedUsedAt = "2026-08-02T08:00:00.123Z";
  const restored = await store.restoreConsumedToken({
    tokenId: "token-atomic",
    consumedAttemptCount: 5,
    consumedUsedAt,
  });
  assert.equal(restored, true);
  assert.deepEqual(calls, [
    ["from", "account_action_tokens"],
    ["update", { used_at: null, attempt_count: 4 }],
    ["eq", "id", "token-atomic"],
    ["eq", "used_at", consumedUsedAt],
    ["eq", "attempt_count", 5],
    ["select", "id"],
    ["maybeSingle"],
  ]);
  calls.length = 0;
  matched = false;
  const staleRestore = await store.restoreConsumedToken({
    tokenId: "token-atomic",
    consumedAttemptCount: 5,
    consumedUsedAt,
  });
  assert.equal(staleRestore, false);
  assert.deepEqual(calls, [
    ["from", "account_action_tokens"],
    ["update", { used_at: null, attempt_count: 4 }],
    ["eq", "id", "token-atomic"],
    ["eq", "used_at", consumedUsedAt],
    ["eq", "attempt_count", 5],
    ["select", "id"],
    ["maybeSingle"],
  ]);
});

test("production client factory keeps secret keys out of Authorization", async () => {
  const calls = [];
  const publishableKey = "sb_publishable_public";
  const secretKey = "sb_secret_default";
  const adminClient = {
    auth: {
      admin: {
        updateUserById() {
          throw new Error("account-email must not update auth email");
        },
      },
    },
  };
  const createClientImpl = (url, apiKey, options) => {
    calls.push({ url, apiKey, options: structuredClone(options) });
    const explicitAuthorization = options.global?.headers?.Authorization;
    if (apiKey === secretKey && explicitAuthorization) {
      throw new Error("secret key entered Authorization");
    }
    if (apiKey === publishableKey) {
      return {
        auth: {
          async getClaims(jwt) {
            assert.equal(jwt, "user.jwt.value");
            return {
              data: { claims: { sub: USER_ID, iat: 1785657600 } },
              error: null,
            };
          },
        },
      };
    }
    return adminClient;
  };
  const clients = await createSupabaseRequestClients({
    createClientImpl,
    envGet: (name) => ({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: secretKey }),
    })[name],
    request: new Request("https://edge.example/account-email", {
      headers: { authorization: "Bearer user.jwt.value" },
    }),
  });
  assert.equal(clients.adminClient, adminClient);
  assert.equal(clients.userClaims.sub, USER_ID);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.global.headers, {
    Authorization: "Bearer user.jwt.value",
    apikey: publishableKey,
  });
  assert.equal(calls[1].apiKey, secretKey);
  assert.equal(calls[1].options.global?.headers?.Authorization, undefined);
  assert.equal(JSON.stringify(calls[1].options).includes(secretKey), false);
});

test("handler rejects a stale exact-restore CAS without leaking metadata", async () => {
  const harness = createHarness();
  await harness.handler(request({
    action: "request-bind",
    email: "person@example.com",
    captchaToken: "captcha-bind",
  }), { userClaims: claims() });
  const token = harness.store.tokens[0];
  harness.store.upsertRecoveryEmail = async () => {
    const error = new Error("upsert failed");
    error.code = "storage_unavailable";
    throw error;
  };
  let restoreInput;
  harness.store.restoreConsumedToken = async (input) => {
    restoreInput = input;
    return false;
  };

  const response = await harness.handler(request({
    action: "verify-bind",
    code: "123456",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.deepEqual(restoreInput, {
    tokenId: token.id,
    consumedAttemptCount: 1,
    consumedUsedAt: NOW.toISOString(),
  });
  assert.equal(token.usedAt, NOW.toISOString());
  assert.equal(
    harness.logs.some(({ event }) =>
      event === "account_email_compensation_failed"
    ),
    true,
  );
});

test("account store marks only an unused token and reports whether CAS matched", async () => {
  const calls = [];
  let matched = true;
  const chain = {
    update(values) {
      calls.push(["update", values]);
      return this;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return this;
    },
    is(column, value) {
      calls.push(["is", column, value]);
      return this;
    },
    select(columns) {
      calls.push(["select", columns]);
      return this;
    },
    async maybeSingle() {
      calls.push(["maybeSingle"]);
      return { data: matched ? { id: "token-new" } : null, error: null };
    },
  };
  const store = createAccountStore({
    from(table) {
      calls.push(["from", table]);
      return chain;
    },
    rpc() {
      throw new Error("mark must not call an RPC");
    },
  });
  const usedAt = "2026-08-02T08:00:00.456Z";
  const marked = await store.markTokenUsed({ tokenId: "token-new", usedAt });
  assert.equal(marked, true);
  assert.deepEqual(calls, [
    ["from", "account_action_tokens"],
    ["update", { used_at: usedAt }],
    ["eq", "id", "token-new"],
    ["is", "used_at", null],
    ["select", "id"],
    ["maybeSingle"],
  ]);

  calls.length = 0;
  matched = false;
  const staleMark = await store.markTokenUsed({ tokenId: "token-new", usedAt });
  assert.equal(staleMark, false);
});

test("old confirmation never restores old code when new-token termination misses", async () => {
  const harness = createHarness({
    sendFailureOncePurposes: ["change_email_new"],
  });
  const oldToken = await beginEmailChange(harness);
  let restoreCalls = 0;
  harness.store.markTokenUsed = async ({ tokenId, usedAt }) => {
    harness.events.push(["mark-used-missed", tokenId, usedAt]);
    return false;
  };
  harness.store.restoreConsumedToken = async () => {
    restoreCalls += 1;
    return true;
  };

  const response = await harness.handler(request({
    action: "confirm-change-old",
    code: "123456",
  }), { userClaims: claims() });
  const body = await bodyOf(response);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "storage_unavailable");
  assert.equal(restoreCalls, 0);
  assert.equal(oldToken.usedAt, NOW.toISOString());
  assert.equal(
    harness.logs.some(({ event }) =>
      event === "account_email_compensation_failed"
    ),
    true,
  );
});

test("production runtime confirms recovery change without mutating Auth email", async () => {
  const adminEvents = [];
  let authEmailUpdates = 0;
  let queryMode = "select";
  const query = {
    select(columns) {
      adminEvents.push(["select", columns]);
      return this;
    },
    update(values) {
      queryMode = "update";
      adminEvents.push(["update", values]);
      return this;
    },
    eq(column, value) {
      adminEvents.push(["eq", column, value]);
      return this;
    },
    neq(column, value) {
      adminEvents.push(["neq", column, value]);
      return this;
    },
    limit(value) {
      adminEvents.push(["limit", value]);
      return this;
    },
    async maybeSingle() {
      adminEvents.push(["maybeSingle", queryMode]);
      return {
        data: queryMode === "update" ? { user_id: USER_ID } : null,
        error: null,
      };
    },
  };
  const adminClient = {
    auth: {
      admin: {
        async updateUserById() {
          authEmailUpdates += 1;
          throw new Error("Auth email mutation is forbidden");
        },
      },
    },
    from(table) {
      queryMode = "select";
      adminEvents.push(["from", table]);
      return query;
    },
    async rpc(name) {
      assert.equal(name, "consume_account_action_token");
      return {
        data: [{
          id: "token-runtime",
          user_id: USER_ID,
          purpose: "change_email_new",
          token_digest: "\\x00",
          email_normalized: "person@example.com",
          next_email_normalized: "next@example.net",
          expires_at: "2026-08-02T08:10:00.000Z",
          attempt_count: 1,
          max_attempts: 5,
          used_at: NOW.toISOString(),
          created_at: "2026-08-02T07:59:00.000Z",
        }],
        error: null,
      };
    },
  };
  const publishableKey = "sb_publishable_runtime";
  const secretKey = "sb_secret_runtime";
  const createClientImpl = (_url, apiKey) => {
    if (apiKey === publishableKey) {
      return {
        auth: {
          async getClaims(jwt) {
            assert.equal(jwt, "runtime.user.jwt");
            return { data: { claims: claims() }, error: null };
          },
        },
      };
    }
    assert.equal(apiKey, secretKey);
    return adminClient;
  };
  const handler = createAccountEmailProductionHandler({
    createClientImpl,
    envGet: (name) => ({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: secretKey }),
    })[name],
    allowedOrigins: [ORIGIN],
    tokenPepper: "runtime-token-pepper",
    rateLimitPepper: "runtime-rate-pepper",
    verifyTurnstile: async () => {
      throw new Error("confirm-new must not call Turnstile");
    },
    sendSecurityEmail: async () => {
      throw new Error("confirm-new must not send email");
    },
    logger: () => {},
    now: () => new Date(NOW),
    createRequestId: () => "runtime-request-id",
  });

  const response = await handler(request({
    action: "confirm-change-new",
    code: "654321",
  }, {
    headers: { authorization: "Bearer runtime.user.jwt" },
  }), { trustedNetworkIdentity: "198.51.100.24" });
  const body = await bodyOf(response);
  assert.equal(response.status, 200);
  assert.equal(body.state, "verified");
  assert.equal(authEmailUpdates, 0);
  assert.equal(
    adminEvents.some(([event, values]) =>
      event === "update" &&
      values.email_normalized === "next@example.net" &&
      values.verified_at === NOW.toISOString()
    ),
    true,
  );
  assert.equal(
    adminEvents.some(([event, column, value]) =>
      event === "eq" && column === "user_id" && value === USER_ID
    ),
    true,
  );
});

function pwRequest(body, { origin = ORIGIN, headers = {} } = {}) {
  return new Request("https://edge.example/functions/v1/password-recovery", {
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

function createPasswordRecoveryHarness({
  captchaFailure = false,
  sendFailure = false,
  knownUsers = [],
  recoveryEmailFor = new Map(),
  rateLimitResults = [true, true, true, true, true],
  serverRequestId = "req_pw_123",
} = {}) {
  const events = [];
  const sent = [];
  const logs = [];
  const tokens = [];
  const passwordUpdates = [];
  let nextTokenId = 1;
  const store = {
    async consumeRateLimit(input) {
      events.push(["rate-limit", { ...input }]);
      return rateLimitResults.shift() ?? true;
    },
    async getRecoveryEmail(userId) {
      events.push(["get-recovery", userId]);
      return recoveryEmailFor.get(userId) ?? null;
    },
    async insertToken(input) {
      const token = {
        id: `pw-token-${nextTokenId++}`,
        attemptCount: 0,
        usedAt: null,
        createdAt: NOW.toISOString(),
        ...input,
      };
      events.push(["insert-token", { ...token }]);
      tokens.push(token);
      return token;
    },
    async markTokenUsed({ tokenId, usedAt }) {
      events.push(["mark-used", tokenId, usedAt]);
      const token = tokens.find(({ id }) => id === tokenId);
      if (!token || token.usedAt !== null) return false;
      token.usedAt = usedAt;
      return true;
    },
    async consumeToken({ tokenDigest, purpose, userId, maxAttempts }) {
      events.push(["consume-token", { tokenDigest, purpose, userId, maxAttempts }]);
      const token = [...tokens]
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
    },
    async restoreConsumedToken({
      tokenId,
      consumedAttemptCount,
      consumedUsedAt,
    }) {
      events.push([
        "restore-token",
        tokenId,
        consumedAttemptCount,
        consumedUsedAt,
      ]);
      const token = tokens.find(({ id }) => id === tokenId);
      if (
        !token ||
        token.usedAt !== consumedUsedAt ||
        token.attemptCount !== consumedAttemptCount
      ) return false;
      token.usedAt = null;
      token.attemptCount = consumedAttemptCount - 1;
      return true;
    },
  };
  const usersByNumber = new Map(
    knownUsers.map(({ studentNumber, userId }) => [studentNumber, { userId }]),
  );
  const deps = {
    async updateUserPassword(userId, newPassword) {
      events.push(["update-password", userId, newPassword]);
      passwordUpdates.push({ userId, newPassword });
    },
  };
  const codes = ["123456", "654321", "111111"];
  const handler = createPasswordRecoveryHandler({
    store,
    allowedOrigins: [ORIGIN],
    now: () => new Date(NOW),
    createCode: () => codes.shift(),
    createRequestId: () => serverRequestId,
    tokenPepper: "test-token-pepper",
    rateLimitPepper: "test-rate-pepper",
    verifyTurnstile: async (token, requestId) => {
      events.push(["turnstile", token, requestId]);
      if (captchaFailure) throw new Error("captcha failed");
      if (!token) throw new Error("captcha rejected");
    },
    sendSecurityEmail: async (message) => {
      events.push(["send-email", { ...message }]);
      if (sendFailure) throw new Error("provider failed");
      sent.push({ ...message });
      return { messageId: `message-${sent.length}` };
    },
    logger: (entry) => logs.push(entry),
    findUserByInternalEmail: async (internalEmail) => {
      events.push(["lookup-user", internalEmail]);
      const studentNumber = internalEmail.split("@")[0];
      return usersByNumber.get(studentNumber) ?? null;
    },
    updateUserPassword: (userId, newPassword) =>
      deps.updateUserPassword(userId, newPassword),
  });
  const trustedHandler = (incomingRequest, context = {}) =>
    handler(incomingRequest, { trustedNetworkIdentity: "198.51.100.24", ...context });
  return {
    events,
    handler: trustedHandler,
    logs,
    sent,
    store,
    tokens,
    passwordUpdates,
    deps,
  };
}

test("password recovery request returns the identical fixed message for every account state", async () => {
  const harness = createPasswordRecoveryHarness({
    knownUsers: [
      { studentNumber: "2023123456", userId: USER_ID },
      { studentNumber: "2023000001", userId: OTHER_USER_ID },
    ],
    recoveryEmailFor: new Map([
      [USER_ID, { emailNormalized: "person@example.com", verifiedAt: NOW.toISOString() }],
    ]),
  });
  const { handler, sent } = harness;
  const expected = { ok: true, message: "如果账号存在且已绑定邮箱，我们已发送验证码。" };

  const known = await handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }));
  assert.equal(known.status, 200);
  assert.deepEqual(await bodyOf(known), expected);

  const recoveryMissing = await handler(pwRequest({
    action: "request",
    studentNumber: "2023000001",
    captchaToken: "t",
  }));
  assert.equal(recoveryMissing.status, 200);
  assert.deepEqual(await bodyOf(recoveryMissing), expected);

  const unknown = await handler(pwRequest({
    action: "request",
    studentNumber: "2099999999",
    captchaToken: "t",
  }));
  assert.equal(unknown.status, 200);
  assert.deepEqual(await bodyOf(unknown), expected);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].purpose, "reset_password");
  assert.equal(sent[0].to, "person@example.com");
  assert.equal(sent[0].requestId, "req_pw_123");
  assert.equal(
    harness.events.filter(([name]) => name === "lookup-user").length,
    3,
  );
});

test("password recovery validates captcha before any account lookup", async () => {
  const harness = createPasswordRecoveryHarness({ captchaFailure: true });
  const response = await harness.handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "bad",
  }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "captcha_failed");
  assert.equal(
    harness.events.some(([name]) => name === "lookup-user"),
    false,
  );
});

test("password recovery complete updates the matched user password only", async () => {
  const harness = createPasswordRecoveryHarness({
    knownUsers: [{ studentNumber: "2023123456", userId: USER_ID }],
    recoveryEmailFor: new Map([
      [USER_ID, { emailNormalized: "person@example.com", verifiedAt: NOW.toISOString() }],
    ]),
  });
  await harness.handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }));
  const response = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "123456",
    newPassword: "newpass88",
    captchaToken: "t",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    ok: true,
    message: "密码已更新，请使用新密码登录。",
  });
  assert.equal(harness.passwordUpdates.length, 1);
  assert.deepEqual(harness.passwordUpdates[0], {
    userId: USER_ID,
    newPassword: "newpass88",
  });
});

test("password recovery complete rejects the correct code after five wrong attempts", async () => {
  const harness = createPasswordRecoveryHarness({
    knownUsers: [{ studentNumber: "2023123456", userId: USER_ID }],
    recoveryEmailFor: new Map([
      [USER_ID, { emailNormalized: "person@example.com", verifiedAt: NOW.toISOString() }],
    ]),
  });
  await harness.handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }));
  for (const code of ["000000", "111111", "222222", "333333", "444444"]) {
    const response = await harness.handler(pwRequest({
      action: "complete",
      studentNumber: "2023123456",
      code,
      newPassword: "newpass88",
      captchaToken: "t",
    }));
    assert.equal(response.status, 400);
  }
  const sixth = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "123456",
    newPassword: "newpass88",
    captchaToken: "t",
  }));
  assert.equal(sixth.status, 400);
  assert.equal((await bodyOf(sixth)).error.code, "invalid_code");
  assert.equal(harness.passwordUpdates.length, 0);
  assert.equal(harness.tokens[0].attemptCount, 5);
});

test("password recovery complete validates student number, password, and code shape", async () => {
  const harness = createPasswordRecoveryHarness();

  let response = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "bad-number",
    code: "123456",
    newPassword: "newpass88",
    captchaToken: "t",
  }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_student_number");

  response = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "123456",
    newPassword: "short",
    captchaToken: "t",
  }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_password");

  response = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "12",
    newPassword: "newpass88",
    captchaToken: "t",
  }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error.code, "invalid_code");
});

test("password recovery complete restores the code when the password update fails", async () => {
  const harness = createPasswordRecoveryHarness({
    knownUsers: [{ studentNumber: "2023123456", userId: USER_ID }],
    recoveryEmailFor: new Map([
      [USER_ID, { emailNormalized: "person@example.com", verifiedAt: NOW.toISOString() }],
    ]),
  });
  harness.deps.updateUserPassword = async () => {
    throw new Error("update failed");
  };
  await harness.handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }));
  const response = await harness.handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "123456",
    newPassword: "newpass88",
    captchaToken: "t",
  }));
  assert.equal(response.status, 502);
  assert.equal((await bodyOf(response)).error.code, "password_update_failed");
  assert.equal(harness.tokens[0].usedAt, null);
  assert.equal(
    harness.logs.some(({ event }) =>
      event === "password_recovery_compensation_failed"
    ),
    false,
  );
});

test("password recovery delivery failure returns the fixed message and consumes the token", async () => {
  const harness = createPasswordRecoveryHarness({
    sendFailure: true,
    knownUsers: [{ studentNumber: "2023123456", userId: USER_ID }],
    recoveryEmailFor: new Map([
      [USER_ID, { emailNormalized: "person@example.com", verifiedAt: NOW.toISOString() }],
    ]),
  });
  const response = await harness.handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    ok: true,
    message: "如果账号存在且已绑定邮箱，我们已发送验证码。",
  });
  assert.equal(harness.tokens[0].usedAt, NOW.toISOString());
  assert.equal(
    harness.logs.some(({ event }) => event === "password_recovery_delivery_failed"),
    true,
  );
});

test("password recovery production runtime uses listUsers and updates password only", async () => {
  const adminEvents = [];
  let table = "";
  const tokenRow = {
    id: "pw-token-runtime",
    user_id: USER_ID,
    purpose: "reset_password",
    token_digest: "\\x00",
    email_normalized: "person@example.com",
    next_email_normalized: null,
    expires_at: "2026-08-02T08:10:00.000Z",
    attempt_count: 0,
    max_attempts: 5,
    used_at: null,
    created_at: "2026-08-02T08:00:00.000Z",
  };
  const recoveryRow = {
    user_id: USER_ID,
    email_normalized: "person@example.com",
    verified_at: NOW.toISOString(),
  };
  const chain = {
    select(columns) {
      adminEvents.push(["select", table, columns]);
      return this;
    },
    eq(column, value) {
      adminEvents.push(["eq", column, value]);
      return this;
    },
    is(column, value) {
      adminEvents.push(["is", column, value]);
      return this;
    },
    in(column, values) {
      adminEvents.push(["in", column, values]);
      return this;
    },
    gt(column, value) {
      adminEvents.push(["gt", column, value]);
      return this;
    },
    order(column, options) {
      adminEvents.push(["order", column, options]);
      return this;
    },
    limit(value) {
      adminEvents.push(["limit", value]);
      return this;
    },
    insert(values) {
      adminEvents.push(["insert", values]);
      return this;
    },
    update(values) {
      adminEvents.push(["update", values]);
      return this;
    },
    async maybeSingle() {
      adminEvents.push(["maybeSingle"]);
      if (table === "account_recovery_emails") return { data: recoveryRow, error: null };
      return { data: null, error: null };
    },
    async single() {
      adminEvents.push(["single"]);
      if (table === "account_action_tokens") return { data: tokenRow, error: null };
      return { data: null, error: null };
    },
  };
  const adminClient = {
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          adminEvents.push(["list-users", page, perPage]);
          return {
            data: {
              users: [{ id: USER_ID, email: "2023123456@accounts.wenyuan.invalid" }],
            },
            error: null,
          };
        },
        async updateUserById(userId, values) {
          adminEvents.push(["update-user", userId, { ...values }]);
          assert.equal(userId, USER_ID);
          assert.equal(Object.hasOwn(values, "password"), true);
          assert.equal(Object.hasOwn(values, "email"), false);
          assert.equal(values.password, "newpass88");
          return { data: {}, error: null };
        },
      },
    },
    from(target) {
      table = target;
      adminEvents.push(["from", target]);
      return chain;
    },
    async rpc(name) {
      adminEvents.push(["rpc", name]);
      if (name === "consume_auth_rate_limit") return { data: true, error: null };
      if (name === "consume_account_action_token") return { data: [tokenRow], error: null };
      return { data: null, error: null };
    },
  };
  const publishableKey = "sb_publishable_pw";
  const secretKey = "sb_secret_pw";
  let secretCalls = 0;
  const createClientImpl = (_url, apiKey) => {
    assert.equal(apiKey, secretKey);
    secretCalls += 1;
    return adminClient;
  };
  const sent = [];
  const handler = createPasswordRecoveryProductionHandler({
    createClientImpl,
    envGet: (name) => ({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: secretKey }),
      ALLOWED_ORIGINS: ORIGIN,
    })[name],
    allowedOrigins: [ORIGIN],
    tokenPepper: "runtime-token-pepper",
    rateLimitPepper: "runtime-rate-pepper",
    verifyTurnstile: async () => {},
    sendSecurityEmail: async (message) => {
      sent.push({ ...message });
      return { messageId: "message-runtime" };
    },
    logger: () => {},
    now: () => new Date(NOW),
    createRequestId: () => "pw-request-id",
  });

  const requestResponse = await handler(pwRequest({
    action: "request",
    studentNumber: "2023123456",
    captchaToken: "t",
  }), { trustedNetworkIdentity: "198.51.100.24" });
  assert.equal(requestResponse.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "person@example.com");
  assert.equal(
    adminEvents.some(([name, page, perPage]) =>
      name === "list-users" && page === 1 && perPage === 200
    ),
    true,
  );

  const completeResponse = await handler(pwRequest({
    action: "complete",
    studentNumber: "2023123456",
    code: "123456",
    newPassword: "newpass88",
    captchaToken: "t",
  }), { trustedNetworkIdentity: "198.51.100.24" });
  assert.equal(completeResponse.status, 200);
  assert.deepEqual(await bodyOf(completeResponse), {
    ok: true,
    message: "密码已更新，请使用新密码登录。",
  });
  assert.equal(
    adminEvents.some(([name, userId]) =>
      name === "update-user" && userId === USER_ID
    ),
    true,
  );
  assert.equal(secretCalls, 1);
  assert.equal(
    JSON.stringify(adminEvents).includes(secretKey),
    false,
  );
});
