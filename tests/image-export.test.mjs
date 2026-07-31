import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  buildExportFileName,
  paginateExportUnits,
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
