const localHostnames = new Set(["127.0.0.1", "localhost"]);

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
    return productionConfig;
  }
}