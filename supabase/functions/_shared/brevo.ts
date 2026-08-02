import {
  buildSecurityEmail,
  normalizeRecoveryEmail,
} from "./security-core.mjs";

const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const EMAIL_FAILURE_MESSAGE = "安全邮件发送失败，请稍后重试";

type SecurityEmailPurpose =
  | "bind_email"
  | "change_email_old"
  | "change_email_new"
  | "reset_password";

type SecurityEmailRequest = {
  to: string;
  purpose: SecurityEmailPurpose;
  code: string;
  expiresMinutes: number;
  requestId: string;
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("邮件服务尚未配置");
  return value;
}

export async function sendSecurityEmail({
  to,
  purpose,
  code,
  expiresMinutes,
  requestId,
}: SecurityEmailRequest): Promise<{ messageId: string }> {
  const apiKey = requiredEnv("BREVO_API_KEY");
  const senderName = requiredEnv("BREVO_SENDER_NAME");
  const senderEmail = requiredEnv("BREVO_SENDER_EMAIL");
  const normalizedRecipient = normalizeRecoveryEmail(to);
  const { subject, textContent } = buildSecurityEmail(
    purpose,
    code,
    expiresMinutes,
  );
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new Error(EMAIL_FAILURE_MESSAGE);
  }

  try {
    const response = await fetch(BREVO_EMAIL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: normalizedRecipient }],
        subject,
        textContent,
        tags: ["account-security"],
      }),
    });
    if (!response.ok) throw new Error(EMAIL_FAILURE_MESSAGE);
    const result = await response.json();
    const messageId = typeof result?.messageId === "string"
      ? result.messageId.trim()
      : "";
    if (!messageId) {
      throw new Error(EMAIL_FAILURE_MESSAGE);
    }
    return { messageId };
  } catch {
    throw new Error(EMAIL_FAILURE_MESSAGE);
  }
}
