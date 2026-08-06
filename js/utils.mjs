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

export function escapeText(value) {
  return value == null ? "" : String(value);
}
