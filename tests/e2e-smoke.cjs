const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    await page.goto("http://127.0.0.1:4173", { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: "让作品被读见" }).waitFor();
    if (!(await page.getByTestId("work-list").isVisible())) {
      throw new Error("作品列表不可见");
    }
    if (!(await page.getByRole("link", { name: "开始写作" }).isVisible())) {
      throw new Error("开始写作入口不可见");
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
