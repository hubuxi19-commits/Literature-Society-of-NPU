import { createClient } from "npm:@supabase/supabase-js@2";
import { createSupabaseRequestClients } from "./clients-core.mjs";

type SupabaseAuthMode = "user";

type SupabaseContext = {
  userClaims?: Record<string, unknown> | null;
  userClient?: ReturnType<typeof createClient>;
  adminClient?: ReturnType<typeof createClient>;
  authFailure?: "internal";
  trustedNetworkIdentity?: string;
};

export function withSupabase(
  options: { auth: SupabaseAuthMode },
  handler: (request: Request, context: SupabaseContext) => Promise<Response>,
) {
  if (options.auth !== "user") throw new Error("不支持的认证模式");
  return async (
    request: Request,
    serverContext: Pick<SupabaseContext, "trustedNetworkIdentity"> = {},
  ): Promise<Response> => {
    if (request.method === "OPTIONS") return handler(request, serverContext);
    try {
      const context = await createSupabaseRequestClients({
        createClientImpl: createClient,
        envGet: (name: string) => Deno.env.get(name),
        request,
      });
      return handler(request, { ...(context ?? {}), ...serverContext });
    } catch {
      return handler(request, { authFailure: "internal", ...serverContext });
    }
  };
}
