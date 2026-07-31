import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("HTML 使用独立样式和模块脚本并包含可访问弹窗", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /assets\/styles\.css/);
  assert.match(html, /type="module" src="\.\/js\/app\.js"/);
  assert.match(html, /<dialog[^>]+id="authDialog"/);
  assert.match(html, /<dialog[^>]+id="confirmDialog"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /service_role/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
});

test("公开应用源码不包含完整学号的可见 HTML 文案", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, />\s*20\d{8}\s*</);
  assert.doesNotMatch(app, /service_role/i);
});

test("旧诗歌分类在公开作品信息中规范化显示", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /text:\s*normalizeCategory\(work\.category\)/);
  assert.match(app, /\$\{normalizeCategory\(work\.category\)\}/);
  assert.match(
    app,
    /normalizeCategory\(item\.category\)\s*===\s*normalizeCategory\(work\.category\)/,
  );
});

test("作者资料表单将笔名设为只读并仅保存简介", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /笔名由注册时确定，暂不支持修改。/);
  assert.match(app, /text:\s*"保存简介"/);
  assert.match(
    app,
    /service\.updateProfile\(form\.dataset\.profileId,\s*\{\s*bio:\s*data\.get\("bio"\),\s*\}\)/s,
  );
});

test("样式包含视觉令牌、键盘焦点、减少动效和移动端断点", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--paper:\s*#f3eee3/i);
  assert.match(css, /--vermilion:\s*#8c2f2b/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
});
