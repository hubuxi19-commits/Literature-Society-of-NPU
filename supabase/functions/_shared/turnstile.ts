const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_FAILURE_MESSAGE = "人机验证失败，请刷新后重试";

export async function verifyTurnstile(
  token: string,
  idempotencyKey: string,
): Promise<void> {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("请完成人机验证");
  }
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY")?.trim();
  if (!secret) throw new Error("验证码服务尚未配置");
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw new Error(TURNSTILE_FAILURE_MESSAGE);
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token.trim(),
        idempotency_key: idempotencyKey,
      }),
    });
    const result = await response.json();
    if (!response.ok || result?.success !== true) {
      throw new Error(TURNSTILE_FAILURE_MESSAGE);
    }
  } catch {
    throw new Error(TURNSTILE_FAILURE_MESSAGE);
  }
}
