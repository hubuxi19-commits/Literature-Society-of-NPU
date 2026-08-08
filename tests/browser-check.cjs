const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  inspectPng,
  resolveBrowserBaseUrl,
} = require("./browser-harness.cjs");

const baseUrl = resolveBrowserBaseUrl(process.env.BROWSER_CHECK_BASE_URL);
const screenshots = path.resolve(__dirname, "..", "screenshots");
const demoConfigModule = `export const config = {
  mode: "demo",
  supabaseUrl: "",
  supabaseAnonKey: "",
};\n`;

async function useDemoConfig(page) {
  await page.route(`${baseUrl}/js/config.mjs`, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: demoConfigModule,
    }),
  );
}

async function expectVisible(locator, label) {
  await locator.waitFor({ state: "visible" });
  if (!(await locator.isVisible())) throw new Error(`${label}不可见`);
}

async function expectNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth) {
    throw new Error(
      `${label}存在横向溢出：${dimensions.scrollWidth} > ${dimensions.clientWidth}`,
    );
  }
}

function readPngDimensions(filePath) {
  return inspectPng(readFileSync(filePath));
}

async function dispatchTouchSwipe(card, startX, endX) {
  await card.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: startX, clientY: 360 }],
    changedTouches: [{ identifier: 1, clientX: startX, clientY: 360 }],
  });
  await card.dispatchEvent("touchmove", {
    touches: [{ identifier: 1, clientX: endX, clientY: 366 }],
    changedTouches: [{ identifier: 1, clientX: endX, clientY: 366 }],
  });
  await card.dispatchEvent("touchend", {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: endX, clientY: 366 }],
  });
}

async function goToHash(page, hash, headingName) {
  await page.evaluate((nextHash) => {
    window.location.hash = nextHash;
  }, hash);
  await page.getByRole("heading", { name: headingName, exact: true }).waitFor();
}

async function login(page, studentNumber, password) {
  const accountButton = page.locator("#accountButton");
  await accountButton.click();
  await expectVisible(page.locator("#authDialog"), "登录窗口");
  await page.locator('#loginForm [name="studentNumber"]').fill(studentNumber);
  await page.locator('#loginForm [name="password"]').fill(password);
  await page.getByRole("button", { name: "登录并继续" }).click();
  await page.locator("#authDialog").waitFor({ state: "hidden" });
}

async function desktopFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
  });

  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");
  await expectVisible(
    page.getByRole("heading", { name: "让作品被读见" }),
    "首页标题",
  );
  await expectVisible(page.getByTestId("work-list"), "新作流");
  await expectNoHorizontalOverflow(page, "桌面首页");
  const homeText = await page.locator("body").innerText();
  if (/季刊|本期主题|封面作品/.test(homeText)) {
    throw new Error("首页仍包含刊期或封面语义");
  }

  const homeScreenshot = await page.screenshot({ fullPage: true });

  const categorySelect = page.getByRole("combobox", { name: "按分类筛选" });
  const categoryOptions = await categorySelect.locator("option").allTextContents();
  if (!categoryOptions.includes("新诗") || !categoryOptions.includes("旧诗")) {
    throw new Error(`桌面分类缺少新诗或旧诗：${categoryOptions.join("、")}`);
  }
  if (categoryOptions.includes("诗歌")) {
    throw new Error("桌面分类仍包含旧的诗歌选项");
  }

  const search = page.getByRole("textbox", { name: "搜索作品" });
  await search.fill("河流");
  await page.waitForTimeout(450);
  const workList = page.getByTestId("work-list");
  await expectVisible(
    workList.getByText("河流向北", { exact: true }),
    "防抖搜索结果",
  );
  if (
    await workList.getByText("末班车经过友谊校区", { exact: true }).count()
  ) {
    throw new Error("防抖搜索没有过滤无关作品");
  }
  await search.fill("");
  await page.waitForTimeout(450);
  const loadMore = page.getByRole("button", { name: "再读十篇" });
  const hasLoadMore = (await loadMore.count()) > 0;
  if (!hasLoadMore) {
    throw new Error("桌面首页没有再读十篇按钮");
  }
  const rowsBeforeCount = await workList.locator(".work-row").count();
  await loadMore.click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".work-row").length > count,
    rowsBeforeCount,
  );
  if ((await workList.locator(".work-row").count()) !== 12) {
    throw new Error("再读十篇后列表条目不是 12");
  }
  await categorySelect.selectOption("小说");
  await expectVisible(
    workList.getByText("没有名字的车站", { exact: true }),
    "小说分类结果",
  );
  if (await workList.getByText("河流向北", { exact: true }).count()) {
    throw new Error("分类没有过滤散文");
  }
  await categorySelect.selectOption("全部");

  await page
    .getByRole("link", { name: "末班车经过友谊校区", exact: true })
    .first()
    .click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  await page.locator(".reading-title h1").waitFor();
  if ((await page.locator(".reading-title h1").textContent()) !== "末班车经过友谊校区") {
    throw new Error("作品阅读页标题不正确");
  }
  const poetryBody = page.locator(".reading-body--poetry");
  await expectVisible(poetryBody, "诗歌正文");
  const poetryFirstStanza = poetryBody.locator("p").first();
  if (!(await poetryFirstStanza.textContent()).includes("\n")) {
    throw new Error("测试诗歌没有保留作者输入的单次换行");
  }
  if (
    (await poetryFirstStanza.evaluate(
      (node) => getComputedStyle(node).whiteSpace,
    )) !== "pre-line"
  ) {
    throw new Error("诗歌正文没有保留单次换行");
  }
  if (
    (await poetryFirstStanza.evaluate(
      (node) => getComputedStyle(node).textIndent,
    )) !== "0px"
  ) {
    throw new Error("诗歌正文不应首行缩进");
  }
  if (
    (await poetryFirstStanza.evaluate((node) =>
      getComputedStyle(node, "::first-letter").getPropertyValue("float"),
    )) !== "none"
  ) {
    throw new Error("诗歌首字不应浮动放大");
  }
  if ((await page.locator(".reading-body--poetry").count()) !== 1) {
    throw new Error("新诗没有使用诗歌阅读排版");
  }
  await expectNoHorizontalOverflow(page, "桌面阅读页");
  const versionsEntry = page.getByRole("link", { name: "查看历史版本" });
  await expectVisible(versionsEntry, "阅读页历史版本入口");
  if (
    (await versionsEntry.getAttribute("href")) !==
    "#/works/work-night-bus/versions"
  ) {
    throw new Error("历史版本入口链接指向错误");
  }
  await goToHash(page, "#/works/work-night-bus/versions", "历史版本");
  const versionCards = page.locator(".version-card");
  if ((await versionCards.count()) < 1) {
    throw new Error("历史版本页没有展示任何版本");
  }
  const firstVersionCard = versionCards.first();
  await expectVisible(firstVersionCard, "历史版本卡片");
  const firstCardText = (await firstVersionCard.textContent()) ?? "";
  if (!/^第 \d+ 版/.test(firstCardText.trim())) {
    throw new Error("历史版本页第一个版本卡片没有版本号");
  }
  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区");
  const readingScreenshot = await page.screenshot({ fullPage: true });

  await goToHash(page, "#/works/work-library-rain", "雨落在图书馆闭馆以后");
  await expectVisible(page.locator(".reading-body--poetry"), "旧诗正文");

  await goToHash(page, "#/works/work-unnamed-station", "没有名字的车站");
  const proseBody = page.locator(".reading-body--prose");
  await expectVisible(proseBody, "小说正文");
  if (
    (await proseBody.locator("p").first().evaluate((node) =>
      getComputedStyle(node, "::first-letter").getPropertyValue("float"),
    )) !== "left"
  ) {
    throw new Error("小说应保留首字装饰");
  }

  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区");
  await login(page, "2023123456", "wenyuan88");
  const likeButton = page.getByRole("button", { name: /喜欢这篇作品|取消喜欢/ });
  const beforeCount = Number(
    await likeButton.locator("[data-like-count]").textContent(),
  );
  await likeButton.click();
  await page.waitForFunction(
    ({ selector, count }) =>
      Number(document.querySelector(selector)?.textContent) !== count,
    {
      selector: "[data-like-count]",
      count: beforeCount,
    },
  );

  const commentText = "自动化测试留下的一条具体评论";
  await page.locator('[data-comment-form] textarea').fill(commentText);
  await page.getByRole("button", { name: "发表评论" }).click();
  await expectVisible(page.getByText(commentText, { exact: true }), "新评论");

  await page.getByRole("button", { name: "回复" }).first().click();
  const visibleReplyForm = page.locator("[data-reply-form]:visible").first();
  await visibleReplyForm.locator("textarea").fill("回复也应保留上下文");
  await visibleReplyForm.getByRole("button", { name: "发表回复" }).click();
  await expectVisible(
    page.getByText("回复也应保留上下文", { exact: true }),
    "新回复",
  );

  // 选区批注：选中正文第一行，浮动入口出现，提交后批注计数 +1 且原文与正文一致。
  await page.evaluate(() => {
    const body = document.querySelector("[data-annotatable]");
    if (!body) throw new Error("阅读页缺少可批注正文");
    const firstPara = body.querySelector("p");
    const textNode = firstPara?.firstChild;
    if (!firstPara || !textNode) throw new Error("阅读页正文缺少段落文本节点");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 11);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    firstPara.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
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
  page.once("dialog", (dialog) => dialog.accept("自动化批注"));
  await page.evaluate(() => document.querySelector(".annotate-float").click());
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

  await page.getByRole("button", { name: "修改作品" }).click();
  await page.waitForURL(/#\/works\/work-night-bus\/edit$/);
  await page
    .getByRole("heading", { name: "修改作品", exact: true })
    .waitFor();
  const editTitleInput = page.locator('#writingForm [name="title"]');
  if ((await editTitleInput.inputValue()) !== "末班车经过友谊校区") {
    throw new Error("编辑台没有预填作品原标题");
  }
  const changeSummaryInput = page.locator(
    '#writingForm [name="changeSummary"]',
  );
  await expectVisible(changeSummaryInput, "修改说明输入框");
  if ((await changeSummaryInput.getAttribute("required")) === null) {
    throw new Error("修改说明没有标记为必填");
  }
  await editTitleInput.fill("末班车经过友谊校区（修订）");
  await changeSummaryInput.fill("补充第三段");
  await page.getByRole("button", { name: "保存新版本" }).click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  if (
    (await page.locator(".reading-title h1").textContent()) !==
    "末班车经过友谊校区（修订）"
  ) {
    throw new Error("保存新版本后阅读页标题没有更新");
  }
  await page.locator("#toast").waitFor({ state: "visible" });
  if ((await page.locator("#toast").textContent()) !== "版本已保存。") {
    throw new Error("保存新版本后没有出现版本已保存提示");
  }
  await goToHash(page, "#/works/work-night-bus/versions", "历史版本");
  const editedVersionCards = page.locator(".version-card");
  if ((await editedVersionCards.count()) < 2) {
    throw new Error("保存新版本后历史版本页没有新增版本");
  }
  const editedFirstCardText =
    (await editedVersionCards.first().textContent()) ?? "";
  if (!/^第 \d+ 版/.test(editedFirstCardText.trim())) {
    throw new Error("保存新版本后第一个版本卡片没有版本号");
  }
  await goToHash(page, "#/works/work-night-bus", "末班车经过友谊校区（修订）");

  // 废弃编辑不应把既有作品内容写进新作草稿（编辑模式仅统计字数，不持久化 DRAFT_KEY）
  await goToHash(page, "#/works/work-night-bus/edit", "修改作品");
  const abandonedEditTitle = page.locator('#writingForm [name="title"]');
  await abandonedEditTitle.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("X");
  await goToHash(page, "#/write", "写一篇新作");
  if ((await page.locator('#writingForm [name="title"]').inputValue()) !== "") {
    throw new Error("废弃编辑把既有作品内容恢复成了新作草稿");
  }

  await goToHash(page, "#/write", "写一篇新作");
  const writingCategory = page.locator('#writingForm [name="category"]');
  if ((await writingCategory.inputValue()) !== "新诗") {
    throw new Error("写作表单没有默认选择新诗");
  }
  await writingCategory.selectOption("散文");
  await page.locator('#writingForm [name="title"]').fill("浏览器里的新作");
  await page
    .locator('#writingForm [name="excerpt"]')
    .fill("用于验证发布路径的摘要");
  const publishedParagraphs = Array.from(
    { length: 32 },
    (_, index) =>
      `第${index + 1}段写在浏览器里。\n这一行用于验证段内换行不会在图片导出时变成空格。`,
  );
  const publishedContent = publishedParagraphs.join("\n\n");
  await page.locator('#writingForm [name="content"]').fill(publishedContent);
  await page.getByRole("button", { name: "发布作品" }).click();
  await page
    .getByRole("heading", { name: "浏览器里的新作", exact: true })
    .waitFor();
  await expectVisible(page.getByRole("button", { name: "删除作品" }), "作者删除入口");
  if (await page.getByRole("button", { name: /设为推荐|取消推荐/ }).count()) {
    throw new Error("普通成员看到了管理员推荐入口");
  }

  await page.evaluate(() => {
    const probe = {
      anchorClicks: 0,
      createdUrls: [],
      revokedUrls: [],
      layoutSamples: [],
      renderedUnits: [],
    };
    window.__exportProbe = probe;

    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function probedAnchorClick() {
      probe.anchorClicks += 1;
      return originalAnchorClick.call(this);
    };

    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = originalCreateObjectUrl(object);
      probe.createdUrls.push(url);
      return url;
    };
    const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      probe.revokedUrls.push(url);
      return originalRevokeObjectUrl(url);
    };

    const originalRemove = Element.prototype.remove;
    Element.prototype.remove = function probedRemove() {
      if (this.matches?.(".export-render-root")) {
        this.querySelectorAll(".export-page").forEach((exportPage) => {
          const body = exportPage.querySelector(".export-body");
          const wordmark = exportPage.querySelector(".export-wordmark");
          const bodyRect = body.getBoundingClientRect();
          const wordmarkRect = wordmark.getBoundingClientRect();
          const style = getComputedStyle(wordmark);
          probe.layoutSamples.push({
            hasTitle: Boolean(exportPage.querySelector(".export-title")),
            pageScrollHeight: exportPage.scrollHeight,
            pageClientHeight: exportPage.clientHeight,
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            bodyRect: {
              top: bodyRect.top,
              right: bodyRect.right,
              bottom: bodyRect.bottom,
              left: bodyRect.left,
            },
            wordmarkRect: {
              top: wordmarkRect.top,
              right: wordmarkRect.right,
              bottom: wordmarkRect.bottom,
              left: wordmarkRect.left,
              width: wordmarkRect.width,
              height: wordmarkRect.height,
            },
            wordmarkVisible:
              wordmark.complete &&
              wordmark.naturalWidth > 0 &&
              wordmarkRect.width > 0 &&
              wordmarkRect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden",
          });
          body.querySelectorAll(".export-paragraph, .export-space").forEach((unit) => {
            probe.renderedUnits.push({
              className: unit.className,
              text: unit.textContent,
            });
          });
        });
      }
      return originalRemove.call(this);
    };
  });

  let firstClickDownloads = 0;
  const recordFirstClickDownload = () => {
    firstClickDownloads += 1;
  };
  page.on("download", recordFirstClickDownload);
  await page.getByRole("button", { name: "生成作品图片" }).click();
  const exportPanel = page.getByRole("region", { name: "分享或保存作品图片" });
  await exportPanel.waitFor({ state: "visible", timeout: 30000 });
  page.off("download", recordFirstClickDownload);
  if (firstClickDownloads !== 0) {
    throw new Error("第一次生成点击错误触发了系统下载");
  }

  const pageCount = Number(
    (await exportPanel.getByRole("heading").textContent()).match(/(\d+)\s*页/)?.[1],
  );
  if (!Number.isInteger(pageCount) || pageCount < 2) {
    throw new Error(`长文没有生成多页图片：${pageCount}`);
  }
  const perPageButtons = exportPanel.getByRole("button", { name: /^保存第 \d+ 页$/ });
  if ((await perPageButtons.count()) !== pageCount) {
    throw new Error("多页导出没有为每一页提供保存按钮");
  }
  const perPageLabels = await perPageButtons.allTextContents();
  perPageLabels.forEach((label, index) => {
    if (label !== `保存第 ${index + 1} 页`) {
      throw new Error(`逐页保存按钮文案错误：${label}`);
    }
  });

  const previews = exportPanel.locator(".export-preview-image");
  if ((await previews.count()) !== pageCount) {
    throw new Error("导出结果没有为每一页显示图片预览");
  }
  await previews.first().waitFor({ state: "visible" });
  const previewMetrics = await previews.evaluateAll((images) =>
    images.map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
    }),
  );
  previewMetrics.forEach((metric, index) => {
    if (Math.abs(metric.width / metric.height - 1080 / 1920) > 0.01) {
      throw new Error(`第 ${index + 1} 页预览比例不是 1080×1920`);
    }
    if (metric.naturalWidth !== 1080 || metric.naturalHeight !== 1920) {
      throw new Error(`第 ${index + 1} 页预览图片尺寸错误`);
    }
  });
  const generationProbe = await page.evaluate(() => ({
    anchorClicks: window.__exportProbe.anchorClicks,
    createdUrls: [...window.__exportProbe.createdUrls],
    revokedUrls: [...window.__exportProbe.revokedUrls],
    renderRoots: document.querySelectorAll(".export-render-root").length,
    layoutSamples: window.__exportProbe.layoutSamples,
    renderedUnits: window.__exportProbe.renderedUnits,
  }));
  if (generationProbe.anchorClicks !== 0) {
    throw new Error("图片生成阶段调用了下载锚点");
  }
  if (generationProbe.renderRoots !== 0) {
    throw new Error("图片生成后没有清理离屏导出节点");
  }
  if (generationProbe.layoutSamples.length !== pageCount) {
    throw new Error("没有测量每一页的正文与标识布局");
  }
  generationProbe.layoutSamples.forEach((sample, index) => {
    const { bodyRect, wordmarkRect } = sample;
    if (sample.pageScrollHeight > sample.pageClientHeight) {
      throw new Error(`第 ${index + 1} 页导出画布发生纵向溢出`);
    }
    if (sample.bodyScrollHeight > sample.bodyClientHeight) {
      throw new Error(`第 ${index + 1} 页导出正文发生纵向溢出`);
    }
    const intersects = !(
      wordmarkRect.left >= bodyRect.right ||
      wordmarkRect.right <= bodyRect.left ||
      wordmarkRect.top >= bodyRect.bottom ||
      wordmarkRect.bottom <= bodyRect.top
    );
    if (!sample.wordmarkVisible) {
      throw new Error(`第 ${index + 1} 页文学社标识不可见`);
    }
    if (intersects) {
      throw new Error(`第 ${index + 1} 页文学社标识与正文区域重叠`);
    }
  });
  if (!generationProbe.layoutSamples[0]?.hasTitle) {
    throw new Error("导出第一页缺少作品标题");
  }
  if (generationProbe.layoutSamples.slice(1).some((sample) => sample.hasTitle)) {
    throw new Error("导出续页不应重复显示作品标题");
  }
  if (generationProbe.createdUrls.length !== pageCount) {
    throw new Error("首次生成没有为每页创建可撤销的预览 URL");
  }
  if (generationProbe.revokedUrls.length !== 0) {
    throw new Error("仍在显示的预览 URL 被提前撤销");
  }
  assert.deepEqual(
    generationProbe.renderedUnits
      .filter((unit) => unit.className === "export-paragraph")
      .map((unit) => unit.text),
    publishedParagraphs,
  );

  const firstPreviewUrls = generationProbe.createdUrls;
  await page.getByRole("button", { name: "生成作品图片" }).click();
  await page.waitForFunction(
    (minimum) => window.__exportProbe.createdUrls.length >= minimum,
    pageCount * 2,
    { timeout: 30000 },
  );
  const regenerationProbe = await page.evaluate((firstUrls) => ({
    createdUrls: [...window.__exportProbe.createdUrls],
    revokedFirstPreviewUrls: firstUrls.every((url) =>
      window.__exportProbe.revokedUrls.includes(url),
    ),
  }), firstPreviewUrls);
  if (!regenerationProbe.revokedFirstPreviewUrls) {
    throw new Error("重新生成前没有撤销上一批预览 URL");
  }
  const currentPreviewUrls = regenerationProbe.createdUrls.slice(-pageCount);

  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await perPageButtons.first().click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const dimensions = readPngDimensions(downloadPath);
  if (dimensions.width !== 1080 || dimensions.height !== 1920) {
    throw new Error(`导出尺寸错误：${dimensions.width}×${dimensions.height}`);
  }
  if (!download.suggestedFilename().endsWith("-01.png")) {
    throw new Error(`多页文件名缺少页码：${download.suggestedFilename()}`);
  }
  const deliveryProbe = await page.evaluate(() => ({
    anchorClicks: window.__exportProbe.anchorClicks,
    createdUrls: window.__exportProbe.createdUrls,
    revokedUrls: window.__exportProbe.revokedUrls,
    temporaryAnchors: document.querySelectorAll("a[download]").length,
  }));
  if (deliveryProbe.anchorClicks !== 1) {
    throw new Error("第二次明确点击没有同步调用下载锚点");
  }
  const downloadUrl = deliveryProbe.createdUrls.at(-1);
  if (!downloadUrl || !deliveryProbe.revokedUrls.includes(downloadUrl)) {
    throw new Error("下载完成后没有撤销临时 Blob URL");
  }
  if (deliveryProbe.temporaryAnchors !== 0) {
    throw new Error("下载完成后没有移除临时锚点");
  }

  await goToHash(page, "#/works/work-river", "河流向北");
  const routeCleanupProbe = await page.evaluate((previewUrls) => ({
    previewsRemaining: document.querySelectorAll(".export-preview-image").length,
    allRevoked: previewUrls.every((url) =>
      window.__exportProbe.revokedUrls.includes(url),
    ),
  }), currentPreviewUrls);
  if (routeCleanupProbe.previewsRemaining !== 0 || !routeCleanupProbe.allRevoked) {
    throw new Error("切换作品路由后没有清理预览 URL 和预览节点");
  }
  if (await page.getByRole("button", { name: "删除作品" }).count()) {
    throw new Error("普通成员看到了他人作品删除入口");
  }

  await goToHash(page, "#/authors/profile-pine", "松声");
  if (await page.locator("#profileForm").count()) {
    throw new Error("个人主页直接展示了资料表单");
  }
  await page.getByRole("button", { name: "编辑资料" }).click();
  await expectVisible(page.locator("#profileDialog"), "编辑资料窗口");
  const profileForm = page.locator("#profileForm");
  await expectVisible(profileForm, "编辑资料表单");
  const penNameInput = profileForm.locator('input[name="penName"]');
  await expectVisible(penNameInput, "笔名输入框");
  if (await penNameInput.isDisabled()) throw new Error("首次笔名修改被错误锁定");
  await expectVisible(profileForm.locator('textarea[name="bio"]'), "简介输入框");
  await penNameInput.fill("听松");
  await profileForm.getByRole("button", { name: "保存公开资料" }).click();
  await page.getByRole("heading", { name: "听松", exact: true }).waitFor();
  await page.locator("#profileDialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "编辑资料" }).click();
  const lockedPenNameInput = page.locator('#profileForm input[name="penName"]');
  await expectVisible(lockedPenNameInput, "冷却中的笔名输入框");
  if (!(await lockedPenNameInput.isDisabled())) {
    throw new Error("修改笔名后没有进入七天冷却");
  }
  if ((await page.locator("#accountButton").textContent()) !== "听松") {
    throw new Error("修改笔名后顶部账户名没有同步");
  }
  const profileText = await page.locator("main").innerText();
  if (/20\d{8}/.test(profileText)) {
    throw new Error("作者主页展示了完整学号");
  }

  await goToHash(page, "#/discussions", "正在讨论");
  await expectVisible(page.locator(".discussion-page-list"), "讨论聚合列表");
  await goToHash(page, "#/submissions", "长期征稿");
  await expectVisible(
    page.getByRole("heading", { name: "公开信息边界" }),
    "隐私说明",
  );

  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "2023000001", "editor88");
  await goToHash(page, "#/works/work-river", "河流向北");
  await expectVisible(
    page.getByRole("button", { name: "取消推荐" }),
    "管理员推荐入口",
  );
  await expectVisible(page.getByRole("button", { name: "删除作品" }), "管理员删除入口");

  await context.close();
  return { homeScreenshot, readingScreenshot };
}

async function mobileFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`mobile console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`mobile pageerror: ${error.message}`);
  });
  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: "让作品被读见" }).waitFor();
  const mobileCard = page.locator("[data-mobile-work-card]");
  await expectVisible(mobileCard, "移动端单篇作品卡片");
  if ((await mobileCard.count()) !== 1) {
    throw new Error("390×844 移动首页没有且仅有一张作品卡片");
  }
  const bottomNavigation = page.locator(".mobile-bottom-nav");
  await expectVisible(bottomNavigation, "移动端底部导航");
  const bottomLinks = bottomNavigation.locator("a");
  assert.deepEqual(await bottomLinks.allTextContents(), ["翻阅", "讨论", "写作", "我的"]);
  assert.deepEqual(
    await bottomLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    ["#/", "#/discussions", "#/write", "#/"],
  );

  const categoryStrip = page.getByRole("navigation", { name: "作品分类" });
  await expectVisible(categoryStrip, "移动端横向分类栏");
  const categoryButtons = categoryStrip.locator("button");
  assert.deepEqual(await categoryButtons.allTextContents(), [
    "全部",
    "新诗",
    "旧诗",
    "散文",
    "小说",
    "随笔",
    "其他",
  ]);
  const categoryScroll = await categoryStrip.evaluate((strip) => ({
    scrollWidth: strip.scrollWidth,
    clientWidth: strip.clientWidth,
  }));
  if (categoryScroll.scrollWidth <= categoryScroll.clientWidth) {
    throw new Error("390×844 移动分类栏不能横向滚动");
  }
  if (await page.locator('.mobile-home select[name="sort"]').count()) {
    throw new Error("移动首页仍显示会误导用户的排序控件");
  }

  const firstWorkId = await mobileCard.getAttribute("data-work-id");
  const authorKeyResult = await mobileCard
    .locator(".mobile-work-byline a")
    .evaluate((authorLink) => {
      const before = window.location.hash;
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      authorLink.dispatchEvent(event);
      return {
        before,
        after: window.location.hash,
        defaultPrevented: event.defaultPrevented,
      };
    });
  if (
    authorKeyResult.after !== authorKeyResult.before ||
    authorKeyResult.defaultPrevented
  ) {
    throw new Error("作品卡片劫持了作者链接的键盘事件");
  }

  const startHash = new URL(page.url()).hash;
  await dispatchTouchSwipe(mobileCard, 70, 180);
  await mobileCard.locator(".mobile-work-copy").click();
  if (new URL(page.url()).hash !== startHash) {
    throw new Error("队列起点的右滑没有消费随后产生的点击");
  }

  await dispatchTouchSwipe(mobileCard, 320, 220);
  await page.waitForFunction(
    (workId) =>
      document.querySelector("[data-mobile-work-card]")?.dataset.workId !== workId,
    firstWorkId,
  );
  const nextWorkId = await mobileCard.getAttribute("data-work-id");
  if (!nextWorkId || nextWorkId === firstWorkId) {
    throw new Error("向左滑动没有进入下一篇作品");
  }
  await mobileCard.locator(".mobile-work-copy").click();
  if (new URL(page.url()).hash !== startHash) {
    throw new Error("成功左滑后没有消费随后产生的点击");
  }

  await dispatchTouchSwipe(mobileCard, 70, 170);
  await page.waitForFunction(
    (workId) =>
      document.querySelector("[data-mobile-work-card]")?.dataset.workId === workId,
    firstWorkId,
  );
  if ((await mobileCard.getAttribute("data-work-id")) !== firstWorkId) {
    throw new Error("向右滑动没有返回上一篇作品");
  }
  await mobileCard.locator(".mobile-work-copy").click();
  if (new URL(page.url()).hash !== startHash) {
    throw new Error("成功右滑后没有消费随后产生的点击");
  }

  await mobileCard.dispatchEvent("touchstart", {
    touches: [{ identifier: 2, clientX: 320, clientY: 360 }],
  });
  await mobileCard.dispatchEvent("touchcancel", {
    touches: [],
    changedTouches: [{ identifier: 2, clientX: 210, clientY: 362 }],
  });
  await mobileCard.dispatchEvent("touchend", {
    touches: [],
    changedTouches: [{ identifier: 2, clientX: 210, clientY: 362 }],
  });
  if ((await mobileCard.getAttribute("data-work-id")) !== firstWorkId) {
    throw new Error("touchcancel 后仍错误切换了作品");
  }

  await dispatchTouchSwipe(mobileCard, 320, 210);
  await page.waitForFunction(
    (workId) =>
      document.querySelector("[data-mobile-work-card]")?.dataset.workId !== workId,
    firstWorkId,
  );
  const workAfterSwipeWithoutClick = await mobileCard.getAttribute("data-work-id");
  await mobileCard.locator(".mobile-work-copy").tap();
  await page.waitForURL(
    new RegExp(`#\\/works\\/${workAfterSwipeWithoutClick}$`),
  );
  await page.goBack();
  await page.waitForURL(/#\/$|\/$/);
  await expectVisible(
    page.locator("[data-mobile-work-card]"),
    "无合成点击滑动后的返回首页",
  );

  await categoryButtons.filter({ hasText: /^散文$/ }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".mobile-work-category span")?.textContent === "散文",
  );
  const resetPrevious = page.getByRole("button", { name: "← 上一篇" });
  if (!(await resetPrevious.isDisabled())) {
    throw new Error("切换移动分类后没有把作品队列重置到起点");
  }
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.mobile-category-strip button[aria-pressed="true"]')
        ?.textContent === "全部",
  );

  let endNextButton = page.getByRole("button", { name: "下一篇 →" });
  let safety = 0;
  while (!(await endNextButton.isDisabled()) && safety < 20) {
    const beforeId = await mobileCard.getAttribute("data-work-id");
    await endNextButton.click();
    await page.waitForFunction(
      (workId) =>
        document.querySelector("[data-mobile-work-card]")?.dataset.workId !== workId,
      beforeId,
    );
    endNextButton = page.getByRole("button", { name: "下一篇 →" });
    safety += 1;
  }
  if (!(await endNextButton.isDisabled())) {
    throw new Error("移动作品队列没有在预期范围内到达末篇");
  }
  const prefetchedCount = await page.evaluate(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("wenyuan-home-session"));
      return Array.isArray(saved?.works) ? saved.works.length : 0;
    } catch {
      return 0;
    }
  });
  if (prefetchedCount <= 10) {
    throw new Error(`移动队列接近末尾时没有预取下一批：${prefetchedCount}`);
  }
  const lastWorkId = await mobileCard.getAttribute("data-work-id");
  await dispatchTouchSwipe(mobileCard, 320, 210);
  await mobileCard.locator(".mobile-work-copy").click();
  if (
    new URL(page.url()).hash !== startHash ||
    (await mobileCard.getAttribute("data-work-id")) !== lastWorkId
  ) {
    throw new Error("队列末篇的左滑没有消费点击或错误改变了作品");
  }
  let startPreviousButton = page.getByRole("button", { name: "← 上一篇" });
  while (!(await startPreviousButton.isDisabled())) {
    await startPreviousButton.click();
    startPreviousButton = page.getByRole("button", { name: "← 上一篇" });
  }

  const navigationWorkId = await mobileCard.getAttribute("data-work-id");
  await mobileCard.locator(".mobile-work-copy").click();
  await page.waitForURL(new RegExp(`#\\/works\\/${navigationWorkId}$`));
  await page.goBack();
  await page.waitForURL(/#\/$|\/$/);
  await expectVisible(page.locator("[data-mobile-work-card]"), "返回后的移动作品卡片");

  const previousButton = page.getByRole("button", { name: "← 上一篇" });
  const nextButton = page.getByRole("button", { name: "下一篇 →" });
  if (!(await previousButton.isDisabled())) {
    throw new Error("移动作品队列起点没有禁用上一篇");
  }
  if ((await previousButton.getAttribute("aria-disabled")) !== "true") {
    throw new Error("移动作品队列起点缺少 aria-disabled");
  }
  if (await nextButton.isDisabled()) {
    throw new Error("移动作品队列起点错误禁用了下一篇");
  }

  await page.setViewportSize({ width: 900, height: 844 });
  await expectVisible(page.locator(".desktop-home"), "跨断点后的桌面首页");
  if (await page.locator(".mobile-home").count()) {
    throw new Error("跨过 760px 后仍显示移动首页");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisible(
    page.locator("[data-mobile-work-card]"),
    "返回移动断点后的作品卡片",
  );
  await expectNoHorizontalOverflow(page, "移动首页");
  await expectVisible(page.getByRole("button", { name: /菜单/ }), "移动菜单按钮");
  await page.getByRole("button", { name: /菜单/ }).click();
  await expectVisible(
    page.locator(".primary-nav").getByRole("link", { name: "讨论", exact: true }),
    "移动端讨论导航",
  );
  const homeScreenshot = await page.screenshot({ fullPage: true });
  await page
    .getByRole("link", { name: "末班车经过友谊校区", exact: true })
    .first()
    .click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  await page.locator(".reading-title h1").waitFor();
  await page.setViewportSize({ width: 900, height: 844 });
  await page.waitForFunction(
    () => !window.matchMedia("(max-width: 760px)").matches,
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  );
  if (await page.locator(".desktop-home").count()) {
    throw new Error("非首页跨断点时错误重绘了首页");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  await expectVisible(page.locator(".reading-body--poetry"), "移动端诗歌正文");
  await expectNoHorizontalOverflow(page, "移动阅读页");
  const readingScreenshot = await page.screenshot({ fullPage: true });
  await context.close();
  return { homeScreenshot, readingScreenshot };
}

async function mobileProfileAuthFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`profile auth console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`profile auth pageerror: ${error.message}`);
  });

  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");
  const profileDestination = page
    .getByRole("navigation", { name: "移动端主要导航" })
    .getByRole("link", { name: "我的", exact: true });
  await profileDestination.click();
  await expectVisible(page.locator("#authDialog"), "我的登录窗口");
  await page.locator('#loginForm [name="studentNumber"]').fill("2023123456");
  await page.locator('#loginForm [name="password"]').fill("wenyuan88");
  await page.getByRole("button", { name: "登录并继续" }).click();
  await page.waitForURL(/#\/authors\/profile-pine$/);
  await page.getByRole("heading", { name: "松声", exact: true }).waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });

  const loggedInProfileHref = await profileDestination.getAttribute("href");
  if (new URL(loggedInProfileHref).hash !== "#/authors/profile-pine") {
    throw new Error(
      `登录后移动端“我的”没有指向当前用户主页：${loggedInProfileHref}`,
    );
  }

  await page
    .getByRole("navigation", { name: "移动端主要导航" })
    .getByRole("link", { name: "翻阅", exact: true })
    .click();
  await page.getByRole("heading", { name: "让作品被读见" }).waitFor();
  await profileDestination.click();
  await page.waitForURL(/#\/authors\/profile-pine$/);
  if (await page.locator("#authDialog").evaluate((dialog) => dialog.open)) {
    throw new Error("已登录用户点击“我的”时仍打开登录窗口");
  }

  await context.close();
}

async function accountSecurityFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await useDemoConfig(page);
  page.setDefaultTimeout(8000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`account security console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`account security pageerror: ${error.message}`);
  });

  await page.goto(baseUrl);
  await page.waitForLoadState("networkidle");

  // 5. 已验证成员：账号安全页只显示掩码邮箱，不显示完整邮箱。
  await login(page, "2023123456", "wenyuan88");
  await goToHash(page, "#/account/security", "账号安全");
  await expectVisible(page.locator('[data-masked-email="true"]'), "掩码邮箱");
  const verifiedSecurityText = await page.locator("main").innerText();
  if (!verifiedSecurityText.includes("s***g@e***e.com")) {
    throw new Error("账号安全页没有显示掩码邮箱");
  }
  if (/song@example\.com/.test(verifiedSecurityText)) {
    throw new Error("账号安全页泄露了完整找回邮箱");
  }

  // 1. 已验证成员仍可发布新作。
  await goToHash(page, "#/write", "写一篇新作");
  await page.locator('#writingForm [name="title"]').fill("安全验证后的新作");
  await page
    .locator('#writingForm [name="content"]')
    .fill("验证找回邮箱后继续写作的正文。");
  await page.getByRole("button", { name: "发布作品" }).click();
  await page.waitForURL(/#\/works\//);
  await page
    .getByRole("heading", { name: "安全验证后的新作", exact: true })
    .waitFor();

  await page.locator("#accountButton").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await goToHash(page, "#/", "让作品被读见");

  // 4. 密码找回对已知与未知学号返回相同文案。
  const requestCodeNote = async (studentNumber) => {
    await page.locator("#accountButton").click();
    await expectVisible(page.locator("#authDialog"), "登录窗口");
    await page.getByRole("button", { name: "忘记密码？" }).click();
    await expectVisible(page.locator("#recoveryDialog"), "找回密码窗口");
    await page
      .locator('#recoveryRequestForm [name="studentNumber"]')
      .fill(studentNumber);
    await page.getByRole("button", { name: "发送验证码" }).click();
    await expectVisible(page.locator("#recoveryCompleteForm"), "重设密码表单");
    const note = await page
      .locator('[data-form-message="recovery-complete"]')
      .textContent();
    await page
      .locator("#recoveryDialog")
      .getByRole("button", { name: "关闭找回密码窗口" })
      .click();
    await page.locator("#recoveryDialog").waitFor({ state: "hidden" });
    return note;
  };
  const knownNote = await requestCodeNote("2023123456");
  const unknownNote = await requestCodeNote("2099999999");
  if (knownNote !== unknownNote) {
    throw new Error(
      `已知与未知学号的找回文案不一致：${knownNote} vs ${unknownNote}`,
    );
  }
  if (!knownNote.includes("如果账号存在且已绑定邮箱")) {
    throw new Error(`找回文案不是枚举安全文案：${knownNote}`);
  }

  // 2. 新成员带找回邮箱注册：注册后直接落在账号安全页，看到合并绑定表单
  //    （找回邮箱与验证码在同一张表单）。
  await page.locator("#accountButton").click();
  await expectVisible(page.locator("#authDialog"), "登录窗口");
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('#registerForm [name="studentNumber"]').fill("2024777777");
  await page.locator('#registerForm [name="penName"]').fill("青苔");
  await page.locator('#registerForm [name="password"]').fill("moss8088");
  await page
    .locator('#registerForm [name="recoveryEmail"]')
    .fill("moss@example.com");
  await page.getByRole("button", { name: "注册并进入" }).click();
  await page.locator("#authDialog").waitFor({ state: "hidden" });
  await expectVisible(
    page.getByRole("heading", { name: "账号安全" }),
    "带找回邮箱注册后直接进入账号安全页",
  );
  const bindForm = page.locator("#bindRecoveryForm");
  await expectVisible(bindForm, "合并绑定表单");
  await expectVisible(bindForm.locator('[name="recoveryEmail"]'), "合并表单找回邮箱输入");
  const prefilledEmail = await bindForm
    .locator('[name="recoveryEmail"]')
    .inputValue();
  if (prefilledEmail !== "moss@example.com") {
    throw new Error(`合并表单没有预填注册邮箱：${prefilledEmail}`);
  }
  await expectVisible(bindForm.locator('[name="code"]'), "合并表单验证码输入");

  // 3. 顶部账号菜单提供"账号安全"入口。
  await page.locator("#accountButton").click();
  await expectVisible(page.locator("#accountMenu"), "账号下拉菜单");
  await expectVisible(
    page.locator('#accountMenu a[href="#/account/security"]'),
    "账号菜单账号安全入口",
  );
  await page.locator("#accountButton").click();
  await page.locator("#accountMenu").waitFor({ state: "hidden" });

  // 4. 合并表单：发送验证码后不换页、邮箱保留、提示验证码已发送。
  await bindForm.locator('[name="recoveryEmail"]').fill("moss@example.com");
  await bindForm.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expectVisible(bindForm.locator('[name="recoveryEmail"]'), "发送后找回邮箱输入仍在");
  if (!(await bindForm.locator('[name="code"]').isEnabled())) {
    throw new Error("发送验证码后验证码输入框应可输入");
  }
  const bindMessage = await bindForm.locator("[data-form-message]").textContent();
  if (!bindMessage.includes("验证码已发送到")) {
    throw new Error(`合并表单发送验证码后没有提示：${bindMessage}`);
  }

  // 5. 未验证成员写操作被拦截并跳回账号安全页。
  await goToHash(page, "#/", "让作品被读见");
  await page.getByRole("link", { name: "开始写作" }).click();
  await expectVisible(
    page.getByRole("heading", { name: "账号安全" }),
    "写入拦截跳转账号安全页",
  );
  await expectVisible(page.locator("#toast"), "写入拦截提示");
  const blockToast = await page.locator("#toast").textContent();
  if (!blockToast.includes("请先验证找回邮箱")) {
    throw new Error(`写入拦截提示错误：${blockToast}`);
  }

  // 6. 验证码 123456 验证后恢复写作能力。
  await page.locator('#bindRecoveryForm [name="code"]').fill("123456");
  await page.locator('#bindRecoveryForm').getByRole("button", { name: "验证并进入" }).click();
  await expectVisible(page.locator('[data-masked-email="true"]'), "验证后的掩码邮箱");
  await page.getByRole("button", { name: "返回继续" }).click();
  await page.waitForURL(/#\/write$/);
  await expectVisible(
    page.getByRole("heading", { name: "写一篇新作" }),
    "验证后回到写作台",
  );
  await page.locator('#writingForm [name="title"]').fill("验证后的第一作");
  await page
    .locator('#writingForm [name="content"]')
    .fill("验证找回邮箱后成功发布的作品正文。");
  await page.getByRole("button", { name: "发布作品" }).click();
  await page.waitForURL(/#\/works\//);
  await page
    .getByRole("heading", { name: "验证后的第一作", exact: true })
    .waitFor();

  await context.close();
}

(async () => {
  const browserMessages = [];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const desktopScreenshots = await desktopFlow(browser, browserMessages);
    const mobileScreenshots = await mobileFlow(browser, browserMessages);
    await mobileProfileAuthFlow(browser, browserMessages);
    await accountSecurityFlow(browser, browserMessages);
    if (browserMessages.length) {
      throw new Error(`浏览器控制台出现错误：\n${browserMessages.join("\n")}`);
    }
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(
      path.join(screenshots, "desktop-home.png"),
      desktopScreenshots.homeScreenshot,
    );
    writeFileSync(
      path.join(screenshots, "desktop-reading.png"),
      desktopScreenshots.readingScreenshot,
    );
    writeFileSync(
      path.join(screenshots, "mobile-home.png"),
      mobileScreenshots.homeScreenshot,
    );
    writeFileSync(
      path.join(screenshots, "mobile-reading.png"),
      mobileScreenshots.readingScreenshot,
    );
    console.log("Browser checks passed: desktop and mobile flows verified.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
