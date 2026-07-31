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

test("移动首页使用独立队列、可访问卡片与被动触摸手势", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /from\s+"\.\/mobile-feed\.mjs"/);
  assert.match(app, /mobileFeed:\s*\{[\s\S]*?controller:\s*null/);
  assert.match(app, /function\s+renderMobileHome\s*\(/);
  assert.match(
    app,
    /mobileHomeMedia\.matches/,
  );
  assert.match(
    app,
    /const\s+mobileHomeMedia\s*=\s*window\.matchMedia\("\(max-width:\s*760px\)"\)/,
  );
  assert.equal(
    (app.match(/mobileHomeMedia\.addEventListener\(/g) ?? []).length,
    1,
  );
  assert.match(
    app,
    /mobileHomeMedia\.addEventListener\([\s\S]*?parseRoute\(window\.location\.hash\)[\s\S]*?route\.name\s*===\s*"home"[\s\S]*?renderHome\(\)/,
  );
  assert.match(app, /mobileWorkCard:\s*""/);
  assert.match(app, /tabindex:\s*"0"/);
  assert.match(app, /if\s*\(event\.target\s*!==\s*card\)\s*return/);
  assert.match(
    app,
    /addEventListener\(\s*"touchstart"[\s\S]*?passive:\s*true/,
  );
  assert.match(
    app,
    /addEventListener\(\s*"touchmove"[\s\S]*?passive:\s*true/,
  );
  assert.match(
    app,
    /addEventListener\(\s*"touchend"[\s\S]*?passive:\s*true/,
  );
  assert.match(app, /resolveHorizontalSwipe\(/);
  assert.match(app, /mobileFeed\.suppressClick\s*=\s*true/);
  assert.match(app, /requestAnimationFrame\(/);
  assert.match(app, /controller\.isAtStart\(\)/);
  assert.match(app, /controller\.isAtEnd\(\)/);
  assert.match(app, /"aria-disabled":\s*String\(/);
});

test("移动首页样式提供单卡纸页舞台并保留纵向滚动", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--mobile-nav-height:/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(
    css,
    /mobile-feed-stage[\s\S]*?min-height:\s*calc\(100svh\s*-\s*var\(--mobile-nav-height\)\)/,
  );
  assert.match(
    css,
    /mobile-work-card[\s\S]*?touch-action:\s*pan-y/,
  );
  assert.match(css, /mobile-work-copy--poetry[\s\S]*?white-space:\s*pre-wrap/);
  assert.match(css, /mobile-feed-control[\s\S]*?min-height:\s*44px/);
});

test("阅读页通过本地素笺模板生成 1080×1920 PNG", async () => {
  const [app, exporter, css] = await Promise.all([
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/image-export.mjs", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  const publicSource = `${app}\n${exporter}`;

  assert.match(app, /data(?:set)?:\s*\{\s*action:\s*"export-work"/);
  assert.match(app, /text:\s*"生成作品图片"/);
  assert.match(app, /currentExport:\s*null/);
  assert.match(app, /action:\s*"share-export"/);
  assert.match(app, /action:\s*"save-export"/);
  assert.match(app, /action:\s*"save-export-page"/);
  assert.match(
    app,
    /const\s+shareOperation\s*=\s*shareExportFiles\([^;]+\);\s*Promise\.resolve\(shareOperation\)/s,
  );
  assert.match(exporter, /student-literature-society-wordmark\.png/);
  assert.match(exporter, /canvas\.toBlob\(/);
  assert.match(app, /`保存第 \$\{pageIndex \+ 1\} 页`/);
  const exportWorkBody = exporter.match(
    /export\s+async\s+function\s+exportWorkImages[\s\S]+?\n}\n/,
  )?.[0] ?? "";
  assert.doesNotMatch(exportWorkBody, /\.share\s*\(/);
  assert.doesNotMatch(exportWorkBody, /\.click\s*\(/);
  assert.match(css, /\.export-page[\s\S]*?width:\s*1080px/);
  assert.match(css, /\.export-page[\s\S]*?height:\s*1920px/);
  assert.match(css, /\.export-wordmark[\s\S]*?width:\s*30%/);
  assert.match(css, /\.export-wordmark[\s\S]*?right:\s*64px/);
  assert.match(css, /\.export-wordmark[\s\S]*?bottom:\s*64px/);
  assert.doesNotMatch(publicSource, /service_role/i);
  assert.doesNotMatch(
    publicSource,
    /(?:openai|stability|replicate|midjourney|image[-_ ]?generation)[^\n]{0,80}(?:api|endpoint|fetch)/i,
  );
});
