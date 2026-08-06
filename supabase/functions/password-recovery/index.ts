import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSecurityEmail } from "../_shared/brevo.ts";
import { createTrustedDenoServeHandler } from "../_shared/edge-runtime.mjs";
import {
  configuredAllowedOrigins,
  createSafeRequestLogger,
  requiredEnvironment,
} from "../_shared/http.ts";
import { verifyTurnstile } from "../_shared/turnstile.ts";
import { createPasswordRecoveryProductionHandler } from "./runtime.mjs";

const allowedOrigins = configuredAllowedOrigins();
const tokenPepper = requiredEnvironment("ACCOUNT_TOKEN_PEPPER");
const rateLimitPepper = requiredEnvironment("AUTH_RATE_LIMIT_PEPPER");
const logger = createSafeRequestLogger();

const handler = createPasswordRecoveryProductionHandler({
  createClientImpl: createClient,
  envGet: (name) => Deno.env.get(name),
  allowedOrigins,
  tokenPepper,
  rateLimitPepper,
  verifyTurnstile,
  sendSecurityEmail,
  logger,
});

Deno.serve(createTrustedDenoServeHandler(handler));
