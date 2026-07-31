const { chromium } = require("playwright");

const baseUrl = "http://127.0.0.1:4173";
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await useDemoConfig(page);
    page.setDefaultTimeout(5000);
    await page.goto(baseUrl, { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: "让作品被读见" }).waitFor();
    if (!(await page.getByTestId("work-list").isVisible())) {
      throw new Error("作品列表不可见");
    }
    if (!(await page.getByRole("link", { name: "开始写作" }).isVisible())) {
      throw new Error("开始写作入口不可见");
    }
    const categories = await page
      .getByRole("combobox", { name: "按分类筛选" })
      .locator("option")
      .allTextContents();
    if (!categories.includes("新诗") || !categories.includes("旧诗")) {
      throw new Error("桌面分类缺少新诗或旧诗");
    }
    if (categories.includes("诗歌")) {
      throw new Error("桌面分类仍包含旧的诗歌选项");
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
