# 移动端点句批注（发布 3 补丁）Design

日期：2026-08-09
状态：已批准（负责人逐节确认）

## 目标

把移动端批注从「长按/拖动选区 + `window.prompt`」改为「按「添加批注」后点文章中某一句话/行，直接弹写作框写批注」，写作框沿用评论输入框的观感。桌面端拖动选区的入口保持不变，但统一走同一个写作框（不再用系统 prompt）。

## 范围

- `js/app.js`：批注单位切分、批注模式点击处理、写作框对话框、移除 `window.prompt`。
- `js/utils.mjs`：新增 `splitQuoteUnits(paragraphText, category)` 纯函数（新诗按行 / 旧诗按标点 / 散文按句）。
- `index.html`：新增 `#annotateDialog`（modal，写作框）。
- `assets/styles.css`：写作框、批注单位可点样式、批注模式正文样式。
- `tests/browser-check.cjs`：改写移动端批注用例为「点句 → 写作框 → 发表」。
- 单元测试：`splitQuoteUnits` 规则覆盖。

不改数据库、不改 RPC、不改展示串契约（偏移仍按码点，引文 = 展示串子串）。

## 1. 引用单位规则（按作品分类）

单位从「段落文本」内切分。段落 = `splitDisplayParagraphs(content)` 的结果（每个 `<p>`），其文本与 SQL 展示串分段逐字一致。

`splitQuoteUnits(paragraphText, category)` 返回 `[{ text, start, end }]`，其中 `start`/`end` 是段落内码点偏移，`text` 为裁掉首尾 ASCII 空格后的引文（`trimAsciiSpaces`）。

| 分类 | 判定 | 分隔符 | 引文是否含分隔符 |
|------|------|--------|------------------|
| 新诗 | `category === "新诗"` | `\n`（每行） | 含行末标点，不含 `\n` |
| 旧诗 | `category === "旧诗"` | `[\n。，；：！？…]` | 不含分隔符 |
| 散文/小说/随笔/其他 | 其余 | `[。！？…]`（句末标点） | 不含分隔符 |

规则细节：

- 每个单位 = 相邻分隔符之间的一段文本，再 `trimAsciiSpaces`；空单位丢弃。
- 旧诗把 `\n` 一并当分隔符：防止标点短语跨行（如「国破山河在，\n城春草木深。」切成「国破山河在」与「城春草木深」）。无标点的旧诗因此自然退化为按行。
- 散文只在句末标点（。！？…）切分；段内长句不切 `，`/`；`，符合「某一句话」语义。引文带引号时偶发在句末标点内切分属已知限制，不特殊处理。
- 不做前端截断：超过 500 码点的单位提交时由后端拒绝并提示「引用原文必须为 1 至 500 个字符」。

## 2. 交互流程（移动端）

进入/退出批注模式**不重渲染正文**：阅读页渲染时即按规则把单位包成 `<span class="annotate-unit" data-action="annotate-unit">`，平时纯文本无样式；进模式只切换 `[data-annotatable]` 上的 `annotating` 类并置 `annotateMode = true`。

- 点「添加批注」→ 按钮文字变「取消批注」；toast「点一下要批注的句子」；正文单位出现浅色可点提示。
- 点某单位 → 弹写作框（`#annotateDialog`），引文预览 `“……”`；此时批注模式暂时挂起（按钮仍显示「取消批注」）。
- 写作框：标题「写下批注」+ 引文 `blockquote` + `textarea`（`maxlength=2000`，placeholder「写下你的发现」）+ 取消 /「发表批注」按钮 + 错误行。
- 发表成功 → 关写作框 → toast「批注已发表」→ 退出批注模式 → `renderWork(workId)` 刷新（沿用现有批注列表渲染）。
- 取消写作框 → 回到批注模式，可继续点其他句子/行（按钮仍为「取消批注」）。
- 再点「取消批注」按钮 → 退出批注模式，移除 `annotating` 类，按钮复原。

实现要点：

- 单位 span 带 `data-start`/`data-end`（段落内码点偏移），点击时换算为展示串偏移（沿用现有 `computeQuoteSelection` 的 `displayOffset` 累加逻辑），`quoteText` 取 `span.textContent`。
- 点击分发走现有 `document` click 委托：`data-action="annotate-unit"` 分支，仅 `annotateMode` 为真时响应；点击后先退出批注模式再开写作框。
- `handleSelection`（mouseup/touchend）在批注模式下的旧逻辑（`commitAnnotationFromSelection`）删除，避免与点选冲突。
- 路由离开阅读页时退出批注模式并复位按钮（沿用现有 `8b7a4a1` 的隐藏逻辑）。

## 3. 写作框替换 window.prompt

- 新增静态 `<dialog class="modal" id="annotateDialog">`，结构与 `authDialog`/`profileDialog` 一致（`modal-head` + 内容 + `modal-actions`）。
- `openAnnotation(selection, body)` 改为：填充引文预览与版本/作品上下文 → `showModal()` → 返回（不再 `prompt`）。
- 提交处理：`#annotateForm` submit → 校验非空、≤2000 → `service.createQuotedComment({ workId, workVersionId, quoteText, startOffset, endOffset, content })` → 成功关框并刷新；失败把 `error.message` 写入错误行，`routeToAccountSecurityIfUnverified` 处理登录/验证跳转。
- 桌面端浮动按钮 `open-annotation` 分支复用同一函数，行为统一。

## 4. 登录门禁

沿用现状：入口按钮对所有访客可见；提交时 `createQuotedComment` 校验登录与找回邮箱验证（RPC/门禁为最终权威），未登录经 `routeToAccountSecurityIfUnverified` 跳登录页。本轮不改门禁行为。

## 5. 测试

- 单元（`tests/utils` 或现有 app 逻辑测试所在处）：
  - 新诗按行切分、行首尾空格裁剪、含标点行。
  - 旧诗按标点切分、`\n` 分隔、无标点退化按行。
  - 散文按句切分、引文不含句末标点、空单位丢弃。
  - 偏移与展示串子串一致性（引文 = `codepointSlice(display, start, end)`）。
- 浏览器（`tests/browser-check.cjs` 移动端流程）：
  - 登录 → 打开作品 → 点「添加批注」→ 点正文第一句 → 写作框出现且引文正确 → 填文字 → 发表 → 批注计数 +1、`quote-item` 显示引文与批注正文。
  - 桌面端选区 → 浮动按钮 → 写作框 → 发表仍通过。
- 既有 `data-service.test.mjs` / `works-versions-db.test.mjs` 不受影响（服务契约未改）。

## 已知限制

- 散文带引号的句子在句末标点处切分偶有「引号落在句首」现象，不特殊处理。
- 单位超 500 码点由后端拒绝并 toast 提示（沿用「引用原文必须为 1 至 500 个字符」）。
