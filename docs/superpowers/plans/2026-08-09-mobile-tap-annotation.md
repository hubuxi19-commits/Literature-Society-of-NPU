# 移动端点句批注 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把移动端批注从「长按/拖动选区 + `window.prompt`」改为「按「添加批注」→ 点文章中某一句话/行 → 弹写作框（类似评论表单）」，桌面拖选入口保留但共用同一写作框。

**Architecture:** 正文渲染时按作品分类把引用单位（新诗按行、旧诗按标点、散文按句）包成 `.annotate-unit` span（平时纯文本无样式）。按「添加批注」只切换 `[data-annotatable]` 上的 `annotating` 类并置 `annotateMode=true`；点单位 span 走现有 click 委托，换算展示串偏移后打开新增的 `#annotateDialog` 写作框提交。`window.prompt` 移除；桌面 `computeQuoteSelection` 升级为跨 span 计算偏移。

**Tech Stack:** 原生 ES modules（`js/app.js`、`js/utils.mjs`）、静态 HTML（`index.html`）、CSS（`assets/styles.css`）、Node test runner（`node --test`）、Playwright（`tests/browser-check.cjs`）。

**Spec:** `docs/superpowers/specs/2026-08-09-mobile-tap-annotation-design.md`

---

### Task 1: `splitQuoteUnits` 纯函数（TDD）

**Files:**
- Modify: `js/utils.mjs`（在 `splitDisplayParagraphs` 之后新增并导出 `splitQuoteUnits`）
- Test: `tests/utils.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/utils.test.mjs` 的 import 列表加入 `splitQuoteUnits`：

```js
import {
  ...
  splitDisplayParagraphs,
  splitQuoteUnits,
  ...
} from "../js/utils.mjs";
```

在文件末尾追加以下测试：

```js
test("引用单位：新诗按行切分并裁剪行首尾空格", () => {
  const units = splitQuoteUnits(
    "车窗把夜色裁成一格一格\n  路灯缓慢退去  \n像有人合上书",
    "新诗",
  );
  assert.deepEqual(units, [
    { text: "车窗把夜色裁成一格一格", start: 0, end: 11 },
    { text: "路灯缓慢退去", start: 14, end: 20 },
    { text: "像有人合上书", start: 23, end: 29 },
  ]);
});

test("引用单位：旧诗按标点切分且换行同样作为分隔", () => {
  const units = splitQuoteUnits("国破山河在，\n城春草木深。", "旧诗");
  assert.deepEqual(units, [
    { text: "国破山河在", start: 0, end: 5 },
    { text: "城春草木深", start: 7, end: 12 },
  ]);
});

test("引用单位：旧诗无标点时退化为按行", () => {
  const units = splitQuoteUnits("床前明月光\n疑是地上霜", "旧诗");
  assert.deepEqual(units, [
    { text: "床前明月光", start: 0, end: 5 },
    { text: "疑是地上霜", start: 6, end: 11 },
  ]);
});

test("引用单位：散文按句末标点切分且引文不含标点", () => {
  const units = splitQuoteUnits("风先下了车。没有人说话！真的吗…就这样", "散文");
  assert.deepEqual(units, [
    { text: "风先下了车", start: 0, end: 5 },
    { text: "没有人说话", start: 6, end: 11 },
    { text: "真的吗", start: 12, end: 15 },
    { text: "就这样", start: 16, end: 19 },
  ]);
});

test("引用单位：偏移按码点计算，emoji 占一位", () => {
  const units = splitQuoteUnits("😀你好。再见", "散文");
  assert.deepEqual(units, [
    { text: "😀你好", start: 0, end: 3 },
    { text: "再见", start: 4, end: 6 },
  ]);
});

test("引用单位：段落内单位与间隔无缝覆盖且与码点切片一致", () => {
  const paragraph = "第一句。第二句！\n第三句";
  const units = splitQuoteUnits(paragraph, "散文");
  assert.ok(units.length >= 2, "应切出多个单位");
  for (const unit of units) {
    assert.equal(codepointSlice(paragraph, unit.start, unit.end), unit.text);
    assert.ok(unit.start >= 0);
    assert.ok(unit.end <= codepointLength(paragraph));
    assert.ok(unit.end > unit.start);
    assert.equal(trimAsciiSpaces(unit.text), unit.text, "单位应已裁首尾 ASCII 空格");
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/utils.test.mjs`
Expected: FAIL，报 `splitQuoteUnits is not a function` / import 错误。

- [ ] **Step 3: 实现**

在 `js/utils.mjs` 的 `splitDisplayParagraphs`（约 254–259 行）之后追加：

```js
// 引用单位切分：新诗按行、旧诗按标点（换行也算分隔）、散文按句末标点。
// 返回 [{ text, start, end }]：start/end 为段落内码点偏移，text 为去首尾 ASCII 空格后的引文。
export function splitQuoteUnits(paragraphText, category) {
  const chars = Array.from(String(paragraphText ?? ""));
  const isDelimiter = quoteUnitDelimiter(category);
  const units = [];
  let segStart = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (isDelimiter(chars[i])) {
      pushQuoteUnit(units, chars, segStart, i);
      segStart = i + 1;
    }
  }
  pushQuoteUnit(units, chars, segStart, chars.length);
  return units;
}

function quoteUnitDelimiter(category) {
  if (category === "旧诗") {
    return (ch) => ch === "\n" || "。，；：！？…".includes(ch);
  }
  if (isPoetryCategory(category)) return (ch) => ch === "\n";
  return (ch) => "。！？…".includes(ch);
}

function pushQuoteUnit(units, chars, rawStart, rawEnd) {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && chars[start] === " ") start += 1;
  while (end > start && chars[end - 1] === " ") end -= 1;
  if (end <= start) return;
  units.push({ text: chars.slice(start, end).join(""), start, end });
}
```

注：`trimAsciiSpaces` 只裁 ASCII 空格（与 SQL `btrim` 一致），故 push 里只跳过 `" "`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/utils.test.mjs`
Expected: PASS（全部通过）。

- [ ] **Step 5: 提交**

```bash
git add js/utils.mjs tests/utils.test.mjs
git commit -m "feat: add quote-unit splitting for tap annotation"
```

---

### Task 2: 新增 `#annotateDialog` 写作框 + 静态检查

**Files:**
- Modify: `index.html`（在 `#profileDialog` 之后、toast 区之前插入 dialog）
- Test: `tests/static-checks.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/static-checks.mjs` 中 `dialog` 存在性断言附近（第 11–13 行之后）追加：

```js
  assert.match(html, /<dialog[^>]+id="annotateDialog"/);
  assert.match(html, /id="annotateForm"/);
  assert.match(html, /id="annotateQuoteText"/);
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/static-checks.mjs`
Expected: FAIL，断言找不到 `annotateDialog`。

- [ ] **Step 3: 实现**

在 `index.html` 的 `#profileDialog` 关闭标签（约 347 行）之后、`<div class="toast-region">`（约 349 行）之前插入：

```html
    <dialog
      class="modal annotate-dialog"
      id="annotateDialog"
      aria-labelledby="annotateTitle"
    >
      <div class="modal-head">
        <div>
          <p class="eyebrow">ANNOTATION</p>
          <h2 id="annotateTitle">写下批注</h2>
        </div>
        <button
          class="close-button"
          type="button"
          data-action="close-annotate"
          aria-label="关闭批注窗口"
        >
          关闭
        </button>
      </div>

      <form id="annotateForm" class="stack-form">
        <blockquote class="annotate-quote" id="annotateQuoteText"></blockquote>
        <label>
          <span>你的批注</span>
          <textarea
            id="annotateContent"
            name="content"
            placeholder="写下你的发现（1–2000 字）"
            maxlength="2000"
            rows="5"
            required
          ></textarea>
        </label>
        <p class="form-message" data-annotate-message role="status"></p>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-annotate">
            取消
          </button>
          <button class="primary-button" type="submit">发表批注</button>
        </div>
      </form>
    </dialog>
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/static-checks.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add index.html tests/static-checks.mjs
git commit -m "feat: add annotation writing-box dialog"
```

---

### Task 3: 写作框与批注单位样式

**Files:**
- Modify: `assets/styles.css`

- [ ] **Step 1: 实现**

在 `assets/styles.css` 末尾追加：

```css
.annotate-dialog {
  padding: 2rem;
}

.annotate-dialog .annotate-quote {
  margin: 0 0 1.2rem;
  padding-left: 1rem;
  border-left: 3px solid var(--vermilion);
  color: var(--vermilion);
  font-family: var(--serif-body);
  line-height: 1.8;
}

.annotate-dialog label {
  display: grid;
  gap: 0.5rem;
}

.annotate-dialog textarea {
  width: 100%;
  min-height: 130px;
  padding: 0.9rem;
  border: 1px solid var(--rule);
  border-radius: 0;
  background: var(--paper-light);
  font-family: var(--serif-body);
  line-height: 1.7;
  resize: vertical;
}

.annotating .annotate-unit {
  cursor: pointer;
  border-radius: 2px;
  background: rgb(140 47 43 / 8%);
}

@media (hover: hover) {
  .annotating .annotate-unit:hover {
    background: rgb(140 47 43 / 14%);
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add assets/styles.css
git commit -m "style: style annotation dialog and tap units"
```

---

### Task 4: 改写浏览器批注用例（红）

**Files:**
- Modify: `tests/browser-check.cjs`

- [ ] **Step 1: 改写桌面选区批注用例（约 266–305 行）**

把「选中正文第一行…prompt 提交」段替换为「选中第一个可批注单位 → 浮动按钮 → 写作框 → 发表」：

```js
  // 选区批注：选中正文第一个可批注单位，浮动入口出现，写作框提交后批注计数 +1 且原文与正文一致。
  await page.evaluate(() => {
    const body = document.querySelector("[data-annotatable]");
    if (!body) throw new Error("阅读页缺少可批注正文");
    const unit = body.querySelector(".annotate-unit");
    const textNode = unit?.firstChild;
    if (!unit || !textNode) throw new Error("阅读页正文缺少可批注句子");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, unit.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    unit.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const annotateFloat = page.locator(".annotate-float");
  await expectVisible(annotateFloat, "选区批注浮动按钮");
  const annotateQuoteText = await annotateFloat.evaluate((button) => {
    const stored = JSON.parse(button.dataset.selection);
    return stored.quoteText;
  });
  if (annotateQuoteText !== "车窗把夜色裁成一格一格") {
    throw new Error(`批注引用原文与所选文字不符：${annotateQuoteText}`);
  }
  // 浮动按钮 → 写作框 → 填写并发表（不再使用系统 prompt）。
  await page.evaluate(() => document.querySelector(".annotate-float").click());
  const annotateDialog = page.locator("#annotateDialog");
  await expectVisible(annotateDialog, "批注写作框");
  await page.locator('#annotateDialog [name="content"]').fill("自动化批注");
  await page.getByRole("button", { name: "发表批注", exact: true }).click();
  await page
    .getByRole("heading", { name: "批注 · 1", exact: true })
    .waitFor();
  await expectVisible(
    page.getByText(`“${annotateQuoteText}”`, { exact: true }),
    "批注引用原文展示",
  );
  const quoteItemText = (await page.locator(".quote-item").first().textContent()) ?? "";
  if (!quoteItemText.includes("自动化批注")) {
    throw new Error(`批注正文没有显示：${quoteItemText}`);
  }
  if (!quoteItemText.includes("松声")) {
    throw new Error(`批注作者没有显示：${quoteItemText}`);
  }
```

- [ ] **Step 2: 改写「导航离开阅读页浮动按钮隐藏」用例的选区（约 307–321 行）**

把 `firstPara.firstChild` 方案替换为第一个单位：

```js
  await page.evaluate(() => {
    const body = document.querySelector("[data-annotatable]");
    if (!body) throw new Error("阅读页缺少可批注正文");
    const unit = body.querySelector(".annotate-unit");
    const textNode = unit?.firstChild;
    if (!unit || !textNode) throw new Error("阅读页正文缺少可批注句子");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, unit.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    unit.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
```

- [ ] **Step 3: 改写移动端批注用例（约 977–1021 行）**

把「进入选择模式 + 程序化选区 + prompt」替换为「点句 → 写作框 → 发表」：

```js
  // 移动端批注：阅读页「查看历史版本」旁的「添加批注」按钮进入点句模式，
  // 点正文第一个可批注单位弹写作框，填写发表后批注计数 +1。
  // 移动端 #accountButton 在 390px 隐藏，登录走底部导航「我的」入口。
  await page
    .getByRole("navigation", { name: "移动端主要导航" })
    .getByRole("link", { name: "我的", exact: true })
    .click();
  await expectVisible(page.locator("#authDialog"), "移动端登录窗口");
  await page.locator('#loginForm [name="studentNumber"]').fill("2023123456");
  await page.locator('#loginForm [name="password"]').fill("wenyuan88");
  await page.getByRole("button", { name: "登录并继续" }).click();
  await page.locator("#authDialog").waitFor({ state: "hidden" });
  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区");
  const mobileVersionsLink = page.getByRole("link", { name: "查看历史版本" });
  await expectVisible(mobileVersionsLink, "移动端历史版本入口");
  const annotateEntry = page.getByRole("button", { name: "添加批注", exact: true });
  await expectVisible(annotateEntry, "移动端批注入口");
  await annotateEntry.click();
  // 批注模式下第一个可批注单位应带高亮提示。
  const firstUnit = page.locator(".annotating .annotate-unit").first();
  await expectVisible(firstUnit, "批注模式可点句子提示");
  await firstUnit.click();
  const annotateDialog = page.locator("#annotateDialog");
  await expectVisible(annotateDialog, "移动端批注写作框");
  const mobileQuoteText =
    (await page.locator("#annotateQuoteText").textContent()) ?? "";
  if (mobileQuoteText !== "“车窗把夜色裁成一格一格”") {
    throw new Error(`移动端批注引文不正确：${mobileQuoteText}`);
  }
  await page.locator('#annotateDialog [name="content"]').fill("移动端自动化批注");
  await page.getByRole("button", { name: "发表批注", exact: true }).click();
  await page
    .getByRole("heading", { name: "批注 · 1", exact: true })
    .waitFor();
  await expectVisible(
    page.getByText(`“车窗把夜色裁成一格一格”`, { exact: true }),
    "移动端批注引用展示",
  );
  const mobileQuoteItemText =
    (await page.locator(".quote-item").first().textContent()) ?? "";
  if (!mobileQuoteItemText.includes("移动端自动化批注")) {
    throw new Error(`移动端批注正文没有显示：${mobileQuoteItemText}`);
  }
```

- [ ] **Step 4: 运行浏览器用例确认失败（红）**

Run: `node tests/run-browser-check.cjs`
Expected: FAIL——移动端流程在 `.annotating .annotate-unit` 定位处报「阅读页缺少可批注句子」或定位不到元素；桌面流程在写作框处失败（当前仍是 `prompt`，无 `#annotateDialog` 逻辑）。**不要提交本任务的改动**，留给 Task 5 一起转绿。

---

### Task 5: app.js 接线（批注单位、批注模式、写作框）

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: 新增 DOM 引用（顶部，`const toast` 之后，约 48 行）**

```js
const annotateDialog = document.querySelector("#annotateDialog");
const annotateQuoteText = document.querySelector("#annotateQuoteText");
const annotateContent = document.querySelector("#annotateContent");
const annotateFormMessage = document.querySelector("[data-annotate-message]");
```

- [ ] **Step 2: import 新增 `splitQuoteUnits`**

在 `js/app.js` 顶部 `import { ... } from "./utils.mjs"`（约 13–32 行）中**加入** `splitQuoteUnits`、**移除** `codepointIndexFromUtf16`（Step 4 重构后不再使用）：

```js
import {
  ...
  codepointLength,
  codepointSlice,
  splitDisplayParagraphs,
  splitQuoteUnits,
  ...
} from "./utils.mjs";
```

- [ ] **Step 3: 新增 pending 状态与两个偏移辅助函数**

把 `computeQuoteSelection` 上方（约 1452–1453 行 `annotateButton`/`annotateMode` 声明处）改为：

```js
let annotateButton = null;
let annotateMode = false;
let pendingAnnotation = null;

// 返回段落相对其所在可批注正文的展示串码点偏移（每个前置段落长度 + 1 个 \n）。
function paragraphDisplayOffset(paragraph, body) {
  const paragraphs = Array.from(body.querySelectorAll("p"));
  let offset = 0;
  for (const p of paragraphs) {
    if (p === paragraph) return offset;
    offset += codepointLength(p.textContent) + 1;
  }
  return offset;
}

// 把选区容器节点 + 偏移换算为段落 textContent 内的码点偏移。
// 正文段落被 .annotate-unit span 包裹后，anchorNode/focusNode 常是 span 内的文本节点，
// selection.anchorOffset/focusOffset 相对该节点而非段落；用 Range 从段首量到该位置。
// 该方式同时正确处理容器为元素（选区起点在段首时 anchorNode 是 <p>）的情况。
function selectionToCodePointOffset(container, offset, paragraph) {
  const range = document.createRange();
  range.setStart(paragraph, 0);
  range.setEnd(container, offset);
  return codepointLength(range.toString());
}
```

- [ ] **Step 4: 改写 `computeQuoteSelection`（约 1455–1489 行）为跨 span 偏移**

```js
function computeQuoteSelection(versionId) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const body = document.querySelector("[data-annotatable]");
  if (!body) return null;
  const anchorPara = selection.anchorNode?.parentElement?.closest("p");
  const focusPara = selection.focusNode?.parentElement?.closest("p");
  if (!anchorPara || anchorPara !== focusPara) {
    return { error: "请在同一段落内选择连续文字" };
  }
  if (!body.contains(anchorPara)) return null;
  const text = anchorPara.textContent;
  const startCp = selectionToCodePointOffset(
    selection.anchorNode,
    selection.anchorOffset,
    anchorPara,
  );
  const endCp = selectionToCodePointOffset(
    selection.focusNode,
    selection.focusOffset,
    anchorPara,
  );
  const start = Math.min(startCp, endCp);
  const end = Math.max(startCp, endCp);
  if (end <= start) return null;
  return {
    quoteText: codepointSlice(text, start, end),
    startOffset: paragraphDisplayOffset(anchorPara, body) + start,
    endOffset: paragraphDisplayOffset(anchorPara, body) + end,
    versionId,
  };
}
```

- [ ] **Step 5: 改写 `handleSelection` 并删除 `commitAnnotationFromSelection`**

把 `commitAnnotationFromSelection` 整个函数（约 1544–1559 行）删除，并把 `handleSelection`（约 1561–1567 行）改为：

```js
function handleSelection(event) {
  if (annotateMode) return;
  showAnnotateButton(event);
}
```

- [ ] **Step 6: 新增 `setAnnotateMode` 并改写 `openAnnotation`**

在 `hideAnnotateButton`（约 1517–1519 行）之后新增：

```js
function setAnnotateMode(active) {
  annotateMode = active;
  const entry = document.querySelector("[data-action='annotate-mode']");
  if (entry) entry.textContent = active ? "取消批注" : "添加批注";
  const body = document.querySelector("[data-annotatable]");
  if (active) {
    body?.classList.add("annotating");
    showToast("点一下要批注的句子或诗行");
  } else {
    body?.classList.remove("annotating");
    hideAnnotateButton();
  }
}
```

把 `openAnnotation`（约 1521–1542 行）整体替换为：

```js
function openAnnotation(selection, body) {
  pendingAnnotation = {
    workId: body.dataset.workId,
    workVersionId: selection.versionId || body.dataset.versionId,
    quoteText: selection.quoteText,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
  };
  annotateQuoteText.textContent = `“${selection.quoteText}”`;
  annotateContent.value = "";
  annotateFormMessage.textContent = "";
  if (!annotateDialog.open) annotateDialog.showModal();
  annotateContent.focus();
}
```

- [ ] **Step 7: 正文渲染包 span**

在 `renderParagraphs`（约 1320–1331 行）之后新增两个函数：

```js
function renderAnnotatableBody(content, category) {
  const isPoetry = isPoetryCategory(category);
  const body = element("article", {
    className: `reading-body ${
      isPoetry ? "reading-body--poetry" : "reading-body--prose"
    }`,
  });
  splitDisplayParagraphs(content).forEach((paragraph) => {
    body.append(renderParagraphWithUnits(paragraph, category));
  });
  return body;
}

function renderParagraphWithUnits(paragraph, category) {
  const p = document.createElement("p");
  const chars = Array.from(paragraph);
  let cursor = 0;
  splitQuoteUnits(paragraph, category).forEach((unit) => {
    if (unit.start > cursor) {
      p.append(document.createTextNode(chars.slice(cursor, unit.start).join("")));
    }
    const span = element("span", {
      className: "annotate-unit",
      dataset: { action: "annotate-unit", start: unit.start, end: unit.end },
    });
    span.textContent = unit.text;
    p.append(span);
    cursor = unit.end;
  });
  if (cursor < chars.length) {
    p.append(document.createTextNode(chars.slice(cursor).join("")));
  }
  return p;
}
```

在 `renderWork` 的 body 构造（约 1824–1830 行）中，把 `renderParagraphs(work.content, work.category)` 换成 `renderAnnotatableBody(work.content, work.category)`：

```js
      (() => {
        const body = renderAnnotatableBody(work.content, work.category);
        body.dataset.workId = work.id;
        body.dataset.versionId = work.current_version_id ?? "";
        body.dataset.annotatable = "";
        return body;
      })(),
```

- [ ] **Step 8: click 委托新增 `annotate-unit` 与 `close-annotate`**

在 click 委托的 `open-annotation` 分支（约 3201–3207 行）之后新增：

```js
  } else if (action === "annotate-unit") {
    if (!annotateMode) return;
    const paragraph = trigger.closest("p");
    const body = document.querySelector("[data-annotatable]");
    if (!body || !paragraph || !body.contains(paragraph)) return;
    openAnnotation(
      {
        quoteText: trigger.textContent,
        startOffset:
          paragraphDisplayOffset(paragraph, body) + Number(trigger.dataset.start),
        endOffset: paragraphDisplayOffset(paragraph, body) + Number(trigger.dataset.end),
        versionId: body.dataset.versionId,
      },
      body,
    );
  } else if (action === "close-annotate") {
    annotateDialog.close();
  }
```

- [ ] **Step 9: 改写 `annotate-mode` 分支**

把 `annotate-mode` 分支（约 3193–3200 行）替换为：

```js
  } else if (action === "annotate-mode") {
    setAnnotateMode(!annotateMode);
  }
```

- [ ] **Step 10: submit 委托新增 `annotateForm`**

在 submit 委托（`document.addEventListener("submit", ...)`，约 3232 行起）的 `homeFilters` 分支之后新增：

```js
  } else if (form.id === "annotateForm") {
    event.preventDefault();
    const content = String(new FormData(form).get("content") ?? "").trim();
    if (!content) {
      annotateFormMessage.textContent = "批注不能为空。";
      return;
    }
    const workId = pendingAnnotation?.workId;
    if (!workId) return;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await service.createQuotedComment({
        workId,
        workVersionId: pendingAnnotation.workVersionId,
        quoteText: pendingAnnotation.quoteText,
        startOffset: pendingAnnotation.startOffset,
        endOffset: pendingAnnotation.endOffset,
        content,
      });
      annotateDialog.close();
      pendingAnnotation = null;
      setAnnotateMode(false);
      showToast("批注已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      annotateFormMessage.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  }
```

- [ ] **Step 11: dialog close 事件清空 pending**

在 `initialize()`（约 2825 行起）开头、`document.addEventListener("mouseup", handleSelection)` 附近新增：

```js
  annotateDialog.addEventListener("close", () => {
    pendingAnnotation = null;
  });
```

- [ ] **Step 12: 路由切换复位批注模式**

把 `renderCurrentRoute`（约 2708 行）的 `annotateMode = false;` 替换为：

```js
  setAnnotateMode(false);
```

- [ ] **Step 13: 运行单元测试确认无回归**

Run: `npm run test:unit`
Expected: PASS。

- [ ] **Step 14: 运行浏览器用例确认转绿**

Run: `node tests/run-browser-check.cjs`
Expected: PASS（桌面选区 + 移动端点句两条批注流程通过）。

- [ ] **Step 15: 提交**

```bash
git add js/app.js tests/browser-check.cjs
git commit -m "feat: mobile tap-to-annotate with writing box"
```

---

### Task 6: 全量验证与收尾

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 单元 + 浏览器全部通过。

- [ ] **Step 2: 静态检查与状态确认**

Run: `git diff --check` 与 `git status --short`
Expected: 无空白错误；工作区仅剩既有的未提交截图（`screenshots/desktop-reading.png`、`screenshots/mobile-home.png`、`screenshots/mobile-reading.png`、`screenshots/staging-smoke-fail.png`），保持不提交。

- [ ] **Step 3: 更新项目记忆/待办（如需）**

- [ ] **Step 4: 汇报结果**

向负责人汇报：改动文件、测试结果、浏览器验证结论；提示线上写路径（登录后移动端点句批注）需负责人在生产用真实账号复验。
