import { createAccountStore } from "../_shared/account-store.ts";
import { sendSecurityEmail } from "../_shared/brevo.ts";
import { withSupabase } from "../_shared/clients.ts";
import { createTrustedDenoServeHandler } from "../_shared/edge-runtime.mjs";
import {
  configuredAllowedOrigins,
  createSafeRequestLogger,
  requiredEnvironment,
} from "../_shared/http.ts";
import { verifyTurnstile } from "../_shared/turnstile.ts";
import { createAccountEmailHandler } from "./logic.mjs";

const allowedOrigins = configuredAllowedOrigins();
const tokenPepper = requiredEnvironment("ACCOUNT_TOKEN_PEPPER");
const rateLimitPepper = requiredEnvironment("AUTH_RATE_LIMIT_PEPPER");
const logger = createSafeRequestLogger();

const authenticatedHandler = withSupabase(
  { auth: "user" },
  async (request, context) => {
    const handler = createAccountEmailHandler({
      store: context.adminClient ? createAccountStore(context.adminClient) : {},
      allowedOrigins,
      tokenPepper,
      rateLimitPepper,
      verifyTurnstile,
      sendSecurityEmail,
      logger,
    });
    return handler(request, {
      userClaims: context.userClaims,
      authFailure: context.authFailure,
      trustedNetworkIdentity: context.trustedNetworkIdentity,
    });
  },
);

Deno.serve(createTrustedDenoServeHandler(authenticatedHandler));
