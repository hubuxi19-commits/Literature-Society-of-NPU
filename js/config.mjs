import { loadConfig } from "./config-loader.mjs";

const productionConfig = Object.freeze({
  mode: "supabase",
  environment: "production",
  supabaseUrl: "https://odfjxtzgekhiaktzaxas.supabase.co",
  supabasePublishableKey: "sb_publishable_JGnMQuwRNV6pTIzUORyqSg_PB-zGT0-",
  turnstileSiteKey: "0x4AAAAAAEH7aHbJJOgShIHC",
});

export const config = await loadConfig({
  hostname: globalThis.location?.hostname,
  productionConfig,
  loadLocalConfig: () => import("./config.local.mjs"),
});