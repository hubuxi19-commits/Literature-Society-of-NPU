import test from "node:test";
import assert from "node:assert/strict";
import {
  validateStudentNumber,
  validatePassword,
  studentNumberToAuthEmail,
  maskEmail,
  formatDate,
  formatDateTime,
  getPenNameChangeAvailability,
  PEN_NAME_CHANGE_INTERVAL_MS,
  createExcerpt,
  countChineseText,
  buildCommentTree,
  parseRoute,
  filterAndSortWorks,
  escapeText,
  CATEGORIES,
  PUBLISHABLE_CATEGORIES,
  normalizeCategory,
  isPoetryCategory,
} from "../js/utils.mjs";

test("分类拆分为新诗和旧诗且投稿不显示旧诗歌分类", () => {
  assert.deepEqual(CATEGORIES, [
    "全部", "新诗", "旧诗", "散文", "小说", "随笔", "其他",
  ]);
  assert.deepEqual(PUBLISHABLE_CATEGORIES, [
    "新诗", "旧诗", "散文", "小说", "随笔", "其他",
  ]);
  assert.equal(CATEGORIES.includes("诗歌"), false);
});

test("旧诗歌数据兼容映射为新诗且两类诗都使用诗歌排版", () => {
  assert.equal(normalizeCategory("诗歌"), "新诗");
  assert.equal(normalizeCategory("旧诗"), "旧诗");
  assert.equal(isPoetryCategory("诗歌"), true);
  assert.equal(isPoetryCategory("新诗"), true);
  assert.equal(isPoetryCategory("旧诗"), true);
  assert.equal(isPoetryCategory("散文"), false);
});

test("学号必须是 20 开头的十位数字", () => {
  assert.equal(validateStudentNumber("2023123456"), true);
  assert.equal(validateStudentNumber("1923123456"), false);
  assert.equal(validateStudentNumber("202312345"), false);
  assert.equal(validateStudentNumber("202312345x"), false);
});

test("学号映射为内部 Auth 标识", () => {
  assert.equal(
    studentNumberToAuthEmail(" 2023123456 "),
    "2023123456@accounts.wenyuan.invalid",
  );
  assert.throws(() => studentNumberToAuthEmail("not-a-student-number"), /学号格式/);
});

test("密码必须同时包含字母和数字且不少于八位", () => {
  assert.equal(validatePassword("wenyuan88"), true);
  assert.equal(validatePassword("12345678"), false);
  assert.equal(validatePassword("password"), false);
  assert.equal(validatePassword("wen8"), false);
});

test("邮箱遮罩与账号安全边界保持一致", () => {
  assert.equal(maskEmail("reader@example.com"), "r***r@e***e.com");
  assert.equal(maskEmail("a@example.com"), "***@e***e.com");
  assert.equal(maskEmail("ab@x.com"), "***@***.com");
  assert.equal(maskEmail(" Reader@Example.COM "), "r***r@e***e.com");
  assert.throws(() => maskEmail("not-an-email"), /邮箱格式/);
  assert.throws(() => maskEmail("a@b@c.com"), /邮箱格式/);
});

test("日期格式稳定且空值显示未记录", () => {
  assert.equal(formatDate(""), "未记录");
  assert.match(formatDate("2026-07-30T08:09:00+08:00"), /^2026年7月30日$/);
});

test("笔名修改在完整七天后重新开放", () => {
  const changedAt = "2026-08-01T10:00:00+08:00";
  const changedAtMs = new Date(changedAt).getTime();
  assert.deepEqual(getPenNameChangeAvailability(null, changedAtMs), {
    canChange: true,
    nextChangeAt: null,
  });
  assert.equal(
    getPenNameChangeAvailability(
      changedAt,
      changedAtMs + PEN_NAME_CHANGE_INTERVAL_MS - 1,
    ).canChange,
    false,
  );
  const available = getPenNameChangeAvailability(
    changedAt,
    changedAtMs + PEN_NAME_CHANGE_INTERVAL_MS,
  );
  assert.equal(available.canChange, true);
  assert.equal(available.nextChangeAt, "2026-08-08T02:00:00.000Z");
  assert.match(formatDateTime(available.nextChangeAt), /2026年8月8日.*10:00/);
});

test("摘要压缩空白并限制长度", () => {
  assert.equal(createExcerpt(" 山川\n\n与我们同行 ", 6), "山川 与我们…");
  assert.equal(createExcerpt("短句", 20), "短句");
});

test("字数统计忽略空白", () => {
  assert.equal(countChineseText("山 川\n与我"), 4);
  assert.equal(countChineseText(""), 0);
});

test("评论构建树并保留孤立回复且不修改原数组", () => {
  const comments = [
    { id: "2", parent_id: "1", created_at: "2026-01-02" },
    { id: "1", parent_id: null, created_at: "2026-01-01" },
    { id: "3", parent_id: "missing", created_at: "2026-01-03" },
  ];
  const tree = buildCommentTree(comments);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].replies[0].id, "2");
  assert.equal(tree[1].id, "3");
  assert.equal("replies" in comments[0], false);
});

test("哈希路由识别全部页面并回退首页", () => {
  assert.deepEqual(parseRoute("#/"), { name: "home" });
  assert.deepEqual(parseRoute("#/works/abc"), { name: "work", id: "abc" });
  assert.deepEqual(parseRoute("#/authors/u1"), { name: "author", id: "u1" });
  assert.deepEqual(parseRoute("#/write"), { name: "write" });
  assert.deepEqual(parseRoute("#/discussions"), { name: "discussions" });
  assert.deepEqual(parseRoute("#/submissions"), { name: "submissions" });
  assert.deepEqual(parseRoute("#/missing"), { name: "not-found" });
});

test("账号安全路由解析为独立路由", () => {
  assert.deepEqual(parseRoute("#/account/security"), {
    name: "account-security",
  });
  assert.deepEqual(parseRoute("#/account/security/extra"), { name: "not-found" });
  assert.deepEqual(parseRoute("#/account/"), { name: "not-found" });
});

test("作品按关键词、分类和热度过滤排序且不修改输入", () => {
  const works = [
    {
      id: "1",
      title: "晚风",
      excerpt: "旧操场",
      author_pen_name: "松声",
      category: "诗歌",
      like_count: 1,
      comment_count: 2,
      created_at: "2026-01-01",
    },
    {
      id: "2",
      title: "河流",
      excerpt: "向北",
      author_pen_name: "白露",
      category: "散文",
      like_count: 9,
      comment_count: 0,
      created_at: "2026-01-02",
    },
  ];
  assert.deepEqual(
    filterAndSortWorks(works, {
      query: "操场",
      category: "全部",
      sort: "latest",
    }).map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(
    filterAndSortWorks(works, {
      query: "",
      category: "全部",
      sort: "likes",
    }).map((item) => item.id),
    ["2", "1"],
  );
  assert.deepEqual(
    filterAndSortWorks(works, {
      query: "",
      category: "新诗",
      sort: "discussions",
    }).map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(works.map((item) => item.id), ["1", "2"]);
});

test("文本转换返回普通字符串而不是 HTML", () => {
  assert.equal(escapeText("<script>&"), "<script>&");
  assert.equal(escapeText(null), "");
});
