import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../js/config-loader.mjs";

const productionConfig = Object.freeze({
  mode: "supabase",
  environment: "production",
  supabaseUrl: "https://production.example.test",
  supabasePublishableKey: "production-key",
  turnstileSiteKey: "",
});

test("生产主机不会加载本地 Supabase 配置", async () => {
  let localLoadAttempts = 0;

  const config = await loadConfig({
    hostname: "community.example.edu",
    productionConfig,
    loadLocalConfig: async () => {
      localLoadAttempts += 1;
      return {
        config: {
          mode: "supabase",
          supabaseUrl: "https://local.example.test",
          supabasePublishableKey: "local-key",
          turnstileSiteKey: "1x00000000000000000000AA",
        },
      };
    },
  });

  assert.equal(localLoadAttempts, 0);
  assert.equal(config, productionConfig);
  assert.equal(config.environment, "production");
});

test("localhost 加载本地 Supabase 配置并强制标记 staging", async () => {
  const config = await loadConfig({
    hostname: "localhost",
    productionConfig,
    loadLocalConfig: async () => ({
      config: {
        mode: "supabase",
        environment: "production",
        supabaseUrl: "https://local.example.test",
        supabasePublishableKey: "local-key",
        turnstileSiteKey: "1x00000000000000000000AA",
      },
    }),
  });

  assert.deepEqual(config, {
    mode: "supabase",
    environment: "staging",
    supabaseUrl: "https://local.example.test",
    supabasePublishableKey: "local-key",
    turnstileSiteKey: "1x00000000000000000000AA",
  });
  assert.ok(Object.isFrozen(config));
});

test("本地主机无法加载配置时降级到 demo 而不使用生产 Supabase", async () => {
  for (const hostname of ["localhost", "127.0.0.1"]) {
    const config = await loadConfig({
      hostname,
      productionConfig,
      loadLocalConfig: async () => {
        throw new SyntaxError("invalid local config");
      },
    });

    assert.deepEqual(config, {
      mode: "demo",
      environment: "demo",
      supabaseUrl: "",
      supabasePublishableKey: "",
      turnstileSiteKey: "",
    });
    assert.notEqual(config.supabaseUrl, productionConfig.supabaseUrl);
    assert.notEqual(
      config.supabasePublishableKey,
      productionConfig.supabasePublishableKey,
    );
  }
});
