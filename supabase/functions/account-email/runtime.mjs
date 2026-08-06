import { createAccountStore } from "../_shared/account-store.ts";
import { createSupabaseRequestClients } from "../_shared/clients-core.mjs";
import { createAccountEmailHandler } from "./logic.mjs";

export function createAccountEmailProductionHandler({
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
  return async function accountEmailProductionHandler(
    request,
    serverContext = {},
  ) {
    let authContext = {};
    if (request.method !== "OPTIONS") {
      try {
        authContext = await createSupabaseRequestClients({
          createClientImpl,
          envGet,
          request,
        }) ?? {};
      } catch {
        authContext = { authFailure: "internal" };
      }
    }
    const handler = createAccountEmailHandler({
      store: authContext.adminClient
        ? createAccountStore(authContext.adminClient)
        : {},
      allowedOrigins,
      tokenPepper,
      rateLimitPepper,
      verifyTurnstile,
      sendSecurityEmail,
      logger,
      now,
      createRequestId,
    });
    return handler(request, {
      userClaims: authContext.userClaims,
      authFailure: authContext.authFailure,
      trustedNetworkIdentity: serverContext.trustedNetworkIdentity,
    });
  };
}
