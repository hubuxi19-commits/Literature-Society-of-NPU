import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../supabase/schema.sql", import.meta.url);

test("HTML 使用独立样式和模块脚本并包含可访问弹窗", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /assets\/styles\.css/);
  assert.match(html, /type="module" src="\.\/js\/app\.js"/);
  assert.match(html, /<dialog[^>]+id="authDialog"/);
  assert.match(html, /<dialog[^>]+id="confirmDialog"/);
  assert.match(html, /<dialog[^>]+id="profileDialog"/);
  assert.match(html, /<dialog[^>]+id="annotateDialog"/);
  assert.match(html, /id="annotateForm"/);
  assert.match(html, /id="annotateQuoteText"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /service_role/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
});

test("移动端底部导航使用五个已批准入口", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const navigation = html.match(
    /<nav[^>]+class="mobile-bottom-nav"[\s\S]*?<\/nav>/,
  )?.[0];

  assert.ok(navigation, "缺少移动端底部导航");
  assert.deepEqual(
    // 取每个锚点首个文本节点（消息入口含未读角标 <span>，需在标签处截断）
    [...navigation.matchAll(/<a[^>]*>\s*([^<]+?)\s*(?:<\/a>|<)/g)].map(
      (match) => match[1].trim(),
    ),
    ["翻阅", "讨论", "写作", "消息", "我的"],
  );
  assert.match(navigation, /data-return-hash="__current-profile__"/);
  assert.match(navigation, /#\/notifications/);
});

test("登录返回目标可在会话建立后解析为当前用户主页", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");

  assert.match(app, /PROFILE_RETURN_SENTINEL\s*=\s*"__current-profile__"/);
  assert.match(app, /function\s+resolveAuthReturnHash\s*\(/);
  assert.match(
    app,
    /resolveAuthReturnHash\(state\.authReturnHash\)/,
  );
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

test("作者资料通过弹窗按冷却状态修改笔名和简介", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /function\s+openProfileEditor\s*\(/);
  assert.match(app, /action:\s*"open-profile-editor"/);
  assert.match(app, /action:\s*"close-profile-editor"/);
  assert.match(app, /name:\s*"penName"/);
  assert.match(app, /disabled:\s*!penNameAvailability\.canChange/);
  assert.match(app, /笔名每七天最多修改一次/);
  assert.match(app, /text:\s*"保存公开资料"/);
  assert.match(
    app,
    /service\.updateProfile\(form\.dataset\.profileId,\s*\{\s*penName:[\s\S]+?bio:\s*data\.get\("bio"\)/,
  );
  assert.match(css, /\.profile-dialog \.profile-form input\s*\{[\s\S]*?padding:\s*0\.2rem 0 0\.5rem/);
  assert.match(css, /\.profile-dialog \.profile-form textarea\s*\{[\s\S]*?border:\s*1px solid var\(--rule-light\)/);
  assert.match(css, /\.profile-dialog-actions\s*\{[\s\S]*?justify-content:\s*flex-end/);
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
  assert.match(app, /function\s+createMobileFilterBar\s*\(/);
  assert.match(app, /className:\s*"mobile-filter-bar"/);
  assert.match(app, /className:\s*"mobile-category-menu"/);
  assert.match(app, /placeholder:\s*"搜索作品"/);
  assert.match(app, /aria-checked/);
  assert.match(
    app,
    /target\.form\?\.classList\.contains\("mobile-filter-bar"\)[\s\S]*?return/,
  );
  assert.doesNotMatch(app, /function\s+createMobileCategoryStrip\s*\(/);
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
  assert.match(
    app,
    /addEventListener\(\s*"touchcancel"[\s\S]*?mobileFeed\.touch\s*=\s*null[\s\S]*?passive:\s*true/,
  );
  assert.match(app, /resolveHorizontalSwipe\(/);
  assert.match(app, /mobileFeed\.suppressClick\s*=\s*true/);
  assert.match(app, /SWIPE_CLICK_SUPPRESSION_MS/);
  assert.match(app, /function\s+clearMobileFeedClickSuppression\s*\(/);
  assert.match(app, /window\.setTimeout\([\s\S]*?SWIPE_CLICK_SUPPRESSION_MS/);
  assert.match(
    app,
    /if\s*\(state\.mobileFeed\.suppressClick\)[\s\S]*?clearMobileFeedClickSuppression\(\)/,
  );
  assert.match(
    app,
    /addEventListener\(\s*"touchstart"[\s\S]*?clearMobileFeedClickSuppression\(\)/,
  );
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
  assert.match(
    css,
    /\.mobile-feed-control:disabled\s*\{[\s\S]*?cursor:\s*not-allowed/,
  );
  assert.match(css, /\.mobile-feed-control:not\(:disabled\):hover/);
  assert.match(
    css,
    /\.mobile-filter-bar\s*\{[\s\S]*?grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/,
  );
  assert.match(css, /\.mobile-filter-bar[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.mobile-category-options[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.mobile-bottom-nav[\s\S]*?env\(safe-area-inset-bottom\)/);
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
  assert.match(app, /EXPORT_LAYOUT_KEY\s*=\s*"wenyuan-export-layout-v1"/);
  assert.match(app, /prepareExportPages\(/);
  assert.match(app, /exportDialog\.showModal\(\)/);
  assert.match(app, /exportWorkImages\(work,\s*\{\s*layout\s*\}\)/);
  assert.match(exporter, /DEFAULT_EXPORT_LAYOUT/);
  assert.match(exporter, /normalizeExportLayout/);
  assert.match(exporter, /prepareExportPages/);
  assert.match(css, /\.export-layout-dialog/);
  assert.match(css, /\.export-workbench/);
  assert.match(app, /currentExport:\s*null/);
  assert.match(app, /function\s+cleanupPreparedExport\s*\(/);
  assert.match(app, /URL\.revokeObjectURL\(/);
  assert.match(app, /className:\s*"export-preview-image"/);
  assert.match(app, /action:\s*"share-export"/);
  assert.match(app, /action:\s*"save-export"/);
  assert.match(app, /action:\s*"save-export-page"/);
  assert.match(
    app,
    /const\s+shareOperation\s*=\s*shareExportFiles\([^;]+\);\s*Promise\.resolve\(shareOperation\)/s,
  );
  assert.match(exporter, /student-literature-society-wordmark\.png/);
  assert.match(exporter, /canvas\.toBlob\(/);
  assert.match(exporter, /export-page--continuation/);
  assert.match(exporter, /showTitle:\s*false/);
  assert.match(app, /`保存第 \$\{pageIndex \+ 1\} 页`/);
  const exportWorkBody = exporter.match(
    /export\s+async\s+function\s+exportWorkImages[\s\S]+?\n}\n/,
  )?.[0] ?? "";
  assert.doesNotMatch(exportWorkBody, /\.share\s*\(/);
  assert.doesNotMatch(exportWorkBody, /\.click\s*\(/);
  assert.match(css, /\.export-page[\s\S]*?width:\s*1080px/);
  assert.match(css, /\.export-page[\s\S]*?height:\s*1920px/);
  assert.match(css, /\.export-page--continuation[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s*400px/);
  assert.match(css, /\.export-wordmark[\s\S]*?width:\s*30%/);
  assert.match(css, /\.export-wordmark[\s\S]*?right:\s*64px/);
  assert.match(css, /\.export-wordmark[\s\S]*?bottom:\s*64px/);
  assert.match(css, /\.export-preview-image[\s\S]*?aspect-ratio:\s*1080\s*\/\s*1920/);
  assert.doesNotMatch(publicSource, /service_role/i);
  assert.doesNotMatch(
    publicSource,
    /(?:openai|stability|replicate|midjourney|image[-_ ]?generation)[^\n]{0,80}(?:api|endpoint|fetch)/i,
  );
});

test("README 只保留当前功能分支的权威快进发布顺序", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.doesNotMatch(readme, /codex\/literature-community-redesign/);
  assert.doesNotMatch(readme, /--no-ff/);
  assert.equal(
    (readme.match(/git merge --ff-only codex\/wenyuan-community-upgrade/g) ?? []).length,
    1,
  );
});

test("浏览器检查保留预览断言但不写入内部导出预览截图", async () => {
  const browserCheck = await readFile(
    new URL("./browser-check.cjs", import.meta.url),
    "utf8",
  );

  assert.match(browserCheck, /\.export-preview-image/);
  assert.doesNotMatch(browserCheck, /exportPreviewScreenshot|export-preview\.png/);
});

test("浏览器检查固化私密社交 demo 全流程", async () => {
  const browserCheck = await readFile(
    new URL("./browser-check.cjs", import.meta.url),
    "utf8",
  );
  assert.match(browserCheck, /async function socialFlow/);
  assert.match(browserCheck, /#\/notifications/);
  assert.match(browserCheck, /comment-like-button/);
  assert.match(browserCheck, /member-list/);
  assert.match(browserCheck, /未读角标应为 2/);
});

test("账号安全页和找回密码表单不公开邮箱", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /data-action="open-password-recovery"/);
  assert.match(html, /name="recoveryEmail"/);
  assert.match(html, /邮箱仅用于账号验证与找回密码/);
  assert.match(html, /id="recoveryDialog"/);
  assert.match(app, /#\/account\/security/);
  assert.match(app, /requireVerifiedWrite/);
  assert.match(app, /renderAccountSecurity/);
  assert.match(app, /account-security/);
  assert.doesNotMatch(html, /accounts\.wenyuan\.invalid/);
});

test("顶部账号菜单提供账号安全入口", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const menu = html.match(/<div\s+class="account-menu"[\s\S]*?<\/div>/)?.[0];
  assert.ok(menu, "缺少顶部账号菜单");
  assert.match(menu, /href="#\/account\/security"/);
  assert.match(menu, />\s*账号安全\s*</);
});

test("账号安全与找回密码表单满足可访问性与视觉约束", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /\.account-security-meta[\s\S]*?font-size:\s*13px/);
  assert.match(css, /\.account-security-form input[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.account-security-form button[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.resend-button[\s\S]*?min-height:\s*44px/);
  assert.match(
    css,
    /@media \(max-width:\s*768px\)[\s\S]*?\.account-security-form[\s\S]*?font-size:\s*16px/,
  );
  assert.match(css, /\.recovery-dialog[\s\S]*?color:\s*var\(--ink\)/);
});

test("安全文档列出全部账号秘密并明确分级上线与批量上限", async () => {
  const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  for (const name of [
    "BREVO_API_KEY",
    "TURNSTILE_SECRET_KEY",
    "ACCOUNT_TOKEN_PEPPER",
    "AUTH_RATE_LIMIT_PEPPER",
  ]) {
    assert.match(security, new RegExp(name));
  }
  assert.doesNotMatch(security, /(?<![A-Z_])TOKEN_PEPPER/);
  assert.doesNotMatch(security, /(?<![A-Z_])RATE_LIMIT_PEPPER/);
  assert.match(security, /off.*warn.*enforce/s);
  assert.match(security, /每天最多 200/);
});

test("边缘函数环境示例只含秘密占位符且不留真实值", async () => {
  const envExample = await readFile(
    new URL("../supabase/functions/.env.example", import.meta.url),
    "utf8",
  );
  for (const name of [
    "ALLOWED_ORIGINS",
    "BREVO_SENDER_EMAIL",
    "BREVO_SENDER_NAME",
    "BREVO_API_KEY",
    "TURNSTILE_SECRET_KEY",
    "ACCOUNT_TOKEN_PEPPER",
    "AUTH_RATE_LIMIT_PEPPER",
  ]) {
    assert.match(envExample, new RegExp(`^${name}=`, "m"), `缺少 ${name} 占位`);
  }
  for (const name of [
    "BREVO_API_KEY",
    "TURNSTILE_SECRET_KEY",
    "ACCOUNT_TOKEN_PEPPER",
    "AUTH_RATE_LIMIT_PEPPER",
  ]) {
    assert.match(
      envExample,
      new RegExp(`^${name}=\\s*$`, "m"),
      `${name} 示例不允许填入真实值`,
    );
  }
  assert.doesNotMatch(envExample, /(?<![A-Z_])TOKEN_PEPPER/);
  assert.doesNotMatch(envExample, /(?<![A-Z_])RATE_LIMIT_PEPPER/);
});

test("首页实现分页浏览、搜索防抖与再读十篇", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /browse:\s*\{[\s\S]*?nextCursor:\s*null/);
  assert.match(app, /async\s+function\s+loadBrowseWorks\s*\(/);
  assert.match(app, /async\s+function\s+loadMoreWorks\s*\(/);
  assert.match(app, /requestId/);
  assert.match(app, /state\.browse\.nextCursor/);
  assert.match(app, /setTimeout\([\s\S]*?300\s*[,)]/);
  assert.match(app, /再读十篇/);
  assert.match(app, /service\.listWorksPage\(/);
});

test("讨论页使用独立分页而不是逐篇补查", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /listDiscussionsPage/);
  assert.match(app, /state\.discussions\s*=|browseDiscussions/);
  assert.match(app, /更多讨论/);
  const loadAllDiscussions = app.match(/async\s+function\s+loadAllDiscussions[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.doesNotMatch(loadAllDiscussions, /service\.getWork\s*\(/, "讨论页不得逐篇补查");
});

test("移动首页接近末尾时预取下一批", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /createMobileFeedController\([\s\S]*?state\.browse\.works/);
  assert.match(app, /isAtEnd\(\)|remaining/);
  assert.match(app, /loadMoreWorks\(\)/);
  assert.match(app, /append\(/);
  // 预取特性需真实存在，避免仅靠上述宽松断言形成同义反复。
  assert.match(app, /maybePrefetchMobileNext/);
  assert.match(app, /length\s*-\s*3/);
  assert.match(app, /controller\.append\(filtered\)/);
  assert.match(app, /state\.browse\.error/);
});

test("关键元信息字号不小于 13px 且移动表单不小于 16px", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  const metaRule = css.match(
    /\.discussion-meta,\s*\.work-meta,\s*\.profile-meta,\s*\.reading-meta\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(metaRule, /font-size:\s*13px/);
  const metaLinkRule = css.match(
    /\.meta-link\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(metaLinkRule, /font-size:\s*13px/);
  assert.match(
    css,
    /@media \(max-width:\s*768px\)[\s\S]*?\.filter-form\s*input[\s\S]*?font-size:\s*16px/,
  );
  assert.match(
    css,
    /\.load-more-row\s*\.primary-button\s*\{[\s\S]*?min-height:\s*44px/,
  );
});

test("版本与批注迁移新增两张表、六个 RPC 并收回作品直接写（含删除）", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260808_work_versions_and_quotes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.work_versions/i);
  assert.match(migration, /create table if not exists public\.comment_quotes/i);
  assert.match(migration, /current_version_id uuid references public\.work_versions/i);
  assert.match(migration, /revoke insert on table public\.works from authenticated/i);
  assert.match(migration, /revoke update on table public\.works from authenticated/i);
  assert.match(migration, /revoke delete on table public\.works from authenticated/i);
  assert.match(migration, /create or replace function public\.delete_work/);
  for (const fn of ["create_work_version", "restore_work_version", "create_quoted_comment", "list_work_versions", "list_work_quotes", "delete_work"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
  }
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
});

test("schema 的版本批注块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- VERSIONS_QUOTES_START/);
  assert.match(schema, /-- VERSIONS_QUOTES_END/);
  assert.match(schema, /create table if not exists public\.work_versions/i);
  assert.match(schema, /create table if not exists public\.comment_quotes/i);
});

test("schema 的社交通知块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- SOCIAL_NOTIFICATIONS_START/);
  assert.match(schema, /-- SOCIAL_NOTIFICATIONS_END/);
  assert.match(schema, /create table if not exists public\.follows/i);
  assert.match(schema, /create table if not exists public\.notifications/i);
});

test("schema 的治理块与迁移同时存在", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  assert.match(schema, /-- GOVERNANCE_ADMIN_START/);
  assert.match(schema, /-- GOVERNANCE_ADMIN_END/);
  assert.match(schema, /create table if not exists public\.reports/i);
  assert.match(schema, /create table if not exists public\.moderation_actions/i);
});

test("前端实现历史版本页、恢复入口与阅读页版本入口", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /renderWorkVersions/);
  assert.match(app, /route\.name === "versions"/);
  assert.match(app, /listWorkVersions\(/);
  assert.match(app, /restoreWorkVersion\(/);
  assert.match(app, /查看历史版本/);
  assert.match(app, /恢复此版本/);
  assert.match(app, /change_summary/);
});

test("写作台支持编辑既有作品并强制填写修改说明", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /renderWrite\(\s*\{[\s\S]*?workId/);
  assert.match(app, /name:\s*"changeSummary"/);
  assert.match(app, /createWorkVersion\(/);
  assert.match(app, /修改作品/);
  assert.match(app, /保存新版本/);
  assert.match(app, /当前为第\s*[\s\S]*?版|当前版本/);
});

test("作品页提供收藏与关注作者按钮，评论行提供点赞", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /service\.getWorkSocialCounts\(/);
  assert.match(app, /service\.getProfileSocialCounts\(/);
  assert.match(app, /service\.getCommentLikeState\(/);
  assert.match(app, /action:\s*"toggle-bookmark"/);
  assert.match(app, /action:\s*"toggle-follow-author"/);
  assert.match(app, /action:\s*"toggle-comment-like"/);
  assert.match(app, /handleBookmark\(/);
  assert.match(app, /handleFollowAuthor\(/);
  assert.match(app, /handleCommentLike\(/);
  assert.match(app, /已收藏/);
  assert.match(app, /已关注/);
  assert.match(app, /bookmarkLabel/);
  assert.match(app, /followLabel/);
  assert.match(app, /commentLikeMap\.get\(/);
  assert.match(app, /commentLiked \? "已赞" : "赞"/);
});

test("作者页展示关注与粉丝公开计数并允许关注他人", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /"关注",\s*profileSocial\.following_count/);
  assert.match(app, /"粉丝",\s*profileSocial\.followers_count/);
  assert.match(app, /toggle-follow-author/);
});

test("样式提供社交反应区与评论点赞激活态", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.work-reactions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(
    css,
    /\.comment-like-button\[aria-pressed="true"\]\s*\{[\s\S]*?color:\s*var\(--vermilion\)/,
  );
});

test("通知页渲染、未读角标、已读与跳转目标齐备", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /function\s+renderNotifications\s*\(/);
  assert.match(app, /renderNotificationsList\s*\(/);
  assert.match(app, /service\.listNotifications\(/);
  assert.match(app, /service\.getNotificationUnreadCount\(/);
  assert.match(app, /service\.markNotificationRead\(/);
  assert.match(app, /service\.markAllNotificationsRead\(/);
  assert.match(app, /refreshNotificationBadge\s*\(/);
  assert.match(app, /action:\s*"mark-all-notifications-read"/);
  assert.match(app, /action:\s*"load-more-notifications"/);
  assert.match(app, /action:\s*"open-notification"/);
  assert.match(app, /notificationTarget\s*\(/);
  assert.match(app, /formatRelativeTime\(notification\.last_event_at\)/);
  assert.match(app, /buildNotificationText\(notification\)/);
  assert.match(app, /notification-item unread/);
});

test("我的关注/粉丝/收藏页经 owner 作用域 RPC 分页加载", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /service\.listMyFollowing\(/);
  assert.match(app, /service\.listMyFollowers\(/);
  assert.match(app, /service\.listMyBookmarks\(/);
  assert.match(app, /renderMyListPageRoute\s*\(/);
  assert.match(app, /route\.name === "my-following"/);
  assert.match(app, /route\.name === "my-followers"/);
  assert.match(app, /route\.name === "my-bookmarks"/);
  assert.match(app, /"全部已读"/);
  assert.match(app, /member-list/);
  assert.match(app, /createBookmarkRow\s*\(/);
});

test("消息页与我的列表提供样式", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.notification-list\s*\{/);
  assert.match(css, /\.notification-row\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(css, /\.notification-item\.unread[\s\S]*?font-weight:\s*600/);
  assert.match(css, /\.member-list\s*\{/);
  assert.match(css, /\.member-name\s*\{/);
});

test("阅读页支持选区批注、浮动入口与批注列表", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /listWorkQuotes\(/);
  assert.match(app, /createQuotedComment\(/);
  assert.match(app, /添加批注/);
  assert.match(app, /getSelection\(\)/);
  assert.match(app, /data-annotatable/);
  assert.match(app, /quote_text/);
});

test("顶部账号菜单与移动底部导航提供私密社交入口", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const menu = html.match(/<div\s+class="account-menu"[\s\S]*?<\/div>/)?.[0];
  assert.ok(menu, "缺少顶部账号菜单");
  for (const href of ["#/notifications", "#/my/bookmarks", "#/my/following", "#/my/followers"]) {
    assert.match(menu, new RegExp(href.replace("#/", "#\\/")));
  }
  const mobileNav = html.match(
    /<nav[^>]+class="mobile-bottom-nav"[\s\S]*?<\/nav>/,
  )?.[0];
  assert.match(mobileNav, /id="notificationsNavBadge"/);
  assert.match(mobileNav, /data-nav="notifications"/);
});
test("普通阅读与作者导航保留现有页面并延后非首屏请求", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const workStart = app.indexOf("async function renderWork(");
  const workEnd = app.indexOf("async function renderWorkVersions", workStart);
  const authorStart = app.indexOf("async function renderAuthor(profileId)");
  const authorEnd = app.indexOf("async function loadDiscussionsPage", authorStart);
  const initializeStart = app.indexOf("async function initialize()");
  const initializeEnd = app.indexOf("async function handleAuthSubmit", initializeStart);
  const workRoute = app.slice(workStart, workEnd);
  const authorRoute = app.slice(authorStart, authorEnd);
  const initializeBody = app.slice(initializeStart, initializeEnd);
  const mediaChangeStart = app.indexOf('mobileHomeMedia.addEventListener("change"');
  const mediaChangeEnd = app.indexOf("if (!window.location.hash)", mediaChangeStart);
  const mediaChangeBody = app.slice(mediaChangeStart, mediaChangeEnd);

  assert.ok(workStart >= 0, "缺少作品路由");
  assert.ok(authorStart >= 0, "缺少作者路由");
  assert.ok(initializeStart >= 0, "缺少初始化流程");
  assert.doesNotMatch(workRoute, /showLoading\(/);
  assert.doesNotMatch(authorRoute, /showLoading\(/);
  assert.match(app, /createRouteCache\(/);
  assert.match(app, /function\s+prefetchRouteTarget\s*\(/);
  assert.doesNotMatch(
    initializeBody,
    /await\s+loadDiscussionsPage\(\{\s*reset:\s*true\s*\}\)/,
  );
  assert.doesNotMatch(
    initializeBody,
    /service\.listWorks\(\)/,
    "首页冷启动不得与分页接口并行请求全量作品",
  );
  assert.match(
    initializeBody,
    /backgroundState[\s\S]*?\.then\([\s\S]*?state\.session\s*=\s*session[\s\S]*?state\.settings\s*=\s*settings/,
    "后台会话与站点设置必须在正常路径写回状态",
  );
  assert.equal(
    (app.match(/document\.addEventListener\("pointerdown",[\s\S]*?prefetchRouteTarget/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    mediaChangeBody,
    /document\.addEventListener\("pointerdown"/,
    "作品预取监听器不得依赖移动端断点发生变化后才注册",
  );
  assert.match(
    workRoute,
    /state\.works\.length\s*\?\s*state\.works\s*:\s*state\.browse\.works/,
    "作品页相关推荐应复用已加载的分页作品",
  );
  const adminLoader = app.match(/async function loadAdminData\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(adminLoader, /service\.listWorks\(\)/, "全量作品只在管理台按需加载");
  assert.match(adminLoader, /state\.works\s*=\s*works/);
});


test("移动端使用动态视口并以细进度线反馈路由加载", async () => {
  const css = await readFile(
    new URL("../assets/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /body\.route-loading::after/);
  assert.match(css, /@keyframes\s+route-progress/);
  assert.match(
    css,
    /\.mobile-feed-stage\s*\{[\s\S]*?min-height:\s*calc\(100dvh - var\(--mobile-nav-height\)\)/,
  );
});
