import test from "node:test";
import assert from "node:assert/strict";

import { createRouteCache } from "../js/route-cache.mjs";

test("returns a cached value while it is fresh", () => {
  let currentTime = 1_000;
  const cache = createRouteCache({ ttlMs: 500, now: () => currentTime });

  cache.set("work:1", { title: "春雪" });
  currentTime = 1_499;

  assert.deepEqual(cache.get("work:1"), { title: "春雪" });
});

test("drops a cached value after its ttl", () => {
  let currentTime = 2_000;
  const cache = createRouteCache({ ttlMs: 500, now: () => currentTime });

  cache.set("author:1", { pen_name: "无名" });
  currentTime = 2_501;

  assert.equal(cache.get("author:1"), undefined);
});

test("evicts the least recently used entry when full", () => {
  const cache = createRouteCache({ maxEntries: 2, ttlMs: 5_000 });

  cache.set("work:1", 1);
  cache.set("work:2", 2);
  assert.equal(cache.get("work:1"), 1);
  cache.set("work:3", 3);

  assert.equal(cache.get("work:2"), undefined);
  assert.equal(cache.get("work:1"), 1);
  assert.equal(cache.get("work:3"), 3);
});
