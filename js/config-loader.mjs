const localHostnames = new Set(["127.0.0.1", "localhost"]);
const demoConfig = Object.freeze({
  mode: "demo",
  environment: "demo",
  supabaseUrl: "",
  supabasePublishableKey: "",
  turnstileSiteKey: "",
});

export async function loadConfig({
  hostname,
  productionConfig,
  loadLocalConfig,
}) {
  if (!localHostnames.has(hostname)) return productionConfig;

  try {
    const localModule = await loadLocalConfig();
    return Object.freeze({ ...localModule.config, environment: "staging" });
  } catch {
    return demoConfig;
  }
}
