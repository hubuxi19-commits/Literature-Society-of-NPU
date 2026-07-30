const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = "http://127.0.0.1:4173";
const screenshots = path.resolve(__dirname, "..", "screenshots");

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

  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: path.join(screenshots, "desktop-home.png"),
    fullPage: true,
  });

  const search = page.getByRole("textbox", { name: "搜索作品" });
  await search.fill("河流");
  await search.press("Enter");
  const workList = page.getByTestId("work-list");
  await expectVisible(
    workList.getByText("河流向北", { exact: true }),
    "搜索结果",
  );
  if (
    await workList.getByText("末班车经过友谊校区", { exact: true }).count()
  ) {
    throw new Error("搜索没有过滤无关作品");
  }
  await search.fill("");
  await search.press("Enter");
  await page.getByRole("combobox", { name: "按分类筛选" }).selectOption("小说");
  await expectVisible(
    workList.getByText("没有名字的车站", { exact: true }),
    "小说分类结果",
  );
  if (await workList.getByText("河流向北", { exact: true }).count()) {
    throw new Error("分类没有过滤散文");
  }
  await page.getByRole("combobox", { name: "按分类筛选" }).selectOption("全部");

  await page
    .getByRole("link", { name: "末班车经过友谊校区", exact: true })
    .first()
    .click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  await page.locator(".reading-title h1").waitFor();
  if ((await page.locator(".reading-title h1").textContent()) !== "末班车经过友谊校区") {
    throw new Error("作品阅读页标题不正确");
  }
  await expectVisible(page.locator(".reading-body"), "作品正文");
  await expectNoHorizontalOverflow(page, "桌面阅读页");
  await page.screenshot({
    path: path.join(screenshots, "desktop-reading.png"),
    fullPage: true,
  });

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

  await goToHash(page, "#/write", "写一篇新作");
  await page.locator('#writingForm [name="title"]').fill("浏览器里的新作");
  await page
    .locator('#writingForm [name="excerpt"]')
    .fill("用于验证发布路径的摘要");
  await page
    .locator('#writingForm [name="content"]')
    .fill("第一段写在这里。\n\n第二段继续验证长文排版。");
  await page.getByRole("button", { name: "发布作品" }).click();
  await page
    .getByRole("heading", { name: "浏览器里的新作", exact: true })
    .waitFor();
  await expectVisible(page.getByRole("button", { name: "删除作品" }), "作者删除入口");
  if (await page.getByRole("button", { name: /设为推荐|取消推荐/ }).count()) {
    throw new Error("普通成员看到了管理员推荐入口");
  }

  await goToHash(page, "#/works/work-river", "河流向北");
  if (await page.getByRole("button", { name: "删除作品" }).count()) {
    throw new Error("普通成员看到了他人作品删除入口");
  }

  await goToHash(page, "#/authors/profile-pine", "松声");
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
}

async function mobileFlow(browser, browserMessages) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
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
  await expectNoHorizontalOverflow(page, "移动首页");
  await expectVisible(page.getByRole("button", { name: /菜单/ }), "移动菜单按钮");
  await page.getByRole("button", { name: /菜单/ }).click();
  await expectVisible(
    page.getByRole("link", { name: "讨论", exact: true }),
    "移动端讨论导航",
  );
  await page.screenshot({
    path: path.join(screenshots, "mobile-home.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "末班车经过友谊校区", exact: true })
    .first()
    .click();
  await page.waitForURL(/#\/works\/work-night-bus$/);
  await page.locator(".reading-title h1").waitFor();
  await expectNoHorizontalOverflow(page, "移动阅读页");
  await context.close();
}

(async () => {
  const browserMessages = [];
  const browser = await chromium.launch({ headless: true });
  try {
    await desktopFlow(browser, browserMessages);
    await mobileFlow(browser, browserMessages);
    if (browserMessages.length) {
      throw new Error(`浏览器控制台出现错误：\n${browserMessages.join("\n")}`);
    }
    console.log("Browser checks passed: desktop and mobile flows verified.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
