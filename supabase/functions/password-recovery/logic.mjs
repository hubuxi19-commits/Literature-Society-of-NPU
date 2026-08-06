import {
  createNumericCode,
  digestSecret,
  SECURITY_CODE_EXPIRES_MINUTES,
  SECURITY_CODE_MAX_ATTEMPTS,
  studentNumberToInternalEmail,
  validatePassword,
  validateStudentNumber,
} from "../_shared/security-core.mjs";

const RESET_PASSWORD_PURPOSE = "reset_password";
const FIXED_REQUEST_MESSAGE = "如果账号存在且已绑定邮箱，我们已发送验证码。";
const COMPLETE_MESSAGE = "密码已更新，请使用新密码登录。";

const PUBLIC_MESSAGES = Object.freeze({
  invalid_student_number: "学号格式不正确",
  invalid_password: "密码必须同时包含字母和数字且不少于八位",
  invalid_code: "验证码无效或已过期",
  invalid_json: "请求内容格式不正确",
  unsupported_action: "不支持的操作",
  method_not_allowed: "请求方法不受支持",
  origin_not_allowed: "请求来源不受信任",
  rate_limited: "操作过于频繁，请稍后重试",
  captcha_failed: "人机验证失败，请刷新后重试",
  password_update_failed: "密码暂时无法更新，请重新申请验证码",
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

function requireCode(value) {
  const code = String(value ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw publicError("invalid_code", 400);
  return code;
}

function requireTrustedNetworkIdentity(context) {
  const identity = context?.trustedNetworkIdentity;
  if (typeof identity !== "string" || identity.trim() === "") {
    throw publicError("storage_unavailable", 503);
  }
  return identity.trim();
}

function fixedRequestResponse() {
  return { ok: true, message: FIXED_REQUEST_MESSAGE };
}

export function createPasswordRecoveryHandler({
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
  findUserByInternalEmail,
  updateUserPassword,
}) {
  async function digestCode(userId, code) {
    return digestSecret(`${RESET_PASSWORD_PURPOSE}:${userId}:${code}`, tokenPepper);
  }

  async function consumePasswordLimits(studentNumber, trustedNetworkIdentity) {
    const buckets = [
      ["student", "student_cooldown", studentNumber, 60, 1],
      ["student", "student_daily", studentNumber, 86400, 3],
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
        action: RESET_PASSWORD_PURPOSE + ":" + bucket,
        scope,
        keyDigest,
        windowSeconds,
        maxRequests,
      }));
    }
    if (results.some((allowed) => !allowed)) throw publicError("rate_limited", 429);
  }

  async function verifyCaptcha(token, requestId) {
    try {
      await verifyTurnstile(token, requestId);
    } catch {
      throw publicError("captcha_failed", 400);
    }
  }

  function logCompensationFailure(requestId) {
    logger({
      event: "password_recovery_compensation_failed",
      requestId,
      code: "storage_unavailable",
      status: 503,
    });
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

  async function requestRecovery(body, context, requestId, currentTime) {
    const studentNumber = String(body.studentNumber ?? "").trim();
    if (!validateStudentNumber(studentNumber)) {
      throw publicError("invalid_student_number", 400);
    }
    await verifyCaptcha(body.captchaToken, requestId);
    await consumePasswordLimits(
      studentNumber,
      requireTrustedNetworkIdentity(context),
    );
    const user = await findUserByInternalEmail(
      studentNumberToInternalEmail(studentNumber),
    );
    if (!user) return fixedRequestResponse();
    const recovery = await store.getRecoveryEmail(user.userId);
    if (!recovery?.verifiedAt) return fixedRequestResponse();
    const code = createCode();
    const token = await store.insertToken({
      userId: user.userId,
      purpose: RESET_PASSWORD_PURPOSE,
      tokenDigest: await digestCode(user.userId, code),
      emailNormalized: recovery.emailNormalized,
      nextEmailNormalized: null,
      expiresAt: new Date(
        currentTime.getTime() + SECURITY_CODE_EXPIRES_MINUTES * 60_000,
      ).toISOString(),
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    try {
      await sendSecurityEmail({
        to: recovery.emailNormalized,
        purpose: RESET_PASSWORD_PURPOSE,
        code,
        expiresMinutes: SECURITY_CODE_EXPIRES_MINUTES,
        requestId,
      });
    } catch {
      try {
        await store.markTokenUsed({
          tokenId: token.id,
          usedAt: currentTime.toISOString(),
        });
      } catch {
        logCompensationFailure(requestId);
      }
      logger({
        event: "password_recovery_delivery_failed",
        requestId,
        code: "delivery_failed",
        status: 502,
      });
    }
    return fixedRequestResponse();
  }

  async function completeRecovery(body, context, requestId) {
    const studentNumber = String(body.studentNumber ?? "").trim();
    if (!validateStudentNumber(studentNumber)) {
      throw publicError("invalid_student_number", 400);
    }
    if (!validatePassword(body.newPassword)) {
      throw publicError("invalid_password", 400);
    }
    const code = requireCode(body.code);
    await verifyCaptcha(body.captchaToken, requestId);
    await consumePasswordLimits(
      studentNumber,
      requireTrustedNetworkIdentity(context),
    );
    const user = await findUserByInternalEmail(
      studentNumberToInternalEmail(studentNumber),
    );
    if (!user) throw publicError("invalid_code", 400);
    const token = await store.consumeToken({
      tokenDigest: await digestCode(user.userId, code),
      purpose: RESET_PASSWORD_PURPOSE,
      userId: user.userId,
      maxAttempts: SECURITY_CODE_MAX_ATTEMPTS,
    });
    if (!token) throw publicError("invalid_code", 400);
    try {
      await updateUserPassword(user.userId, body.newPassword);
    } catch {
      await restoreConsumedToken(token, requestId);
      throw publicError("password_update_failed", 502);
    }
    return { ok: true, message: COMPLETE_MESSAGE };
  }

  return async function handlePasswordRecovery(request, context = {}) {
    const requestId = createRequestId();
    let headers = {};
    try {
      headers = corsHeaders(request.headers.get("origin"), allowedOrigins);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...headers, "x-request-id": requestId },
        });
      }
      if (request.method !== "POST") throw publicError("method_not_allowed", 405);
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
        case "request":
          result = await requestRecovery(body, context, requestId, currentTime);
          break;
        case "complete":
          result = await completeRecovery(body, context, requestId);
          break;
        default:
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
        event: "password_recovery_request_failed",
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
