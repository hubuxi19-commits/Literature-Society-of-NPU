function configurationError() {
  return new Error("Supabase 客户端配置无效");
}

export function parseSupabaseSecretKeys(rawValue) {
  try {
    const parsed = JSON.parse(String(rawValue ?? ""));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof parsed.default !== "string" ||
      parsed.default.trim() === ""
    ) throw configurationError();
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.trim() !== "")
        .map(([name, value]) => [name, value.trim()]),
    );
  } catch (error) {
    if (error?.message === "Supabase 客户端配置无效") throw error;
    throw configurationError();
  }
}

export function buildUserClientOptions({ jwt, publishableKey }) {
  if (typeof jwt !== "string" || jwt.trim() === "") throw configurationError();
  if (typeof publishableKey !== "string" || publishableKey.trim() === "") {
    throw configurationError();
  }
  return {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${jwt.trim()}`,
        apikey: publishableKey.trim(),
      },
    },
  };
}

export function buildAdminClientOptions() {
  return {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  };
}

function requiredValue(envGet, name) {
  const value = envGet(name)?.trim();
  if (!value) throw configurationError();
  return value;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export async function createSupabaseRequestClients({
  createClientImpl,
  envGet,
  request,
}) {
  const jwt = bearerToken(request);
  if (!jwt) return null;
  const supabaseUrl = requiredValue(envGet, "SUPABASE_URL");
  const publishableKey = requiredValue(
    envGet,
    "SUPABASE_PUBLISHABLE_KEY",
  );
  const secretKeys = parseSupabaseSecretKeys(
    requiredValue(envGet, "SUPABASE_SECRET_KEYS"),
  );
  const userClient = createClientImpl(
    supabaseUrl,
    publishableKey,
    buildUserClientOptions({ jwt, publishableKey }),
  );
  const adminClient = createClientImpl(
    supabaseUrl,
    secretKeys.default,
    buildAdminClientOptions(),
  );
  const { data, error } = await userClient.auth.getClaims(jwt);
  if (error || !data?.claims?.sub) return null;
  return {
    userClaims: data.claims,
    userClient,
    adminClient,
  };
}
