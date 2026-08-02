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
