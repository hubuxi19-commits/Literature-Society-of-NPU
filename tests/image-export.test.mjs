import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  buildExportFileName,
  downloadExportFile,
  paginateExportUnits,
  shareExportFiles,
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
    ["一", "二"],
    ["三"],
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

test("诗歌行即使超高也不会拆分", () => {
  const unit = { type: "line", text: "不可拆的一整行" };
  assert.deepEqual(paginateExportUnits([unit], () => 200, 80), [[unit]]);
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
