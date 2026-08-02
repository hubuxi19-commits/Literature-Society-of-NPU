export function configuredAllowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("服务配置不完整");
  return value;
}

export function createSafeRequestLogger() {
  return (entry: {
    event: string;
    requestId: string;
    code: string;
    status: number;
  }) => {
    console.error(JSON.stringify({
      event: entry.event,
      requestId: entry.requestId,
      code: entry.code,
      status: entry.status,
    }));
  };
}
