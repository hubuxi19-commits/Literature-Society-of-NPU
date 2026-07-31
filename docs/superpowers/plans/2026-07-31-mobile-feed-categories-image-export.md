# Mobile Feed, Poetry Categories, and Image Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 新诗/旧诗 categories, a swipe-based mobile work feed, bio-only profile editing, and direct mobile-friendly PNG export while preserving all existing Supabase community features.

**Architecture:** Keep the existing hash-routed HTML/CSS/JavaScript application and data-service boundary. Move reusable category, mobile-queue, gesture, pagination, filename, and export behavior into focused ES modules so Node unit tests can verify pure logic and Playwright can verify browser rendering. Reuse the existing `works.is_featured` field and render PNGs entirely in the browser from an offscreen fixed-size DOM page.

**Tech Stack:** HTML5, CSS, browser ES modules, Node test runner, Playwright, Supabase PostgreSQL/RLS, SVG `foreignObject` + Canvas PNG encoding, Web Share API with download fallback.

## Global Constraints

- Public categories are exactly `全部、新诗、旧诗、散文、小说、随笔、其他`.
- Publishable categories are exactly `新诗、旧诗、散文、小说、随笔、其他`; never show `诗歌` in a publishing control.
- Existing database rows with `category = '诗歌'` migrate to `新诗`.
- Both 新诗 and 旧诗 preserve single newlines and have no drop cap or first-line indent.
- Mobile left swipe advances; right swipe returns through session history; tapping opens the work reading/discussion page.
- Mobile ordering is featured-first, then session-random, without repeats until exhaustion.
- Pen names remain visible but ordinary users can edit only `bio`.
- Export uses a 1080 × 1920 “素笺” page, bold title at the top, no category kicker, and the transparent `assets/student-literature-society-wordmark.png` at bottom right.
- Export happens locally in the browser; do not send work text to an image service.
- Do not expose student numbers, passwords, service-role keys, or other private identifiers.

---

## File Structure

- `js/utils.mjs`: shared validation, routes, category normalization, and poetry detection.
- `js/mobile-feed.mjs`: deterministic featured-first queue construction and swipe-direction resolution.
- `js/image-export.mjs`: content-unit splitting, page planning, offscreen page rendering, PNG Blob conversion, sharing, and download fallback.
- `js/app.js`: route rendering and UI event integration only.
- `js/data-service.mjs`: demo and Supabase data access; bio-only profile updates.
- `js/demo-data.mjs`: representative 新诗/旧诗 demo fixtures.
- `assets/styles.css`: desktop-safe category changes, mobile feed, gestures, export button/dialog, and offscreen export template.
- `assets/student-literature-society-wordmark.png`: transparent local brush wordmark.
- `supabase/schema.sql`: clean-install schema with target category and profile-update permissions.
- `supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql`: production-safe data/constraint/grant migration.
- `tests/utils.test.mjs`: category normalization and poetry detection.
- `tests/mobile-feed.test.mjs`: feed ordering, uniqueness, and swipe thresholds.
- `tests/image-export.test.mjs`: content units, pagination, page names, and dimensions.
- `tests/data-service.test.mjs`: new categories and bio-only profile updates.
- `tests/schema.test.mjs`: migration/schema constraints and column grants.
- `tests/browser-check.cjs`: desktop/mobile interaction, reading layout, swipe, and export smoke checks.
- `README.md`: migration, local preview, mobile behavior, export, and deployment instructions.

---

### Task 1: Category Contract and Poetry Rendering

**Files:**
- Modify: `js/utils.mjs`
- Modify: `js/app.js`
- Modify: `js/demo-data.mjs`
- Modify: `tests/utils.test.mjs`
- Modify: `tests/data-service.test.mjs`

**Interfaces:**
- Produces: `CATEGORIES: readonly string[]`
- Produces: `PUBLISHABLE_CATEGORIES: readonly string[]`
- Produces: `normalizeCategory(value: unknown): string`
- Produces: `isPoetryCategory(value: unknown): boolean`
- Consumes: Existing `filterAndSortWorks(works, filters)`

- [ ] **Step 1: Write failing category and poetry tests**

Add imports and tests to `tests/utils.test.mjs`:

```js
import {
  CATEGORIES,
  PUBLISHABLE_CATEGORIES,
  normalizeCategory,
  isPoetryCategory,
} from "../js/utils.mjs";

test("分类拆分为新诗和旧诗且投稿不显示旧诗歌分类", () => {
  assert.deepEqual(CATEGORIES, [
    "全部", "新诗", "旧诗", "散文", "小说", "随笔", "其他",
  ]);
  assert.deepEqual(PUBLISHABLE_CATEGORIES, [
    "新诗", "旧诗", "散文", "小说", "随笔", "其他",
  ]);
  assert.equal(CATEGORIES.includes("诗歌"), false);
});

test("旧诗歌数据兼容映射为新诗且两类诗都使用诗歌排版", () => {
  assert.equal(normalizeCategory("诗歌"), "新诗");
  assert.equal(normalizeCategory("旧诗"), "旧诗");
  assert.equal(isPoetryCategory("诗歌"), true);
  assert.equal(isPoetryCategory("新诗"), true);
  assert.equal(isPoetryCategory("旧诗"), true);
  assert.equal(isPoetryCategory("散文"), false);
});
```

Change data-service fixtures that create `"诗歌"` to `"新诗"` and add one `"旧诗"` creation assertion.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
node --test tests/utils.test.mjs tests/data-service.test.mjs
```

Expected: FAIL because the four category exports do not exist and old fixtures still use `诗歌`.

- [ ] **Step 3: Implement the category contract**

Add to `js/utils.mjs`:

```js
export const CATEGORIES = Object.freeze([
  "全部", "新诗", "旧诗", "散文", "小说", "随笔", "其他",
]);

export const PUBLISHABLE_CATEGORIES = Object.freeze(CATEGORIES.slice(1));

export function normalizeCategory(value) {
  const category = String(value ?? "").trim();
  if (category === "诗歌") return "新诗";
  return PUBLISHABLE_CATEGORIES.includes(category) ? category : "其他";
}

export function isPoetryCategory(value) {
  return ["诗歌", "新诗", "旧诗"].includes(String(value ?? "").trim());
}
```

Update `filterAndSortWorks` so comparison uses `normalizeCategory(work.category)`. In `js/app.js`, import the constants and `isPoetryCategory`, remove the local `CATEGORIES`, use `PUBLISHABLE_CATEGORIES` in the writing form, default drafts to `新诗`, and replace `category === "诗歌"` in `renderParagraphs`.

Update all user-facing submission copy to “新诗、旧诗、散文、小说、随笔与其他文字” and replace demo work categories with at least one 新诗 and one 旧诗.

- [ ] **Step 4: Run category tests**

Run:

```powershell
node --test tests/utils.test.mjs tests/data-service.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the category contract**

```powershell
git add js/utils.mjs js/app.js js/demo-data.mjs tests/utils.test.mjs tests/data-service.test.mjs
git commit -m "feat: split poetry into modern and classical categories"
```

---

### Task 2: Supabase Migration and Bio-Only Profile Updates

**Files:**
- Create: `supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql`
- Modify: `supabase/schema.sql`
- Modify: `js/data-service.mjs`
- Modify: `js/app.js`
- Modify: `tests/schema.test.mjs`
- Modify: `tests/data-service.test.mjs`
- Modify: `tests/static-checks.mjs`

**Interfaces:**
- Consumes: `service.updateProfile(profileId, { bio })`
- Produces: Demo and Supabase implementations that ignore/reject pen-name input and update only `bio`.
- Produces: Idempotent SQL migration for existing production data.

- [ ] **Step 1: Write failing schema and profile tests**

Add to `tests/schema.test.mjs`:

```js
test("schema 只允许新分类并禁止普通用户更新笔名", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(
    sql,
    /category in\s*\(\s*'新诗',\s*'旧诗',\s*'散文',\s*'小说',\s*'随笔',\s*'其他'\s*\)/i,
  );
  assert.match(
    sql,
    /grant update\s*\(\s*bio,\s*updated_at\s*\)\s*on table public\.profiles/i,
  );
  assert.doesNotMatch(
    sql,
    /grant update\s*\([^)]*pen_name[^)]*\)\s*on table public\.profiles/i,
  );
});

test("生产迁移先转换旧诗歌再添加目标约束", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /update public\.works\s+set category = '新诗'\s+where category = '诗歌'/i);
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
});
```

Change the profile test in `tests/data-service.test.mjs`:

```js
const originalPenName = session.profile.pen_name;
const profile = await service.updateProfile(session.profile.id, {
  bio: "在夜里写作。",
  pen_name: "不应生效",
});
assert.equal(profile.pen_name, originalPenName);
assert.equal(profile.bio, "在夜里写作。");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
node --test tests/schema.test.mjs tests/data-service.test.mjs tests/static-checks.mjs
```

Expected: FAIL on old category constraint, old column grant, missing migration, and pen-name mutation.

- [ ] **Step 3: Add the production migration**

Create `supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql`:

```sql
begin;

alter table public.works
  drop constraint if exists works_category_check;

update public.works
set category = '新诗'
where category = '诗歌';

alter table public.works
  add constraint works_category_check
  check (category in ('新诗', '旧诗', '散文', '小说', '随笔', '其他'));

revoke update on table public.profiles from authenticated;
grant update (bio, updated_at) on table public.profiles to authenticated;

commit;
```

Apply the same final category constraint and grant to `supabase/schema.sql`. Reuse the existing `is_featured` column and `set_work_featured` RPC without schema changes.

- [ ] **Step 4: Make profile updates bio-only**

In both demo and Supabase `updateProfile` implementations:

```js
const bio = String(input.bio ?? "").trim().slice(0, 240);
```

Do not assign or send `pen_name`. Update the author-page form in `js/app.js` to render the pen name as read-only explanatory text and only submit:

```js
const profile = await service.updateProfile(form.dataset.profileId, {
  bio: data.get("bio"),
});
```

Change the button label to “保存简介”.

- [ ] **Step 5: Run schema, data-service, and static tests**

Run:

```powershell
node --test tests/schema.test.mjs tests/data-service.test.mjs tests/static-checks.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Commit migration and profile lock**

```powershell
git add supabase/schema.sql supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql js/data-service.mjs js/app.js tests/schema.test.mjs tests/data-service.test.mjs tests/static-checks.mjs
git commit -m "feat: migrate poetry categories and lock pen names"
```

---

### Task 3: Featured-First Mobile Feed Queue and Swipe Logic

**Files:**
- Create: `js/mobile-feed.mjs`
- Create: `tests/mobile-feed.test.mjs`
- Modify: `js/app.js`
- Modify: `assets/styles.css`
- Modify: `tests/static-checks.mjs`

**Interfaces:**
- Produces: `buildMobileFeedQueue(works, random): Work[]`
- Produces: `resolveHorizontalSwipe(deltaX, deltaY, threshold?): "next" | "previous" | null`
- Produces: `createMobileFeedController(works, random)` with `current()`, `next()`, `previous()`, and `reset(works, random)`.
- Consumes: Normalized works from `state.works`.

- [ ] **Step 1: Write failing mobile-feed unit tests**

Create `tests/mobile-feed.test.mjs`:

```js
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
  const queue = buildMobileFeedQueue(works, () => randomValues.shift() ?? 0.5);
  assert.deepEqual(queue.slice(0, 2).map((work) => work.id), [
    "latest-featured", "older-featured",
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
});

test("只有明确水平手势才切换作品", () => {
  assert.equal(resolveHorizontalSwipe(-80, 10), "next");
  assert.equal(resolveHorizontalSwipe(80, 10), "previous");
  assert.equal(resolveHorizontalSwipe(-40, 2), null);
  assert.equal(resolveHorizontalSwipe(-90, 120), null);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
node --test tests/mobile-feed.test.mjs
```

Expected: FAIL because `js/mobile-feed.mjs` does not exist.

- [ ] **Step 3: Implement pure feed logic**

Create `js/mobile-feed.mjs` with Fisher-Yates shuffling for non-featured works, stable date ordering for featured works, ID-based deduplication, and a cursor-based controller. Use this swipe rule:

```js
export function resolveHorizontalSwipe(deltaX, deltaY, threshold = 56) {
  if (Math.abs(deltaX) < threshold) return null;
  if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return null;
  return deltaX < 0 ? "next" : "previous";
}
```

The controller must return `null` after the final next item and must not move before index zero.

- [ ] **Step 4: Integrate the mobile home renderer**

In `js/app.js`:

- Import the controller and gesture function.
- Add `state.mobileFeed = { controller: null, signature: "", touch: null }`.
- Build a signature from active category, query, sort, and matching work IDs.
- Render existing desktop home when `matchMedia("(max-width: 760px)").matches` is false.
- Render `renderMobileHome()` when true.
- The mobile card must have `data-mobile-work-card`, `tabindex="0"`, and a stable `data-work-id`.
- Add previous/next controls for keyboard and accessibility.
- Add `touchstart`, `touchmove`, and `touchend` listeners with `{ passive: true }`; call the pure gesture resolver on end.
- Set `state.mobileFeed.suppressClick = true` after a successful swipe and clear it on the next animation frame.
- Clicking the card when not suppressed sets `window.location.hash` to the work route.

- [ ] **Step 5: Add mobile feed styling**

Add a `@media (max-width: 760px)` block in `assets/styles.css` that:

- Hides desktop hero/editorial/lead-grid/community rail only on the home mobile layout.
- Uses a `min-height: calc(100svh - var(--mobile-nav-height))` stage.
- Styles a paper card with large whitespace, readable Song-style type, thin rules, and dark-red accents.
- Uses `touch-action: pan-y` on the card so vertical page movement still works.
- Truncates long prose safely and preserves poem line breaks with `white-space: pre-wrap`.
- Keeps controls at least 44px high.
- Honors `prefers-reduced-motion`.

- [ ] **Step 6: Run unit and static tests**

Run:

```powershell
node --test tests/mobile-feed.test.mjs tests/static-checks.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit mobile feed**

```powershell
git add js/mobile-feed.mjs tests/mobile-feed.test.mjs js/app.js assets/styles.css tests/static-checks.mjs
git commit -m "feat: add featured-first mobile swipe feed"
```

---

### Task 4: PNG Export Planning and Rendering

**Files:**
- Create: `js/image-export.mjs`
- Create: `tests/image-export.test.mjs`
- Modify: `js/app.js`
- Modify: `assets/styles.css`
- Modify: `tests/static-checks.mjs`
- Verify: `assets/student-literature-society-wordmark.png`

**Interfaces:**
- Produces: `splitExportUnits(content, category): ExportUnit[]`
- Produces: `paginateExportUnits(units, measure, maxHeight): ExportUnit[][]`
- Produces: `buildExportFileName(work, pageIndex, pageCount): string`
- Produces: `exportWorkImages(work, options): Promise<{ blobs: Blob[], shared: boolean }>`
- Consumes: `isPoetryCategory(category)` and the local wordmark URL.

- [ ] **Step 1: Write failing export tests**

Create `tests/image-export.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  buildExportFileName,
  paginateExportUnits,
  splitExportUnits,
} from "../js/image-export.mjs";

test("导出尺寸固定为手机竖图", () => {
  assert.equal(EXPORT_WIDTH, 1080);
  assert.equal(EXPORT_HEIGHT, 1920);
});

test("诗歌逐行成为不可拆单元并保留空行", () => {
  assert.deepEqual(
    splitExportUnits("第一行\n第二行\n\n第三行", "新诗"),
    [
      { type: "line", text: "第一行" },
      { type: "line", text: "第二行" },
      { type: "space", text: "" },
      { type: "line", text: "第三行" },
    ],
  );
});

test("散文按段落拆分", () => {
  assert.deepEqual(
    splitExportUnits("第一段。\n\n第二段。", "散文"),
    [
      { type: "paragraph", text: "第一段。" },
      { type: "paragraph", text: "第二段。" },
    ],
  );
});

test("分页不拆内容单元且不会生成空页", () => {
  const units = [
    { type: "line", text: "一" },
    { type: "line", text: "二" },
    { type: "line", text: "三" },
  ];
  const pages = paginateExportUnits(units, () => 40, 80);
  assert.deepEqual(pages.map((page) => page.map((unit) => unit.text)), [
    ["一", "二"], ["三"],
  ]);
});

test("多页文件名带两位页码并清除非法字符", () => {
  const work = { title: "风/雨", author_pen_name: "松声" };
  assert.equal(
    buildExportFileName(work, 0, 3),
    "风-雨-松声-01.png",
  );
});
```

- [ ] **Step 2: Run the export tests and verify failure**

Run:

```powershell
node --test tests/image-export.test.mjs
```

Expected: FAIL because `js/image-export.mjs` does not exist.

- [ ] **Step 3: Implement pure export planning**

Create `js/image-export.mjs` and export:

```js
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;
```

Implement:

- `splitExportUnits`: poetry splits every newline and converts empty lines to `space`; prose splits on one or more blank lines.
- `paginateExportUnits`: accumulates measured heights up to `maxHeight`; an oversized prose paragraph may be split by character ranges using a binary-search fit helper, while poetry lines are never split.
- `buildExportFileName`: replaces Windows and URL-unsafe filename characters with `-`, collapses repeats, and appends a two-digit page suffix only when `pageCount > 1`.

- [ ] **Step 4: Implement the offscreen “素笺” renderer**

Build one offscreen `.export-page` per planned page:

```html
<article class="export-page">
  <h1 class="export-title"></h1>
  <div class="export-body"></div>
  <footer class="export-footer">
    <span class="export-author-date"></span>
    <span class="export-page-number"></span>
    <img class="export-wordmark" alt="学生文学社">
  </footer>
</article>
```

Requirements:

- Use exact 1080 × 1920 CSS pixel dimensions.
- Reserve footer space so the wordmark cannot overlap the body.
- Set the wordmark width to 30% and bottom/right offsets to 64px.
- Wait for `document.fonts.ready` and the wordmark image `decode()`.
- Clone computed page markup into an SVG `foreignObject`, draw the SVG to a 1080 × 1920 canvas, and call `canvas.toBlob(..., "image/png")`.
- Revoke every temporary object URL in `finally`.
- Keep the renderer root outside the viewport and remove it after success or failure.

- [ ] **Step 5: Implement direct save and share**

`exportWorkImages` must:

1. Generate all page Blobs.
2. Create `File` objects with `buildExportFileName`.
3. If `navigator.canShare({ files })` and `navigator.share` exist, call the share sheet.
4. Treat `AbortError` as a user cancellation, not a failure.
5. Otherwise create download anchors sequentially.
6. Return the blobs so browser tests can inspect dimensions.

For multiple downloads, show an export results panel containing one explicit “保存第 N 页” button per page so blocked automatic downloads remain recoverable.

- [ ] **Step 6: Integrate export into the reading page**

In `renderWork`, add:

```js
element("button", {
  className: "secondary-button export-work-button",
  type: "button",
  text: "生成作品图片",
  dataset: { action: "export-work", workId: work.id },
})
```

Store the current detail object in `state.currentWork`. Add a click branch that disables the button, changes text to “正在生成…”, calls `exportWorkImages`, shows a success/fallback message, and restores the button in `finally`.

- [ ] **Step 7: Add export template styles and static assertions**

Add fixed export styles outside responsive media queries. Add tests that assert:

- The app references `student-literature-society-wordmark.png`.
- The reading page contains the export action.
- No network image-generation endpoint or service-role key is referenced.

- [ ] **Step 8: Run export, static, and full unit tests**

Run:

```powershell
node --test tests/image-export.test.mjs tests/static-checks.mjs
npm run test:unit
```

Expected: all tests PASS.

- [ ] **Step 9: Commit image export**

```powershell
git add js/image-export.mjs tests/image-export.test.mjs js/app.js assets/styles.css tests/static-checks.mjs
git commit -m "feat: export works as branded mobile images"
```

---

### Task 5: Desktop and Mobile Browser Verification

**Files:**
- Modify: `tests/browser-check.cjs`
- Modify: `tests/e2e-smoke.cjs`
- Update: `screenshots/desktop-home.png`
- Update: `screenshots/desktop-reading.png`
- Update: `screenshots/mobile-home.png`
- Update: `screenshots/mobile-reading.png`

**Interfaces:**
- Consumes: running app at `http://127.0.0.1:4173`
- Produces: browser assertions and current reference screenshots.

- [ ] **Step 1: Add failing browser assertions**

Extend `tests/browser-check.cjs` to verify:

- Desktop category select contains 新诗 and 旧诗 and excludes 诗歌.
- Writing form defaults to 新诗.
- Profile form has no `input[name="penName"]` and retains `textarea[name="bio"]`.
- Mobile 390 × 844 home shows exactly one `[data-mobile-work-card]`.
- A synthetic left touch/pointer sequence changes `data-work-id`.
- A synthetic right sequence restores the previous ID.
- Card activation navigates to `#/works/:id`.
- Both 新诗 and 旧诗 reading bodies use `.reading-body--poetry`.
- Clicking export produces a 1080 × 1920 PNG Blob or exposes the explicit save result.
- The visible wordmark does not intersect the measured body content rectangle.

- [ ] **Step 2: Run browser checks and verify failure**

Run:

```powershell
npm run test:browser
```

Expected: FAIL on newly added category, mobile card, profile, and export assertions before all integration details are complete.

- [ ] **Step 3: Fix integration gaps without changing the approved design**

Use the failing assertion as the scope for each correction. Do not weaken:

- the 56px swipe threshold,
- featured-first ordering,
- the no-repeat session history,
- the absence of editable pen-name controls,
- the exact 1080 × 1920 export dimensions,
- the no-overlap wordmark footer.

- [ ] **Step 4: Capture current desktop and mobile screenshots**

Run the existing browser-check screenshot flow at:

- Desktop: 1440 × 1000, home and reading.
- Mobile: 390 × 844, home and reading.

Overwrite the four existing screenshot files only after assertions pass.

- [ ] **Step 5: Run the complete automated suite**

Run:

```powershell
npm test
```

Expected:

```text
test:unit ... PASS
test:browser ... PASS
```

- [ ] **Step 6: Commit verified browser behavior**

```powershell
git add tests/browser-check.cjs tests/e2e-smoke.cjs screenshots
git commit -m "test: verify mobile feed and image export"
```

---

### Task 6: Documentation, Migration Handoff, and Release Check

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/superpowers/specs/2026-07-31-mobile-feed-categories-image-export-design.md`

**Interfaces:**
- Produces: exact production migration and GitHub Pages release instructions.

- [ ] **Step 1: Update README behavior and migration instructions**

Document:

- New category list and the legacy `诗歌 → 新诗` migration.
- Mobile left/right swipe behavior and card-to-reading navigation.
- PNG export, multi-page naming, share/download fallback, and local-only rendering.
- Exact Supabase SQL Editor order: run the migration, confirm no `诗歌` rows, then publish the frontend.
- Verification query:

```sql
select category, count(*)
from public.works
group by category
order by category;
```

- GitHub release commands:

```powershell
git status
git push origin main
```

- GitHub Pages check URL and expected cache refresh guidance.

- [ ] **Step 2: Update security guidance**

State that:

- Supabase anon publishable key may be present in the frontend.
- Supabase service-role key must never be present.
- RLS remains required on every table.
- Pen-name updates are blocked by column grant, not just hidden UI.
- Generated images are rendered locally and do not upload work content.

- [ ] **Step 3: Run final verification from a clean server start**

Run:

```powershell
git status --short
npm test
git diff --check
```

Expected: tests PASS and no whitespace errors. Before the documentation commit, only README/SECURITY/spec changes should be listed.

- [ ] **Step 4: Commit documentation**

```powershell
git add README.md SECURITY.md docs/superpowers/specs/2026-07-31-mobile-feed-categories-image-export-design.md
git commit -m "docs: explain mobile feed export and category migration"
```

- [ ] **Step 5: Final release audit**

Run:

```powershell
git status --short --branch
git log -6 --oneline
npm test
```

Expected: clean worktree, branch ahead of `origin/main` by the new commits, and full test suite PASS. Do not push until the user confirms the Supabase migration timing or explicitly asks to publish.

