# Poetry Reading Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve author-entered line breaks and stanza breaks for poetry while keeping the existing prose layout for novels and other categories.

**Architecture:** Extend the existing reading-body renderer with a category argument and category-specific class names. Poetry stanzas remain paragraph nodes whose internal single newlines are preserved by CSS; prose continues using the existing paragraph splitting and drop-cap styles.

**Tech Stack:** Vanilla JavaScript DOM rendering, CSS, Node test runner, Playwright browser checks.

## Global Constraints

- One newline in poetry produces the next poetic line.
- Two or more consecutive newlines create a new stanza with additional spacing.
- Poetry has no paragraph indent and no enlarged, colored, or floated first character.
- Non-poetry categories retain the existing paragraph indentation and first-character decoration.
- Do not modify the database schema, RLS policies, stored content format, or `js/config.mjs`.

---

### Task 1: Category-aware reading body

**Files:**
- Modify: `tests/browser-check.cjs`
- Modify: `js/demo-data.mjs:66-70`
- Modify: `js/app.js:593-603,873`
- Modify: `assets/styles.css:821-850`

**Interfaces:**
- Consumes: a work category string and the work's original content string.
- Produces: `renderParagraphs(content, category) -> HTMLElement`, with `.reading-body--poetry` or `.reading-body--prose`.

- [x] **Step 1: Write the failing browser assertions**

Change the seeded poem so its first stanza contains single newlines:

```js
content:
  "车窗把夜色裁成一格一格\n路灯从旧教学楼的墙面上缓慢退去\n像有人合上一本读到一半的书\n\n末班车里没有人说话\n只有报站声一遍遍确认\n我们仍在城市之中\n\n我想起白天没有寄出的那封信\n纸页很薄，沉默却有重量\n\n车门打开时\n风先下了车",
```

Add assertions after opening the seeded poetry work:

```js
const poetryBody = page.locator(".reading-body--poetry");
await expectVisible(poetryBody, "诗歌正文");
const poetryFirstStanza = poetryBody.locator("p").first();
if (!(await poetryFirstStanza.textContent()).includes("\n")) {
  throw new Error("测试诗歌没有保留作者输入的单次换行");
}
if (
  (await poetryFirstStanza.evaluate((node) => getComputedStyle(node).whiteSpace)) !==
  "pre-line"
) {
  throw new Error("诗歌正文没有保留单次换行");
}
if (
  (await poetryFirstStanza.evaluate((node) => getComputedStyle(node).textIndent)) !==
  "0px"
) {
  throw new Error("诗歌正文不应首行缩进");
}
if (
  (await poetryFirstStanza.evaluate((node) =>
    getComputedStyle(node, "::first-letter").float,
  )) !== "none"
) {
  throw new Error("诗歌首字不应浮动放大");
}
```

Also navigate to the seeded novel and assert:

```js
await page.goto(`${baseUrl}/#/works/work-unnamed-station`);
const proseBody = page.locator(".reading-body--prose");
await expectVisible(proseBody, "小说正文");
if (
  (await proseBody.locator("p").first().evaluate((node) =>
    getComputedStyle(node, "::first-letter").float,
  )) !== "left"
) {
  throw new Error("小说应保留首字装饰");
}
```

- [x] **Step 2: Run the browser test and verify RED**

Run: `npm run test:browser`

Expected: FAIL because `.reading-body--poetry` does not exist.

- [x] **Step 3: Implement category-aware DOM rendering**

Change the renderer to:

```js
function renderParagraphs(content, category) {
  const isPoetry = category === "诗歌";
  const body = element("article", {
    className: `reading-body ${
      isPoetry ? "reading-body--poetry" : "reading-body--prose"
    }`,
  });
  String(content ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .forEach((paragraph) => {
      body.append(element("p", { text: paragraph }));
    });
  return body;
}
```

Pass the category at the reading page call site:

```js
renderParagraphs(work.content, work.category)
```

- [x] **Step 4: Scope prose and poetry CSS**

Replace the unqualified paragraph rules with:

```css
.reading-body p {
  margin: 0 0 1.65em;
}

.reading-body--prose p {
  text-indent: 2em;
}

.reading-body--prose p:first-child {
  text-indent: 0;
}

.reading-body--prose p:first-child::first-letter {
  float: left;
  margin: 0.08em 0.12em 0 0;
  color: var(--vermilion);
  font-family: var(--serif-title);
  font-size: 3.4em;
  line-height: 0.8;
}

.reading-body--poetry p {
  white-space: pre-line;
  text-indent: 0;
}
```

- [x] **Step 5: Verify GREEN and full regression**

Run: `npm run test:browser`

Expected: browser checks pass at desktop and mobile viewports with no console errors or horizontal overflow.

Run: `npm test`

Expected: all unit, static, schema, and browser checks pass.

- [x] **Step 6: Visually inspect generated desktop and mobile reading screenshots**

Open `screenshots/desktop-reading.png` and the mobile poetry reading screenshot produced by the browser test. Confirm line breaks, stanza spacing, absence of the poetry drop cap, and no clipping.

- [x] **Step 7: Commit only the poetry layout implementation**

```text
git add docs/superpowers/plans/2026-07-30-poetry-reading-layout.md tests/browser-check.cjs js/demo-data.mjs js/app.js assets/styles.css
git commit -m "fix: preserve poetry line breaks"
```
