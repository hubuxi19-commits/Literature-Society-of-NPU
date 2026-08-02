import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildAdminClientOptions,
  buildUserClientOptions,
  parseSupabaseSecretKeys,
} from "./clients-core.mjs";
import { requiredEnvironment } from "./http.ts";

type SupabaseAuthMode = "user";

type SupabaseContext = {
  userClaims?: Record<string, unknown> | null;
  userClient?: ReturnType<typeof createClient>;
  adminClient?: ReturnType<typeof createClient>;
  authFailure?: "internal";
};

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

async function createRequestClients(request: Request) {
  const jwt = bearerToken(request);
  if (!jwt) return null;
  const supabaseUrl = requiredEnvironment("SUPABASE_URL");
  const publishableKey = (
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ??
    ""
  ).trim();
  if (!publishableKey) throw new Error("服务配置不完整");
  const secretKeys = parseSupabaseSecretKeys(
    requiredEnvironment("SUPABASE_SECRET_KEYS"),
  );
  const userClient = createClient(
    supabaseUrl,
    publishableKey,
    buildUserClientOptions({ jwt, publishableKey }),
  );
  const adminClient = createClient(
    supabaseUrl,
    secretKeys.default,
    buildAdminClientOptions(),
  );
  const { data, error } = await userClient.auth.getClaims(jwt);
  if (error || !data?.claims?.sub) return null;
  return { userClaims: data.claims, userClient, adminClient };
}

export function withSupabase(
  options: { auth: SupabaseAuthMode },
  handler: (request: Request, context: SupabaseContext) => Promise<Response>,
) {
  if (options.auth !== "user") throw new Error("不支持的认证模式");
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return handler(request, {});
    try {
      const context = await createRequestClients(request);
      return handler(request, context ?? {});
    } catch {
      return handler(request, { authFailure: "internal" });
    }
  };
}
