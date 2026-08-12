import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EXPORT_LAYOUT,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  applyExportLayout,
  buildExportFileName,
  downloadExportFile,
  normalizeExportLayout,
  paginateExportUnits,
  shareExportFiles,
  splitExportUnits,
} from "../js/image-export.mjs";

test("通用素笺模板使用推荐排版参数", () => {
  assert.deepEqual(DEFAULT_EXPORT_LAYOUT, {
    version: 1, font: "song", fontSize: 36, alignment: "left",
    lineHeight: 1.9, margin: "standard", showHeader: true, paper: "rice",
  });
});

test("排版设置接受有效值并回退异常字段", () => {
  assert.deepEqual(normalizeExportLayout({ version: 1, font: "kai", fontSize: 52, alignment: "center", lineHeight: 1.5, margin: "wide", showHeader: false, paper: "xuan" }), { version: 1, font: "kai", fontSize: 52, alignment: "center", lineHeight: 1.5, margin: "wide", showHeader: false, paper: "xuan" });
  assert.deepEqual(normalizeExportLayout({ version: 9, font: "comic", fontSize: 51, alignment: "justify", lineHeight: 3, margin: "none", showHeader: "false", paper: "photo" }), DEFAULT_EXPORT_LAYOUT);
});

test("排版设置通过样式变量和语义类应用到稿页", () => {
  const values = new Map();
  const page = { classList: { values: new Set(), add(value) { this.values.add(value); }, remove(...items) { items.forEach((item) => this.values.delete(item)); } }, style: { setProperty(name, value) { values.set(name, value); } } };
  applyExportLayout(page, { font: "fangsong", fontSize: 42, alignment: "right", lineHeight: 1.7, margin: "compact", showHeader: true, paper: "white" });
  assert.equal(values.get("--export-font-family"), '\"FangSong\", \"FangSong_GB2312\", \"STFangsong\", fangsong');
  assert.equal(values.get("--export-body-font-size"), "42px");
  assert.equal(values.get("--export-body-line-height"), "1.7");
  assert.equal(values.get("--export-page-padding-x"), "72px");
  assert.equal(values.get("--export-text-align"), "right");
  assert.equal(page.classList.values.has("export-page--paper-white"), true);
});

test("仿宋与楷体使用不同于宋体的跨平台回退字体", () => {
  const values = new Map();
  const page = {
    classList: { add() {}, remove() {} },
    style: { setProperty(name, value) { values.set(name, value); } },
  };
  applyExportLayout(page, { ...DEFAULT_EXPORT_LAYOUT, font: "fangsong" });
  assert.match(values.get("--export-font-family"), /fangsong/i);
  assert.doesNotMatch(values.get("--export-font-family"), /serif\s*$/i);

  applyExportLayout(page, { ...DEFAULT_EXPORT_LAYOUT, font: "kai" });
  assert.match(values.get("--export-font-family"), /cursive\s*$/i);
});

test("导出尺寸固定为手机竖图", () => {
  assert.equal(EXPORT_WIDTH, 1080);
  assert.equal(EXPORT_HEIGHT, 1920);
});

test("导出模块提供不编码图片的共享页面准备接口", async () => {
  const exporter = await import("../js/image-export.mjs");
  assert.equal(typeof exporter.prepareExportPages, "function");
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
      { type: "space", text: "\n\n" },
      { type: "paragraph", text: "第二段。" },
    ],
  );
});

test("散文保留段内换行与段间空行", () => {
  const content = "第一行\n第二行\n\n第三段\n仍在第三段";
  const units = splitExportUnits(content, "散文");

  assert.deepEqual(units, [
    { type: "paragraph", text: "第一行\n第二行" },
    { type: "space", text: "\n\n" },
    { type: "paragraph", text: "第三段\n仍在第三段" },
  ]);
  assert.equal(units.map((unit) => unit.text).join(""), content);
});

test("分页不拆内容单元且不会生成空页", () => {
  const units = [
    { type: "line", text: "一" },
    { type: "line", text: "二" },
    { type: "line", text: "三" },
  ];
  const pages = paginateExportUnits(units, () => 40, 80);
  assert.deepEqual(pages.map((page) => page.map((unit) => unit.text)), [
    ["一", "二"],
    ["三"],
  ]);
});

test("分页从第二页开始使用续页正文高度", () => {
  const units = [
    { type: "line", text: "一" },
    { type: "line", text: "二" },
    { type: "line", text: "三" },
    { type: "line", text: "四" },
    { type: "line", text: "五" },
  ];
  const pages = paginateExportUnits(units, () => 40, 80, 160);

  assert.deepEqual(pages.map((page) => page.map((unit) => unit.text)), [
    ["一", "二"],
    ["三", "四", "五"],
  ]);
});

test("超高散文段落按字符边界拆分且不丢字", () => {
  const units = [{ type: "paragraph", text: "一二三四五六七八九" }];
  const pages = paginateExportUnits(
    units,
    (unit) => Array.from(unit.text).length * 10,
    30,
  );

  assert.deepEqual(
    pages.map((page) => page.map((unit) => unit.text)),
    [["一二三"], ["四五六"], ["七八九"]],
  );
  assert.equal(pages.flat().map((unit) => unit.text).join(""), units[0].text);
});

test("诗歌行无法完整排入单页时返回清晰错误", () => {
  const unit = { type: "line", text: "不可拆的一整行" };
  assert.throws(
    () => paginateExportUnits([unit], () => 200, 80),
    /诗行.*无法完整排入单页/,
  );
});

test("每一张导出页编码前都检查页面和正文溢出", async () => {
  const exporter = await import("../js/image-export.mjs");
  assert.equal(typeof exporter.assertExportPageFits, "function");

  const fittingBody = { scrollHeight: 1200, clientHeight: 1200 };
  const fittingPage = {
    scrollHeight: 1920,
    clientHeight: 1920,
    querySelector() {
      return fittingBody;
    },
  };
  assert.doesNotThrow(() => exporter.assertExportPageFits(fittingPage, 0));

  assert.throws(
    () =>
      exporter.assertExportPageFits(
        {
          ...fittingPage,
          scrollHeight: 1921,
        },
        1,
      ),
    /第 2 页.*超出导出画布/,
  );
  assert.throws(
    () =>
      exporter.assertExportPageFits(
        {
          ...fittingPage,
          querySelector() {
            return { scrollHeight: 1201, clientHeight: 1200 };
          },
        },
        2,
      ),
    /第 3 页.*正文超出可用区域/,
  );
});

test("空内容不会生成空页", () => {
  assert.deepEqual(paginateExportUnits([], () => 40, 80), []);
});

test("多页文件名带两位页码并清除非法字符", () => {
  const work = { title: "风/雨", author_pen_name: "松声" };
  assert.equal(buildExportFileName(work, 0, 3), "风-雨-松声-01.png");
});

test("单页文件名不添加页码并折叠连续替换符", () => {
  const work = { title: " 风\\/:*?雨。 ", author_pen_name: " 松声 " };
  assert.equal(buildExportFileName(work, 0, 1), "风-雨。-松声.png");
});

test("分享函数在返回 Promise 前同步调用系统分享", () => {
  const files = [{ name: "作品.png" }];
  const shareResult = Promise.resolve();
  let payload = null;
  const navigatorRef = {
    share(nextPayload) {
      payload = nextPayload;
      return shareResult;
    },
  };

  const returned = shareExportFiles(files, { title: "作品" }, navigatorRef);

  assert.deepEqual(payload, { files, title: "作品" });
  assert.equal(returned, shareResult);
});

test("保存函数在当前调用栈点击下载并清理临时资源", () => {
  const events = [];
  const anchor = {
    click() {
      events.push("click");
    },
    remove() {
      events.push("remove");
    },
  };
  const documentRef = {
    createElement() {
      return anchor;
    },
    body: {
      append(node) {
        assert.equal(node, anchor);
        events.push("append");
      },
    },
  };
  const urlApi = {
    createObjectURL() {
      events.push("create-url");
      return "blob:作品";
    },
    revokeObjectURL(url) {
      assert.equal(url, "blob:作品");
      events.push("revoke-url");
    },
  };

  downloadExportFile({ name: "作品.png" }, { documentRef, urlApi });

  assert.deepEqual(events, [
    "create-url",
    "append",
    "click",
    "remove",
    "revoke-url",
  ]);
  assert.equal(anchor.download, "作品.png");
});

test("下载点击抛错时仍在 finally 移除锚点并撤销 URL", () => {
  const events = [];
  const anchor = {
    click() {
      events.push("click");
      throw new Error("浏览器阻止下载");
    },
    remove() {
      events.push("remove");
    },
  };
  const documentRef = {
    createElement() {
      return anchor;
    },
    body: { append() {} },
  };
  const urlApi = {
    createObjectURL() {
      return "blob:作品";
    },
    revokeObjectURL() {
      events.push("revoke-url");
    },
  };

  assert.throws(
    () =>
      downloadExportFile(
        { name: "作品.png" },
        { documentRef, urlApi },
      ),
    /浏览器阻止下载/,
  );
  assert.deepEqual(events, ["click", "remove", "revoke-url"]);
});

test("锚点创建失败时仍撤销已经创建的 URL", () => {
  const events = [];
  const documentRef = {
    createElement() {
      throw new Error("无法创建锚点");
    },
  };
  const urlApi = {
    createObjectURL() {
      return "blob:作品";
    },
    revokeObjectURL() {
      events.push("revoke-url");
    },
  };

  assert.throws(
    () =>
      downloadExportFile(
        { name: "作品.png" },
        { documentRef, urlApi },
      ),
    /无法创建锚点/,
  );
  assert.deepEqual(events, ["revoke-url"]);
});
