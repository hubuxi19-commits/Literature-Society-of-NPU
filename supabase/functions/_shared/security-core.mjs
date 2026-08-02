const PURPOSE_LABELS = Object.freeze({
  bind_email: "验证找回邮箱",
  change_email_old: "验证原找回邮箱",
  change_email_new: "验证新找回邮箱",
  reset_password: "重置密码",
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RANDOM_VALUE = 0x1_0000_0000;
const CODE_SPACE = 1_000_000;
const UNBIASED_RANDOM_LIMIT = Math.floor(MAX_RANDOM_VALUE / CODE_SPACE) * CODE_SPACE;

export const SECURITY_CODE_EXPIRES_MINUTES = 10;
export const SECURITY_CODE_MAX_ATTEMPTS = 5;

export function normalizeRecoveryEmail(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw new Error("找回邮箱格式不正确");
  }
  return normalized;
}

function maskPart(value) {
  if (value.length < 3) return `${value.slice(0, 1)}***`;
  return `${value[0]}***${value.at(-1)}`;
}

export function maskRecoveryEmail(value) {
  const normalized = normalizeRecoveryEmail(value);
  const [localPart, domain] = normalized.split("@");
  const labels = domain.split(".");
  const topLevelDomain = labels.pop();
  const maskedDomain = labels.map(maskPart).join(".");
  return `${maskPart(localPart)}@${maskedDomain}.${topLevelDomain}`;
}

export function createNumericCode(
  randomBytes = (values) => crypto.getRandomValues(values),
) {
  const values = new Uint32Array(1);
  do {
    randomBytes(values);
  } while (values[0] >= UNBIASED_RANDOM_LIMIT);
  return String(values[0] % CODE_SPACE).padStart(6, "0");
}

export async function digestSecret(value, pepper) {
  if (typeof pepper !== "string" || pepper.trim() === "") {
    throw new Error("摘要服务尚未配置");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(String(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function buildSecurityEmail(purpose, code, expiresMinutes) {
  const purposeLabel = PURPOSE_LABELS[purpose];
  if (!purposeLabel) throw new Error("不支持的安全邮件用途");
  if (!/^\d{6}$/.test(String(code))) {
    throw new Error("验证码必须是六位数字");
  }
  if (!Number.isInteger(expiresMinutes) || expiresMinutes <= 0) {
    throw new Error("验证码有效期不正确");
  }

  return {
    subject: `文苑社区｜${purposeLabel}验证码`,
    textContent: [
      `用途：${purposeLabel}`,
      `验证码：${code}`,
      `有效期：${expiresMinutes} 分钟`,
      "请勿向任何人透露此验证码。如非本人操作，请忽略此邮件。",
    ].join("\n"),
  };
}
