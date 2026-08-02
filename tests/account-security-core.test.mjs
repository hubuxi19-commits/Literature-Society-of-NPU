import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSecurityEmail,
  createNumericCode,
  digestSecret,
  maskRecoveryEmail,
  normalizeRecoveryEmail,
} from "../supabase/functions/_shared/security-core.mjs";
import { verifyTurnstile } from "../supabase/functions/_shared/turnstile.ts";
import { sendSecurityEmail } from "../supabase/functions/_shared/brevo.ts";

async function withEdgeRuntime({ env = {}, fetchImpl }, operation) {
  const hadDeno = Object.hasOwn(globalThis, "Deno");
  const previousDeno = globalThis.Deno;
  const previousFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: (name) => env[name] } };
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    if (hadDeno) globalThis.Deno = previousDeno;
    else delete globalThis.Deno;
    globalThis.fetch = previousFetch;
  }
}

test("邮箱规范化并以固定遮罩隐藏完整地址", () => {
  assert.equal(
    normalizeRecoveryEmail("  Reader@Example.COM "),
    "reader@example.com",
  );
  assert.equal(maskRecoveryEmail("reader@example.com"), "r***r@e***e.com");
  assert.doesNotMatch(
    maskRecoveryEmail("reader@example.com"),
    /reader@example\.com/,
  );
  assert.throws(() => normalizeRecoveryEmail("not-an-email"), /邮箱格式/);
});

test("验证码生成器把随机值格式化为严格六位数字", () => {
  const code = createNumericCode((values) => {
    values[0] = 42;
    return values;
  });

  assert.equal(code, "000042");
  assert.match(code, /^\d{6}$/);
});

test("摘要使用 HMAC-SHA-256 固定向量并受 pepper 隔离", async () => {
  const left = await digestSecret("2023123456", "pepper-a");

  assert.equal(
    left,
    "47c03cc92815a274d1a318fa2289d8505c64145d9484a07c5c38885b39cb7c6a",
  );
  assert.equal(left, await digestSecret("2023123456", "pepper-a"));
  assert.notEqual(left, await digestSecret("2023123456", "pepper-b"));
});

test("摘要拒绝空 pepper，避免低熵秘密失去服务端保护", async () => {
  await assert.rejects(
    digestSecret("123456", "   "),
    /pepper.*配置|摘要服务尚未配置/,
  );
});

test("安全邮件只输出用途、六位验证码、有效期和安全提示", () => {
  const email = buildSecurityEmail("reset_password", "123456", 10);
  const completeMessage = `${email.subject}\n${email.textContent}`;

  assert.deepEqual(Object.keys(email).sort(), ["subject", "textContent"]);
  assert.match(email.subject, /密码/);
  assert.match(email.textContent, /重置密码/);
  assert.match(email.textContent, /123456/);
  assert.match(email.textContent, /10\s*分钟/);
  assert.match(email.textContent, /请勿.*透露|不要.*透露/);
  assert.doesNotMatch(completeMessage, /学号|笔名|作品|评论|关注|收藏/);
});

test("安全邮件拒绝非六位验证码和未知用途", () => {
  assert.throws(
    () => buildSecurityEmail("reset_password", "12345", 10),
    /六位数字/,
  );
  assert.throws(
    () => buildSecurityEmail("community_profile", "123456", 10),
    /用途/,
  );
});

test("Turnstile 拒绝空 token 且不向验证服务发请求", async () => {
  let requested = false;
  await withEdgeRuntime({
    env: { TURNSTILE_SECRET_KEY: "fake-turnstile-secret" },
    fetchImpl: async () => {
      requested = true;
      return new Response('{"success":true}');
    },
  }, async () => {
    await assert.rejects(
      verifyTurnstile("   ", "request-empty-token"),
      { message: "请完成人机验证" },
    );
  });
  assert.equal(requested, false);
});

test("Turnstile 服务端 secret 缺失时拒绝验证且不发请求", async () => {
  let requested = false;
  await withEdgeRuntime({
    fetchImpl: async () => {
      requested = true;
      return new Response('{"success":true}');
    },
  }, async () => {
    await assert.rejects(
      verifyTurnstile("captcha-token", "request-missing-config"),
      { message: "验证码服务尚未配置" },
    );
  });
  assert.equal(requested, false);
});

test("Turnstile 向固定端点提交 secret、token 和幂等键", async () => {
  let request;
  await withEdgeRuntime({
    env: { TURNSTILE_SECRET_KEY: "fake-turnstile-secret" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{"success":true,"challenge_ts":"2026-08-02T00:00:00Z"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  }, () => verifyTurnstile("captcha-token", "request-123"));

  assert.equal(
    request.url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
  assert.equal(request.options.method, "POST");
  assert.deepEqual(request.options.headers, {
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.options.body), {
    secret: "fake-turnstile-secret",
    response: "captcha-token",
    idempotency_key: "request-123",
  });
});

test("Turnstile 将网络、JSON 与服务拒绝统一为不泄露的公开错误", async () => {
  const privateDetails = "provider-private-body";
  const failures = [
    async () => {
      throw new Error(privateDetails);
    },
    async () => new Response(privateDetails, { status: 502 }),
    async () => new Response(`{"success":false,"detail":"${privateDetails}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];

  for (const fetchImpl of failures) {
    await withEdgeRuntime({
      env: { TURNSTILE_SECRET_KEY: "fake-turnstile-secret" },
      fetchImpl,
    }, async () => {
      await assert.rejects(
        verifyTurnstile("captcha-token", "request-failure"),
        (error) => {
          assert.equal(error.message, "人机验证失败，请刷新后重试");
          assert.doesNotMatch(error.message, new RegExp(privateDetails));
          return true;
        },
      );
    });
  }
});

test("Brevo 发送纯文本账号安全邮件并只返回 messageId", async () => {
  let request;
  const result = await withEdgeRuntime({
    env: {
      BREVO_API_KEY: "fake-brevo-api-key",
      BREVO_SENDER_NAME: "文苑安全中心",
      BREVO_SENDER_EMAIL: "security@example.invalid",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{"messageId":"message-123"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  }, () => sendSecurityEmail({
    to: " Reader@Example.COM ",
    purpose: "reset_password",
    code: "123456",
    expiresMinutes: 10,
    requestId: "request-456",
  }));

  assert.deepEqual(result, { messageId: "message-123" });
  assert.equal(request.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(request.options.headers, {
    accept: "application/json",
    "content-type": "application/json",
    "api-key": "fake-brevo-api-key",
    "Idempotency-Key": "request-456",
  });
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload, {
    sender: {
      name: "文苑安全中心",
      email: "security@example.invalid",
    },
    to: [{ email: "reader@example.com" }],
    subject: "文苑社区｜重置密码验证码",
    textContent: [
      "用途：重置密码",
      "验证码：123456",
      "有效期：10 分钟",
      "请勿向任何人透露此验证码。如非本人操作，请忽略此邮件。",
    ].join("\n"),
    tags: ["account-security"],
  });
  assert.equal(Object.hasOwn(payload, "htmlContent"), false);
  assert.doesNotMatch(JSON.stringify(payload), /学号|笔名|作品|评论|关注|收藏/);
});

test("Brevo 配置缺失时拒绝发送且不发请求", async () => {
  let requested = false;
  await withEdgeRuntime({
    fetchImpl: async () => {
      requested = true;
      return new Response('{"messageId":"unexpected"}');
    },
  }, async () => {
    await assert.rejects(
      sendSecurityEmail({
        to: "reader@example.com",
        purpose: "reset_password",
        code: "123456",
        expiresMinutes: 10,
        requestId: "request-missing-config",
      }),
      { message: "邮件服务尚未配置" },
    );
  });
  assert.equal(requested, false);
});

test("Brevo 失败不记录或返回收件人、验证码与 provider body", async () => {
  const emittedLogs = [];
  const previousConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => emittedLogs.push(["log", ...args]);
  console.warn = (...args) => emittedLogs.push(["warn", ...args]);
  console.error = (...args) => emittedLogs.push(["error", ...args]);
  try {
    const failures = [
      async () => {
        throw new Error("provider-network-detail");
      },
      async () => new Response("provider-invalid-json", { status: 201 }),
      async () => new Response(
        '{"message":"reader@example.com code 123456 fake-brevo-api-key"}',
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ];
    for (const fetchImpl of failures) {
      await withEdgeRuntime({
        env: {
          BREVO_API_KEY: "fake-brevo-api-key",
          BREVO_SENDER_NAME: "文苑安全中心",
          BREVO_SENDER_EMAIL: "security@example.invalid",
        },
        fetchImpl,
      }, async () => {
        await assert.rejects(
          sendSecurityEmail({
            to: "reader@example.com",
            purpose: "reset_password",
            code: "123456",
            expiresMinutes: 10,
            requestId: "request-failure",
          }),
          (error) => {
            assert.equal(error.message, "安全邮件发送失败，请稍后重试");
            assert.doesNotMatch(
              error.message,
              /reader@example\.com|123456|fake-brevo-api-key|provider/,
            );
            return true;
          },
        );
      });
    }
  } finally {
    console.log = previousConsole.log;
    console.warn = previousConsole.warn;
    console.error = previousConsole.error;
  }
  assert.deepEqual(emittedLogs, []);
});
