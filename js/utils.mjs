const STUDENT_NUMBER_PATTERN = /^20\d{8}$/;
const AUTH_EMAIL_DOMAIN = "accounts.wenyuan.invalid";
export const PEN_NAME_CHANGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const CATEGORIES = Object.freeze([
  "全部", "新诗", "旧诗", "散文", "小说", "随笔", "其他",
]);

export const PUBLISHABLE_CATEGORIES = Object.freeze(CATEGORIES.slice(1));

export function normalizeCategory(value) {
  const category = String(value ?? "").trim();
  if (category === "诗歌") return "新诗";
  return PUBLISHABLE_CATEGORIES.includes(category) ? category : "其他";
}

export function isPoetryCategory(value) {
  return ["诗歌", "新诗", "旧诗"].includes(String(value ?? "").trim());
}

export function validateStudentNumber(value) {
  return STUDENT_NUMBER_PATTERN.test(String(value ?? "").trim());
}

export function validatePassword(value) {
  const password = String(value ?? "");
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export function studentNumberToAuthEmail(value) {
  const studentNumber = String(value ?? "").trim();
  if (!validateStudentNumber(studentNumber)) {
    throw new Error("学号格式不正确");
  }
  return `${studentNumber}@${AUTH_EMAIL_DOMAIN}`;
}

function maskPart(value) {
  if (value.length <= 2) return "***";
  return `${value[0]}***${value.at(-1)}`;
}

export function maskEmail(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex !== normalized.lastIndexOf("@")) {
    throw new Error("找回邮箱格式不正确");
  }
  const domain = normalized.slice(atIndex + 1);
  const labels = domain.split(".");
  const topLevelDomain = labels.pop();
  const maskedDomain = labels.map(maskPart).join(".");
  return `${maskPart(normalized.slice(0, atIndex))}@${maskedDomain}.${topLevelDomain}`;
}

export function formatDate(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function getPenNameChangeAvailability(lastChangedAt, now = Date.now()) {
  const lastChanged = new Date(lastChangedAt).getTime();
  if (!lastChangedAt || Number.isNaN(lastChanged)) {
    return { canChange: true, nextChangeAt: null };
  }
  const current = new Date(now).getTime();
  const nextChangeAt = new Date(lastChanged + PEN_NAME_CHANGE_INTERVAL_MS);
  return {
    canChange: !Number.isNaN(current) && current >= nextChangeAt.getTime(),
    nextChangeAt: nextChangeAt.toISOString(),
  };
}

export function createExcerpt(value, limit = 96) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= limit) return normalized;
  return `${characters.slice(0, limit).join("")}…`;
}

export function countChineseText(value) {
  return Array.from(String(value ?? "").replace(/\s/g, "")).length;
}

export function buildCommentTree(comments = []) {
  const nodes = new Map(
    comments.map((comment) => [
      String(comment.id),
      { ...comment, replies: [] },
    ]),
  );
  const roots = [];

  for (const comment of comments) {
    const node = nodes.get(String(comment.id));
    const parent = comment.parent_id
      ? nodes.get(String(comment.parent_id))
      : null;
    if (parent && parent.id !== node.id) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  const byCreatedAt = (left, right) =>
    new Date(left.created_at ?? 0) - new Date(right.created_at ?? 0);
  const sortBranch = (branch) => {
    branch.sort(byCreatedAt);
    branch.forEach((comment) => sortBranch(comment.replies));
    return branch;
  };

  return sortBranch(roots);
}

export function parseRoute(hash = "#/") {
  const path = String(hash || "#/")
    .replace(/^#/, "")
    .split("?")[0]
    .replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);

  if (parts.length === 0) return { name: "home" };
  if (parts.length === 1 && parts[0] === "write") return { name: "write" };
  if (parts.length === 1 && parts[0] === "discussions") {
    return { name: "discussions" };
  }
  if (parts.length === 1 && parts[0] === "submissions") {
    return { name: "submissions" };
  }
  if (parts.length === 2 && parts[0] === "works") {
    return { name: "work", id: decodeURIComponent(parts[1]) };
  }
  if (parts.length === 2 && parts[0] === "authors") {
    return { name: "author", id: decodeURIComponent(parts[1]) };
  }
  if (parts.length === 2 && parts[0] === "account" && parts[1] === "security") {
    return { name: "account-security" };
  }
  if (parts.length === 3 && parts[0] === "works" && parts[2] === "versions") {
    return { name: "versions", id: decodeURIComponent(parts[1]) };
  }
  if (parts.length === 3 && parts[0] === "works" && parts[2] === "edit") {
    return { name: "editWork", id: decodeURIComponent(parts[1]) };
  }
  return { name: "not-found" };
}

export function filterAndSortWorks(works = [], filters = {}) {
  const query = String(filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
  const category = filters.category || "全部";
  const sort = filters.sort || "latest";

  const filtered = works.filter((work) => {
    const categoryMatches =
      category === "全部" || normalizeCategory(work.category) === category;
    const haystack = [
      work.title,
      work.excerpt,
      work.author_pen_name,
    ]
      .map((value) => String(value ?? "").toLocaleLowerCase("zh-CN"))
      .join("\n");
    return categoryMatches && (!query || haystack.includes(query));
  });

  const sorters = {
    latest: (left, right) =>
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0),
    likes: (left, right) =>
      Number(right.like_count ?? 0) - Number(left.like_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0),
    discussions: (left, right) =>
      Number(right.comment_count ?? 0) - Number(left.comment_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0),
  };

  return [...filtered].sort(sorters[sort] ?? sorters.latest);
}

export function searchWorks(works = [], filters = {}) {
  const query = String(filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
  const category = filters.category || "全部";
  const sort = filters.sort || "latest";

  const filtered = works.filter((work) => {
    const categoryMatches =
      category === "全部" || normalizeCategory(work.category) === category;
    const haystack = [
      work.title,
      work.excerpt,
      work.content,
      work.author_pen_name,
    ]
      .map((value) => String(value ?? "").toLocaleLowerCase("zh-CN"))
      .join("\n");
    return categoryMatches && (!query || haystack.includes(query));
  });

  const sorters = {
    latest: (left, right) =>
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
    likes: (left, right) =>
      Number(right.like_count ?? 0) - Number(left.like_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
    discussions: (left, right) =>
      Number(right.comment_count ?? 0) - Number(left.comment_count ?? 0) ||
      new Date(right.created_at ?? 0) - new Date(left.created_at ?? 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
  };

  return [...filtered].sort(sorters[sort] ?? sorters.latest);
}

export function escapeText(value) {
  return value == null ? "" : String(value);
}

// 展示串契约字符集：与 SQL create_quoted_comment 的 btrim 字符集 E' \t\r\n\v\f　' 完全一致。
// 刻意不含 NBSP（U+00A0）：JS 的 trim()/\s 会裁掉 NBSP，而 SQL btrim 不会，导致两端展示串偏移错位。
const DISPLAY_WHITESPACE = " \t\r\n\v\f　";
const DISPLAY_BLANK_LINE_RE = new RegExp(`\\n[${DISPLAY_WHITESPACE}]*\\n`, "g");
const DISPLAY_EDGE_TRIM_RE = new RegExp(
  `^[${DISPLAY_WHITESPACE}]+|[${DISPLAY_WHITESPACE}]+$`,
  "g",
);

// 作品正文 → 展示串段落：按空行分段、逐段去首尾空白、去空段。
// 与 SQL create_quoted_comment、前端 renderParagraphs 的展示串约定一致。
export function splitDisplayParagraphs(content) {
  return String(content ?? "")
    .split(DISPLAY_BLANK_LINE_RE)
    .map((paragraph) => paragraph.replace(DISPLAY_EDGE_TRIM_RE, ""))
    .filter(Boolean);
}

// 引用单位切分：新诗按行、旧诗按标点（换行也算分隔）、散文按句末标点。
// 返回 [{ text, start, end }]：start/end 为段落内码点偏移，text 为去首尾空白后的引文。
// 单位首尾空白与 SQL btrim 的字符集一致（ASCII 空格、\t\r\n\v\f），不裁 NBSP/全角空格：
// 散文段内的单个换行会落在单位首尾，若不裁掉，SQL 的 btrim(quote_text) 与 substr(展示串)
// 会因换行不对齐而判「引用原文与所选位置不符」。
export function splitQuoteUnits(paragraphText, category) {
  const chars = Array.from(String(paragraphText ?? ""));
  const isDelimiter = quoteUnitDelimiter(category);
  const units = [];
  let segStart = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (isDelimiter(chars[i])) {
      pushQuoteUnit(units, chars, segStart, i);
      segStart = i + 1;
    }
  }
  pushQuoteUnit(units, chars, segStart, chars.length);
  return units;
}

function quoteUnitDelimiter(category) {
  if (category === "旧诗") {
    return (ch) => ch === "\n" || "。，；：！？…".includes(ch);
  }
  if (isPoetryCategory(category)) return (ch) => ch === "\n";
  return (ch) => "。！？…".includes(ch);
}

function pushQuoteUnit(units, chars, rawStart, rawEnd) {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && QUOTE_EDGE_TRIM.includes(chars[start])) start += 1;
  while (end > start && QUOTE_EDGE_TRIM.includes(chars[end - 1])) end -= 1;
  if (end <= start) return;
  units.push({ text: chars.slice(start, end).join(""), start, end });
}

// 与 SQL btrim 默认字符集一致：仅 ASCII 空白，不含 NBSP/全角空格。
const QUOTE_EDGE_TRIM = " \t\r\n\v\f";

// 与 SQL btrim(string) 的默认行为一致：仅去首尾 ASCII 空格。
// 刻意不裁 NBSP/全角空格/换行等，避免与 SQL 存入正文的规范化产生差异。
export function trimAsciiSpaces(value) {
  return String(value ?? "").replace(/^ +| +$/g, "");
}

export function codepointLength(text) {
  return Array.from(String(text)).length;
}

export function codepointSlice(text, start, end) {
  return Array.from(String(text)).slice(start, end).join("");
}

// 浏览器 selection 偏移是 UTF-16 的；SQL 偏移按码点（char_length/substr）计算。
// 返回严格位于该 UTF-16 边界之前的码点数量（边界落在代理对中间时按前半处理）。
export function codepointIndexFromUtf16(text, utf16Offset) {
  const value = String(text);
  let codepoints = 0;
  let units = 0;
  for (const ch of value) {
    if (units + ch.length > utf16Offset) break;
    units += ch.length;
    codepoints += 1;
  }
  return codepoints;
}
