import {
  createNumericCode,
  digestSecret,
  maskRecoveryEmail,
  normalizeRecoveryEmail,
  SECURITY_CODE_EXPIRES_MINUTES,
  SECURITY_CODE_MAX_ATTEMPTS,
} from "../_shared/security-core.mjs";

const ACTIVE_TOKEN_PURPOSES = [
  "bind_email",
  "change_email_old",
  "change_email_new",
];
const SEND_COOLDOWN_MS = 60_000;
const RECENT_LOGIN_SECONDS = 5 * 60;
const PUBLIC_MESSAGES = Object.freeze({
  unauthorized: "请先登录",
  invalid_email: "找回邮箱格式不正确",
  invalid_code: "验证码无效或已过期",
  invalid_json: "请求内容格式不正确",
  unsupported_action: "不支持的操作",
  method_not_allowed: "请求方法不受支持",
  origin_not_allowed: "请求来源不受信任",
  rate_limited: "操作过于频繁，请稍后重试",
  email_unavailable: "该邮箱暂不可用",
  recovery_email_already_verified: "请通过换绑流程修改找回邮箱",
  recovery_email_unverified: "请先验证找回邮箱",
  recent_login_required: "请重新登录后再修改找回邮箱",
  captcha_failed: "人机验证失败，请刷新后重试",
  delivery_failed: "安全邮件发送失败，请稍后重试",
  storage_unavailable: "服务暂时不可用，请稍后重试",
  internal_error: "服务暂时不可用，请稍后重试",
});

export class PublicError extends Error {
  constructor(code, status, message = PUBLIC_MESSAGES[code]) {
    super(message ?? PUBLIC_MESSAGES.internal_error);
    this.name = "PublicError";
    this.code = code;
    this.status = status;
  }
}

function publicError(code, status) {
  return new PublicError(code, status);
}

function corsHeaders(origin, allowedOrigins) {
  if (!origin) throw publicError("origin_not_allowed", 403);
  if (!allowedOrigins.includes(origin)) throw publicError("origin_not_allowed", 403);
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}


function jsonResponse(body, status, requestId, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
      ...headers,
    },
  });
}

function stateResponse(state, maskedEmail, nextSendAt) {
  return { state, maskedEmail, nextSendAt };
}

function requireUser(context) {
  if (context?.authFailure === "internal") throw publicError("internal_error", 500);
  const sub = context?.userClaims?.sub;
  if (typeof sub !== "string" || sub.trim() === "") {
    throw publicError("unauthorized", 401);
  }
  return sub;
}

function requireRecentLogin(context, now) {
  const issuedAt = context?.userClaims?.iat;
  const age = Math.floor(now.getTime() / 1000) - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > RECENT_LOGIN_SECONDS) {
    throw publicError("recent_login_required", 401);
  }
}

function requireCode(value) {
  const code = String(value ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw publicError("invalid_code", 400);
  return code;
}

function normalizeEmail(value) {
  try {
    return normalizeRecoveryEmail(value);
  } catch {
    throw publicError("invalid_email", 400);
  }
}

function requireTrustedNetworkIdentity(context) {
  const identity = context?.trustedNetworkIdentity;
  if (typeof identity !== "string" || identity.trim() === "") {
    throw publicError("storage_unavailable", 503);
  }
  return identity.trim();
}

function nextSendAt(createdAt) {
  return new Date(new Date(createdAt).getTime() + SEND_COOLDOWN_MS).toISOString();
}

function isConflict(error) {
  return error?.code === "email_conflict";
}

export function createAccountEmailHandler({
  store,
  allowedOrigins = [],
  now = () => new Date(),
  createCode = createNumericCode,
  createRequestId = () => crypto.randomUUID(),
  tokenPepper,
  rateLimitPepper,
  verifyTurnstile,
  sendSecurityEmail,
  logger = () => {},
}) {
  async function digestCode(purpose, userId, code) {
    return digestSecret(`${purpose}:${userId}:${code}`, tokenPepper);
  }

  async function consumeSendLimits(
    purpose,
    userId,
    recipientEmail,
    trustedNetworkIdentity,
  ) {
    const buckets = [
      ["account", "account_cooldown", userId, 60, 1],
      ["email", "email_cooldown", recipientEmail, 60, 1],
      ["account", "account_daily", userId, 86400, 3],
      ["email", "email_daily", recipientEmail, 86400, 3],
      ["network", "network_daily", trustedNetworkIdentity, 86400, 20],
    ];
    const results = [];
    for (
      const [
        scope,
        bucket,
        value,
        windowSeconds,
        maxRequests,
      ] of buckets
    ) {
      const keyDigest = await digestSecret(
        scope + ":" + value,
        rateLimitPepper,
      );
      results.push(await store.consumeRateLimit({
        action: purpose + ":" + bucket,
        scope,
        keyDigest,
        windowSeconds,
        maxRequests,
      }));
    }
    if (results.some((allowed) => !allowed)) throw publicError("rate_limited", 429);
  }

  async function sendInsertedToken({
    userId,
    purpose,
    emailNormalized,
    nextEmailNormalized,
    code,
    requestId,
    currentTime,
  }, lifecycle = {}) {
    const tokenDigest = await digestCode(purpose, userId, code);
    const expiresAt = new Date(
      currentTime.getTime() + SECURITY_CODE_EXPIRES_MINUTES * 60_000,
    ).toISOString();
    const token = await store.insertToken({
      userId,
      purpose,
      tokenDigest,
      emailNormalized,
      nextEmailNormalized,
      expiresAt,
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    lifecycle.onTokenInserted?.(token);
    try {
      await sendSecurityEmail({
        to: purpose === "change_email_new" ? nextEmailNormalized : emailNormalized,
        purpose,
        code,
        expiresMinutes: SECURITY_CODE_EXPIRES_MINUTES,
        requestId,
      });
    } catch {
      try {
        await markTokenTerminal(token, currentTime, requestId);
      } catch (error) {
        lifecycle.onTokenTerminationFailed?.(token);
        throw error;
      }
      lifecycle.onTokenTerminated?.(token);
      throw publicError("delivery_failed", 502);
    }
    return token;
  }

  function logCompensationFailure(requestId) {
    logger({
      event: "account_email_compensation_failed",
      requestId,
      code: "storage_unavailable",
      status: 503,
    });
  }

  async function markTokenTerminal(token, currentTime, requestId) {
    try {
      const marked = await store.markTokenUsed({
        tokenId: token.id,
        usedAt: currentTime.toISOString(),
      });
      if (!marked) throw new Error("token termination CAS missed");
      return true;
    } catch {
      logCompensationFailure(requestId);
      throw publicError("storage_unavailable", 503);
    }
  }

  async function restoreConsumedToken(token, requestId) {
    try {
      const restored = await store.restoreConsumedToken({
        tokenId: token.id,
        consumedAttemptCount: token.attemptCount,
        consumedUsedAt: token.usedAt,
      });
      if (!restored) throw new Error("token restore CAS missed");
    } catch {
      logCompensationFailure(requestId);
      throw publicError("storage_unavailable", 503);
    }
  }

  async function compensateOldConfirmation(
    oldToken,
    newToken,
    newTokenTerminal,
    currentTime,
    requestId,
  ) {
    if (newToken && !newTokenTerminal) {
      await markTokenTerminal(newToken, currentTime, requestId);
    }
    await restoreConsumedToken(oldToken, requestId);
  }

  async function verifyCaptcha(token, requestId) {
    try {
      await verifyTurnstile(token, requestId);
    } catch {
      throw publicError("captcha_failed", 400);
    }
  }

  async function status(userId, currentTime) {
    const recovery = await store.getRecoveryEmail(userId);
    const token = await store.getLatestActiveToken({
      userId,
      purposes: ACTIVE_TOKEN_PURPOSES,
      now: currentTime.toISOString(),
    });
    if (token?.purpose === "bind_email" && !recovery) {
      return stateResponse(
        "pending",
        maskRecoveryEmail(token.emailNormalized),
        nextSendAt(token.createdAt),
      );
    }
    if (recovery && token?.purpose?.startsWith("change_email_")) {
      return stateResponse(
        "changing",
        maskRecoveryEmail(recovery.emailNormalized),
        nextSendAt(token.createdAt),
      );
    }
    if (recovery) {
      return stateResponse("verified", maskRecoveryEmail(recovery.emailNormalized), null);
    }
    return stateResponse("unbound", null, null);
  }

  async function requestBind(body, context, requestId, currentTime) {
    const userId = requireUser(context);
    const emailNormalized = normalizeEmail(body.email);
    await verifyCaptcha(body.captchaToken, requestId);
    await consumeSendLimits(
      "bind_email",
      userId,
      emailNormalized,
      requireTrustedNetworkIdentity(context),
    );
    if (await store.isEmailOwnedByAnother({ emailNormalized, userId })) {
      throw publicError("email_unavailable", 409);
    }
    const existingRecovery = await store.getRecoveryEmail(userId);
    if (existingRecovery?.verifiedAt) {
      throw publicError("recovery_email_already_verified", 409);
    }
    await store.invalidateUnusedTokens({
      userId,
      purposes: ["bind_email"],
      usedAt: currentTime.toISOString(),
    });
    const token = await sendInsertedToken({
      userId,
      purpose: "bind_email",
      emailNormalized,
      nextEmailNormalized: null,
      code: createCode(),
      requestId,
      currentTime,
    });
    return stateResponse(
      "pending",
      maskRecoveryEmail(emailNormalized),
      nextSendAt(token.createdAt ?? currentTime.toISOString()),
    );
  }

  async function verifyBind(body, context, requestId, currentTime) {
    const userId = requireUser(context);
    const code = requireCode(body.code);
    const token = await store.consumeToken({
      tokenDigest: await digestCode("bind_email", userId, code),
      purpose: "bind_email",
      userId,
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    if (!token?.emailNormalized) throw publicError("invalid_code", 400);
    try {
      await store.upsertRecoveryEmail({
        userId,
        emailNormalized: token.emailNormalized,
        verifiedAt: currentTime.toISOString(),
      });
    } catch (error) {
      await restoreConsumedToken(token, requestId);
      if (isConflict(error)) throw publicError("email_unavailable", 409);
      throw error;
    }
    return stateResponse("verified", maskRecoveryEmail(token.emailNormalized), null);
  }

  async function requestChange(body, context, requestId, currentTime) {
    const userId = requireUser(context);
    requireRecentLogin(context, currentTime);
    const recovery = await store.getRecoveryEmail(userId);
    if (!recovery?.verifiedAt) throw publicError("recovery_email_unverified", 409);
    const newEmail = normalizeEmail(body.newEmail);
    if (newEmail === recovery.emailNormalized) throw publicError("email_unavailable", 409);
    await verifyCaptcha(body.captchaToken, requestId);
    await consumeSendLimits(
      "change_email_old",
      userId,
      recovery.emailNormalized,
      requireTrustedNetworkIdentity(context),
    );
    if (await store.isEmailOwnedByAnother({ emailNormalized: newEmail, userId })) {
      throw publicError("email_unavailable", 409);
    }
    await store.invalidateUnusedTokens({
      userId,
      purposes: ["change_email_old", "change_email_new"],
      usedAt: currentTime.toISOString(),
    });
    const token = await sendInsertedToken({
      userId,
      purpose: "change_email_old",
      emailNormalized: recovery.emailNormalized,
      nextEmailNormalized: newEmail,
      code: createCode(),
      requestId,
      currentTime,
    });
    return stateResponse(
      "changing",
      maskRecoveryEmail(recovery.emailNormalized),
      nextSendAt(token.createdAt ?? currentTime.toISOString()),
    );
  }

  async function confirmChangeOld(body, context, requestId, currentTime) {
    const userId = requireUser(context);
    const code = requireCode(body.code);
    const token = await store.consumeToken({
      tokenDigest: await digestCode("change_email_old", userId, code),
      purpose: "change_email_old",
      userId,
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    if (!token?.emailNormalized || !token?.nextEmailNormalized) {
      throw publicError("invalid_code", 400);
    }
    let nextToken = null;
    let nextTokenTerminal = false;
    let nextTokenTerminationFailed = false;
    try {
      if (await store.isEmailOwnedByAnother({
        emailNormalized: token.nextEmailNormalized,
        userId,
      })) throw publicError("email_unavailable", 409);
      await consumeSendLimits(
        "change_email_new",
        userId,
        token.nextEmailNormalized,
        requireTrustedNetworkIdentity(context),
      );
      await store.invalidateUnusedTokens({
        userId,
        purposes: ["change_email_new"],
        usedAt: currentTime.toISOString(),
      });
      nextToken = await sendInsertedToken({
        userId,
        purpose: "change_email_new",
        emailNormalized: token.emailNormalized,
        nextEmailNormalized: token.nextEmailNormalized,
        code: createCode(),
        requestId,
        currentTime,
      }, {
        onTokenInserted(insertedToken) {
          nextToken = insertedToken;
        },
        onTokenTerminated() {
          nextTokenTerminal = true;
        },
        onTokenTerminationFailed() {
          nextTokenTerminationFailed = true;
        },
      });
      return stateResponse(
        "changing",
        maskRecoveryEmail(token.emailNormalized),
        nextSendAt(nextToken.createdAt ?? currentTime.toISOString()),
      );
    } catch (error) {
      if (nextTokenTerminationFailed) throw error;
      await compensateOldConfirmation(
        token,
        nextToken,
        nextTokenTerminal,
        currentTime,
        requestId,
      );
      throw error;
    }
  }

  async function confirmChangeNew(body, context, requestId, currentTime) {
    const userId = requireUser(context);
    const code = requireCode(body.code);
    const token = await store.consumeToken({
      tokenDigest: await digestCode("change_email_new", userId, code),
      purpose: "change_email_new",
      userId,
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    if (!token?.nextEmailNormalized) throw publicError("invalid_code", 400);
    try {
      if (await store.isEmailOwnedByAnother({
        emailNormalized: token.nextEmailNormalized,
        userId,
      })) throw publicError("email_unavailable", 409);
      await store.updateRecoveryEmail({
        userId,
        emailNormalized: token.nextEmailNormalized,
        verifiedAt: currentTime.toISOString(),
      });
    } catch (error) {
      await restoreConsumedToken(token, requestId);
      if (isConflict(error)) throw publicError("email_unavailable", 409);
      throw error;
    }
    return stateResponse(
      "verified",
      maskRecoveryEmail(token.nextEmailNormalized),
      null,
    );
  }

  return async function handleAccountEmail(request, context = {}) {
    const requestId = createRequestId();
    let headers = {};
    try {
      headers = corsHeaders(request.headers.get("origin"), allowedOrigins);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...headers, "x-request-id": requestId } });
      }
      if (request.method !== "POST") throw publicError("method_not_allowed", 405);
      requireUser(context);
      let body;
      try {
        body = await request.json();
      } catch {
        throw publicError("invalid_json", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw publicError("invalid_json", 400);
      }
      const currentTime = now();
      let result;
      switch (body.action) {
        case "status": {
          const userId = requireUser(context);
          result = await status(userId, currentTime);
          break;
        }
        case "request-bind":
          result = await requestBind(body, context, requestId, currentTime);
          break;
        case "verify-bind":
          result = await verifyBind(body, context, requestId, currentTime);
          break;
        case "request-change":
          result = await requestChange(body, context, requestId, currentTime);
          break;
        case "confirm-change-old":
          result = await confirmChangeOld(body, context, requestId, currentTime);
          break;
        case "confirm-change-new":
          result = await confirmChangeNew(body, context, requestId, currentTime);
          break;
        default:
          requireUser(context);
          throw publicError("unsupported_action", 400);
      }
      return jsonResponse(result, 200, requestId, headers);
    } catch (error) {
      const publicFailure = error instanceof PublicError
        ? error
        : error?.code === "storage_unavailable"
        ? publicError("storage_unavailable", 503)
        : publicError("internal_error", 500);
      logger({
        event: "account_email_request_failed",
        requestId,
        code: publicFailure.code,
        status: publicFailure.status,
      });
      return jsonResponse({
        error: {
          code: publicFailure.code,
          message: publicFailure.message,
          requestId,
        },
      }, publicFailure.status, requestId, headers);
    }
  };
}
