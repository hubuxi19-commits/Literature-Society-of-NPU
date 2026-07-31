import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMobileFeedQueue,
  createMobileFeedController,
  resolveHorizontalSwipe,
} from "../js/mobile-feed.mjs";

const works = [
  { id: "latest-featured", is_featured: true, created_at: "2026-07-31" },
  { id: "older-featured", is_featured: true, created_at: "2026-07-01" },
  { id: "a", is_featured: false, created_at: "2026-07-30" },
  { id: "b", is_featured: false, created_at: "2026-07-29" },
];

test("推荐作品按时间优先，其余作品随机且不重复", () => {
  const randomValues = [0.9, 0.1, 0.5];
  const queue = buildMobileFeedQueue(
    works,
    () => randomValues.shift() ?? 0.5,
  );
  assert.deepEqual(queue.slice(0, 2).map((work) => work.id), [
    "latest-featured",
    "older-featured",
  ]);
  assert.equal(new Set(queue.map((work) => work.id)).size, works.length);
});

test("历史控制器支持前进和返回且队列末尾不循环", () => {
  const controller = createMobileFeedController(works, () => 0.5);
  const first = controller.current().id;
  const second = controller.next().id;
  assert.notEqual(second, first);
  assert.equal(controller.previous().id, first);
  assert.equal(controller.next().id, second);
  let finalWork = controller.current();
  let candidate = controller.next();
  while (candidate) {
    finalWork = candidate;
    candidate = controller.next();
  }
  assert.equal(controller.next(), null);
  assert.equal(controller.current(), finalWork);
});

test("控制器不越过起点并可用新作品重置", () => {
  const controller = createMobileFeedController(works, () => 0.5);
  const first = controller.current();
  assert.equal(controller.previous(), first);
  controller.reset([{ id: "fresh", is_featured: false }], () => 0.2);
  assert.equal(controller.current().id, "fresh");
});

test("只有明确水平手势才切换作品", () => {
  assert.equal(resolveHorizontalSwipe(-80, 10), "next");
  assert.equal(resolveHorizontalSwipe(80, 10), "previous");
  assert.equal(resolveHorizontalSwipe(-40, 2), null);
  assert.equal(resolveHorizontalSwipe(-90, 120), null);
});
