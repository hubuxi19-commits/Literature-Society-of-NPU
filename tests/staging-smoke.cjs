// staging 浏览器端到端冒烟（Release 3：版本与批注）
// 不拦截 config.mjs：localhost 经 config-loader 自动加载 config.local.mjs → staging Supabase。
// 用法：STAGING_STUDENT_NUMBER=<学号> STAGING_PASSWORD=<密码> node tests/staging-smoke.cjs
// 环境变量：STAGING_BASE_URL（默认本地 4173）/ STAGING_STUDENT_NUMBER（必填）/ STAGING_PASSWORD（必填）/ STAGING_WORK_ID（可选，默认 staging 测试作品12）
const { chromium } = require("playwright");

const BASE_URL = process.env.STAGING_BASE_URL || "http://127.0.0.1:4173";
const STUDENT_NUMBER = process.env.STAGING_STUDENT_NUMBER;
const PASSWORD = process.env.STAGING_PASSWORD;
// 默认指向 staging 测试账号 test 名下的测试作品12
const WORK_ID =
  process.env.STAGING_WORK_ID || "90e221fd-0f68-40e1-84ae-9e0c02d5b929";

if (!STUDENT_NUMBER || !PASSWORD) {
  console.error(
    "缺少登录凭据：请设置 STAGING_STUDENT_NUMBER 与 STAGING_PASSWORD 环境变量后运行",
  );
  process.exit(2);
}

async function expectVisible(locator, label) {
  await locator.waitFor({ state: "visible" });
  if (!(await locator.isVisible())) throw new Error(`${label}不可见`);
}

async function goToHash(page, hash) {
  await page.evaluate((nextHash) => {
    window.location.hash = nextHash;
  }, hash);
}

async function login(page, studentNumber, password) {
  await page.locator("#accountButton").click();
  await expectVisible(page.locator("#authDialog"), "登录窗口");
  await page.locator('#loginForm [name="studentNumber"]').fill(studentNumber);
  await page.locator('#loginForm [name="password"]').fill(password);
  await page.getByRole("button", { name: "登录并继续" }).click();
  // staging Edge Function（account-email）冷启动可能较慢，放宽到 60 秒
  await page.locator("#authDialog").waitFor({ state: "hidden", timeout: 60000 });
}

async function run() {
  const browser = await chromium.launch();
  const browserMessages = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserMessages.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
  });

  try {
    // ── Phase 1：只读 ────────────────────────────────────────────
    await page.goto(BASE_URL);
    await page.getByRole("heading", { name: "让作品被读见" }).waitFor();
    await page.getByTestId("work-list").waitFor();
    console.log("PASS 首页从 staging 加载作品流");

    await login(page, STUDENT_NUMBER, PASSWORD);
    const accountText = (await page.locator("#accountButton").textContent()) ?? "";
    if (!accountText.includes("test")) {
      throw new Error(`登录后账号按钮未显示笔名 test：${accountText}`);
    }
    console.log(`PASS 以 test 登录（staging，账号按钮=${accountText.trim()}）`);

    // 打开测试作品阅读页
    await goToHash(page, `#/works/${WORK_ID}`);
    await page.locator("[data-annotatable]").waitFor();
    await expectVisible(page.getByText("查看历史版本", { exact: true }), "历史版本入口");
    await expectVisible(page.getByRole("button", { name: "修改作品" }), "修改作品按钮");
    console.log("PASS 阅读页加载，含历史版本入口与修改按钮");

    // 版本页：初始只有第 1 版且为当前版本（不应有恢复按钮）
    await goToHash(page, `#/works/${WORK_ID}/versions`);
    await page.getByRole("heading", { name: "历史版本", exact: true }).waitFor();
    await expectVisible(page.getByText("第 1 版", { exact: true }), "第 1 版");
    const initialRestore = await page.getByRole("button", { name: "恢复此版本" }).count();
    if (initialRestore !== 0) {
      throw new Error(`初始状态下 v1 是当前版本，不应出现恢复按钮（实际 ${initialRestore} 个）`);
    }
    const initialBody = (await page.locator(".version-card").first().innerText()) ?? "";
    if (!initialBody.includes("初次发布")) {
      throw new Error(`v1 缺少 change_summary：${initialBody}`);
    }
    console.log("PASS 版本页初始：第 1 版为当前版本，change_summary=初次发布");

    // ── Phase 2：写 —— 编辑产生新版本 ──────────────────────────
    await goToHash(page, `#/works/${WORK_ID}`);
    await page.locator("[data-annotatable]").waitFor();
    await page.getByRole("button", { name: "修改作品" }).click();
    await page.locator('[name="changeSummary"]').waitFor();
    await expectVisible(
      page.getByText("当前为第 1 版", { exact: false }),
      "编辑台当前版本提示",
    );

    const contentTextarea = page.locator('#writingForm [name="content"]');
    const existingContent = await contentTextarea.inputValue();
    await contentTextarea.fill(
      `${existingContent}\n\n【staging 浏览器冒烟】编辑产生的新版本正文标记。`,
    );
    await page.locator('[name="changeSummary"]').fill("staging 浏览器冒烟：编辑产生新版本");
    await page.getByRole("button", { name: "保存新版本" }).click();
    await page.getByText("版本已保存。", { exact: true }).waitFor();
    await page.locator("[data-annotatable]").waitFor();
    console.log("PASS 编辑提交成功，提示「版本已保存。」");

    // 版本页现在应有两个版本：v2 为当前，v1 出现恢复按钮
    await goToHash(page, `#/works/${WORK_ID}/versions`);
    await page.getByRole("heading", { name: "历史版本", exact: true }).waitFor();
    await expectVisible(page.getByText("第 2 版", { exact: true }), "第 2 版");
    const afterRestore = await page.getByRole("button", { name: "恢复此版本" }).count();
    if (afterRestore !== 1) {
      throw new Error(`v2 为当前版本后，应有且仅有 1 个恢复按钮（实际 ${afterRestore} 个）`);
    }
    console.log("PASS 版本页出现第 2 版，v1 出现恢复按钮");

    // ── Phase 3：写 —— 选区批注 ────────────────────────────────
    await goToHash(page, `#/works/${WORK_ID}`);
    await page.locator("[data-annotatable]").waitFor();
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
    if (!annotateQuoteText) throw new Error("批注浮动按钮缺少引用原文");
    page.once("dialog", (dialog) => dialog.accept("staging 浏览器冒烟批注"));
    await page.evaluate(() => document.querySelector(".annotate-float").click());
    await page.getByRole("heading", { name: "批注 · 1", exact: true }).waitFor();
    await expectVisible(
      page.getByText(`“${annotateQuoteText}”`, { exact: true }),
      "批注引用原文展示",
    );
    const quoteItemText =
      (await page.locator(".quote-item").first().textContent()) ?? "";
    if (!quoteItemText.includes("staging 浏览器冒烟批注")) {
      throw new Error(`批注正文没有显示：${quoteItemText}`);
    }
    if (!quoteItemText.includes("test")) {
      throw new Error(`批注作者笔名没有显示：${quoteItemText}`);
    }
    console.log("PASS 选区批注成功，批注 · 1，引用与作者笔名展示正确");

    // ── 汇总 ────────────────────────────────────────────────────
    if (browserMessages.length) {
      throw new Error(`浏览器控制台错误：\n${browserMessages.join("\n")}`);
    }
    console.log("\nSTAGING SMOKE PASS");
    console.log("本次创建的 staging 测试数据（作品 90e221fd 测试作品12）：");
    console.log("  1) 新增第 2 版（正文追加了冒烟标记，change_summary=staging 浏览器冒烟：编辑产生新版本）");
    console.log("  2) 新增 1 条批注（staging 浏览器冒烟批注）");
    console.log("如需还原，可执行恢复 v1 + 删除批注（我提供 SQL）。");
  } catch (error) {
    await page.screenshot({
      path: require("node:path").resolve(__dirname, "..", "screenshots", "staging-smoke-fail.png"),
      fullPage: true,
    });
    throw error;
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(`\nSTAGING SMOKE FAIL: ${error.message}`);
  process.exit(1);
});
