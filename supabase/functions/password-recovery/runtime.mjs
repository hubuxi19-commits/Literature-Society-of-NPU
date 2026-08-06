import { createAccountStore } from "../_shared/account-store.ts";
import {
  buildAdminClientOptions,
  parseSupabaseSecretKeys,
} from "../_shared/clients-core.mjs";
import { createPasswordRecoveryHandler } from "./logic.mjs";

function storeUnavailable() {
  return Object.assign(new Error("服务暂时不可用"), {
    code: "storage_unavailable",
  });
}

export function buildFindUserByInternalEmail(adminClient) {
  return async function findUserByInternalEmail(internalEmail) {
    let page = 1;
    for (;;) {
      const { data, error } = await adminClient.auth.admin.listUsers({
        page,
        perPage: 200,
      });
      if (error) throw storeUnavailable();
      const users = data?.users ?? [];
      const match = users.find((user) => user.email === internalEmail);
      if (match) return { userId: match.id };
      if (users.length < 200) return null;
      page += 1;
    }
  };
}

export function buildUpdateUserPassword(adminClient) {
  return async function updateUserPassword(userId, newPassword) {
    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) throw storeUnavailable();
  };
}

export function createPasswordRecoveryProductionHandler({
  createClientImpl,
  envGet,
  allowedOrigins,
  tokenPepper,
  rateLimitPepper,
  verifyTurnstile,
  sendSecurityEmail,
  logger,
  now = () => new Date(),
  createRequestId = () => crypto.randomUUID(),
}) {
  const supabaseUrl = envGet("SUPABASE_URL")?.trim();
  const secretKeys = parseSupabaseSecretKeys(envGet("SUPABASE_SECRET_KEYS"));
  if (!supabaseUrl) throw new Error("服务配置不完整");
  const adminClient = createClientImpl(
    supabaseUrl,
    secretKeys.default,
    buildAdminClientOptions(),
  );
  return createPasswordRecoveryHandler({
    store: createAccountStore(adminClient),
    allowedOrigins,
    now,
    createRequestId,
    tokenPepper,
    rateLimitPepper,
    verifyTurnstile,
    sendSecurityEmail,
    logger,
    findUserByInternalEmail: buildFindUserByInternalEmail(adminClient),
    updateUserPassword: buildUpdateUserPassword(adminClient),
  });
}
