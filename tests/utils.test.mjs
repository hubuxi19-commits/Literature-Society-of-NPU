import test from "node:test";
import assert from "node:assert/strict";
import {
  validateStudentNumber,
  validatePassword,
  studentNumberToAuthEmail,
  maskEmail,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatActors,
  buildNotificationText,
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
  splitDisplayParagraphs,
  splitQuoteUnits,
  codepointLength,
  codepointSlice,
  codepointIndexFromUtf16,
  trimAsciiSpaces,
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

test("作品版本与编辑路由解析到对应页面", () => {
  assert.deepEqual(parseRoute("#/works/w1/versions"), {
    name: "versions",
    id: "w1",
  });
  assert.deepEqual(parseRoute("#/works/w1/edit"), {
    name: "editWork",
    id: "w1",
  });
  assert.deepEqual(parseRoute("#/works/w1"), { name: "work", id: "w1" });
  assert.deepEqual(parseRoute("#/works/w1/other"), { name: "not-found" });
});

test("社交路由解析到通知与我的关注/粉丝/收藏", () => {
  assert.deepEqual(parseRoute("#/notifications"), { name: "notifications" });
  assert.deepEqual(parseRoute("#/my/following"), { name: "my-following" });
  assert.deepEqual(parseRoute("#/my/followers"), { name: "my-followers" });
  assert.deepEqual(parseRoute("#/my/bookmarks"), { name: "my-bookmarks" });
  assert.deepEqual(parseRoute("#/my/"), { name: "not-found" });
  assert.deepEqual(parseRoute("#/my/following/extra"), { name: "not-found" });
});

test("相对时间格式化：从刚发生到超过一年回退日期", () => {
  const now = new Date("2026-08-10T12:00:00+08:00").getTime();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  assert.equal(formatRelativeTime(at(0.1), now), "刚刚");
  assert.equal(formatRelativeTime(at(5), now), "5 分钟前");
  assert.equal(formatRelativeTime(at(59), now), "59 分钟前");
  assert.equal(formatRelativeTime(at(60), now), "1 小时前");
  assert.equal(formatRelativeTime(at(23 * 60), now), "23 小时前");
  assert.equal(formatRelativeTime(at(24 * 60), now), "昨天");
  assert.equal(formatRelativeTime(at(3 * 24 * 60), now), "3 天前");
  assert.equal(formatRelativeTime(at(14 * 24 * 60), now), "2 周前");
  assert.equal(formatRelativeTime(at(120 * 24 * 60), now), "4 个月前");
  assert.equal(formatRelativeTime("", now), "");
});

test("通知条目文案：单人、多人折叠 +N 与按事件类型拼接", () => {
  const singleFollow = {
    event_type: "follow",
    actor_pen_names: ["白露"],
    actor_count: 1,
    work_title: null,
  };
  assert.equal(buildNotificationText(singleFollow), "白露 关注了你");

  const multiLike = {
    event_type: "work_like",
    actor_pen_names: ["编辑部", "白露", "杏雨"],
    actor_count: 6,
    work_title: "末班车经过友谊校区",
  };
  assert.equal(
    buildNotificationText(multiLike),
    "编辑部、白露、杏雨 等 6 人 赞了你的作品《末班车经过友谊校区》",
  );

  const twoActors = {
    event_type: "work_bookmark",
    actor_pen_names: ["编辑部", "白露"],
    actor_count: 2,
    work_title: "河流向北",
  };
  assert.equal(buildNotificationText(twoActors), "编辑部、白露 收藏了你的作品《河流向北》");

  const reply = { event_type: "comment_reply", actor_pen_names: ["杏雨"], actor_count: 1, work_title: null };
  assert.equal(buildNotificationText(reply), "杏雨 回复了你的评论");

  const commentLike = { event_type: "comment_like", actor_pen_names: ["松声"], actor_count: 1, work_title: null };
  assert.equal(buildNotificationText(commentLike), "松声 赞了你的评论");

  const unknown = { event_type: "unknown", actor_pen_names: [], actor_count: 0, work_title: null };
  assert.equal(buildNotificationText(unknown), "有人 与你互动了");
});

test("通知 actor 文案：计数超过预览长度时追加等 N 人", () => {
  assert.equal(
    formatActors({ actor_pen_names: ["编辑部", "白露", "杏雨"], actor_count: 6 }),
    "编辑部、白露、杏雨 等 6 人",
  );
  assert.equal(
    formatActors({ actor_pen_names: ["编辑部", "白露"], actor_count: 2 }),
    "编辑部、白露",
  );
  assert.equal(formatActors({ actor_pen_names: ["白露"], actor_count: 1 }), "白露");
  assert.equal(formatActors({ actor_pen_names: [], actor_count: 0 }), "有人");
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

test("展示串分段：空行分隔、逐段去首尾空白、去空段（含单空格与全角缩进段）", () => {
  const content = " 第一段。 \n \n第二段。\n\n　第三段（全角缩进）\n\n\n 第四段。 ";
  assert.deepEqual(splitDisplayParagraphs(content), [
    "第一段。",
    "第二段。",
    "第三段（全角缩进）",
    "第四段。",
  ]);
});

test("展示串分段保留段首 NBSP（与 SQL btrim 字符集一致，不裁 U+00A0）", () => {
  const content = "\u00A0第一段。\n\n第二段。";
  assert.deepEqual(splitDisplayParagraphs(content), [
    "\u00A0第一段。",
    "第二段。",
  ]);
  assert.equal(
    splitDisplayParagraphs(content).join("\n"),
    "\u00A0第一段。\n第二段。",
  );
});

test("展示串分段：仅含全角空格的空行同样被分段", () => {
  const content = "第一段。\n　\n第二段。";
  assert.deepEqual(splitDisplayParagraphs(content), ["第一段。", "第二段。"]);
});

test("码点辅助：emoji 按单个码点计数与切片", () => {
  const text = "第一😀段";
  assert.equal(codepointLength(text), 4);
  assert.equal(codepointSlice(text, 0, 3), "第一😀");
  assert.equal(codepointSlice(text, 2, 3), "😀");
  assert.equal(codepointLength("第二段。"), 4);
  assert.equal(codepointSlice("第一段。\n第二段。", 5, 9), "第二段。");
});

test("ASCII 空格去首尾与 SQL btrim 默认一致（不裁 NBSP/全角空格/换行）", () => {
  assert.equal(trimAsciiSpaces("  标题  "), "标题");
  assert.equal(trimAsciiSpaces("　全角缩进"), "　全角缩进");
  assert.equal(trimAsciiSpaces(" NBSP 开头"), " NBSP 开头");
  assert.equal(trimAsciiSpaces("\n换行\n"), "\n换行\n");
  assert.equal(trimAsciiSpaces(null), "");
  assert.equal(trimAsciiSpaces("   "), "");
});

test("码点辅助：UTF-16 偏移换算为码点索引", () => {
  const text = "第一😀段";
  assert.equal(codepointIndexFromUtf16(text, 0), 0);
  assert.equal(codepointIndexFromUtf16(text, 1), 1);
  assert.equal(codepointIndexFromUtf16(text, 2), 2);
  assert.equal(codepointIndexFromUtf16(text, 3), 2);
  assert.equal(codepointIndexFromUtf16(text, 4), 3);
  assert.equal(codepointIndexFromUtf16(text, 5), 4);
});

test("引用单位：新诗按行切分并裁剪行首尾空格", () => {
  const units = splitQuoteUnits(
    "车窗把夜色裁成一格一格\n  路灯缓慢退去  \n像有人合上书",
    "新诗",
  );
  assert.deepEqual(units, [
    { text: "车窗把夜色裁成一格一格", start: 0, end: 11 },
    { text: "路灯缓慢退去", start: 14, end: 20 },
    { text: "像有人合上书", start: 23, end: 29 },
  ]);
});

test("引用单位：旧诗按标点切分且换行同样作为分隔", () => {
  const units = splitQuoteUnits("国破山河在，\n城春草木深。", "旧诗");
  assert.deepEqual(units, [
    { text: "国破山河在", start: 0, end: 5 },
    { text: "城春草木深", start: 7, end: 12 },
  ]);
});

test("引用单位：旧诗无标点时退化为按行", () => {
  const units = splitQuoteUnits("床前明月光\n疑是地上霜", "旧诗");
  assert.deepEqual(units, [
    { text: "床前明月光", start: 0, end: 5 },
    { text: "疑是地上霜", start: 6, end: 11 },
  ]);
});

test("引用单位：散文按句末标点切分且引文不含标点", () => {
  const units = splitQuoteUnits("风先下了车。没有人说话！真的吗…就这样", "散文");
  assert.deepEqual(units, [
    { text: "风先下了车", start: 0, end: 5 },
    { text: "没有人说话", start: 6, end: 11 },
    { text: "真的吗", start: 12, end: 15 },
    { text: "就这样", start: 16, end: 19 },
  ]);
});

test("引用单位：偏移按码点计算，emoji 占一位", () => {
  const units = splitQuoteUnits("😀你好。再见", "散文");
  assert.deepEqual(units, [
    { text: "😀你好", start: 0, end: 3 },
    { text: "再见", start: 4, end: 6 },
  ]);
});

test("引用单位：段落内单位与间隔无缝覆盖且与码点切片一致", () => {
  const paragraph = "第一句。第二句！\n第三句";
  const units = splitQuoteUnits(paragraph, "散文");
  assert.ok(units.length >= 2, "应切出多个单位");
  for (const unit of units) {
    assert.equal(codepointSlice(paragraph, unit.start, unit.end), unit.text);
    assert.ok(unit.start >= 0);
    assert.ok(unit.end <= codepointLength(paragraph));
    assert.ok(unit.end > unit.start);
    assert.equal(trimAsciiSpaces(unit.text), unit.text, "单位应已裁首尾 ASCII 空格");
  }
});

test("引用单位：散文段内换行裁在单位首尾且偏移与切片一致", () => {
  // 段内单个换行（非空行）会落在句末标点切出的单位首尾；
  // 若带入引文，SQL btrim(quote_text) 会剥掉换行而 substr(展示串) 不会，导致判定不符。
  const units = splitQuoteUnits("风先下了车。\n没有人说话！", "散文");
  assert.deepEqual(units, [
    { text: "风先下了车", start: 0, end: 5 },
    { text: "没有人说话", start: 7, end: 12 },
  ]);
  const paragraph = "风先下了车。\n没有人说话！";
  for (const unit of units) {
    assert.equal(codepointSlice(paragraph, unit.start, unit.end), unit.text);
  }
});

test("引用单位：散文句中换行保留在引文内且与切片一致", () => {
  // 句中换行不裁，两侧偏移仍指向展示串的准确切片（SQL btrim 不剥内部空白）。
  const units = splitQuoteUnits("风先\n下车了。", "散文");
  assert.deepEqual(units, [{ text: "风先\n下车了", start: 0, end: 6 }]);
});
