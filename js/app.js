import { config } from "./config.mjs";
import { createDataService } from "./data-service.mjs";
import {
  canShareExportFiles,
  downloadExportFile,
  exportWorkImages,
  shareExportFiles,
} from "./image-export.mjs";
import {
  createMobileFeedController,
  resolveHorizontalSwipe,
} from "./mobile-feed.mjs";
import {
  buildCommentTree,
  CATEGORIES,
  codepointLength,
  codepointSlice,
  countChineseText,
  createExcerpt,
  filterAndSortWorks,
  formatDate,
  formatDateTime,
  getPenNameChangeAvailability,
  isPoetryCategory,
  normalizeCategory,
  parseRoute,
  PUBLISHABLE_CATEGORIES,
  splitDisplayParagraphs,
  splitQuoteUnits,
  validatePassword,
  validateStudentNumber,
} from "./utils.mjs";

const service = createDataService(config);
const app = document.querySelector("#app");
const siteHeader = document.querySelector(".site-header");
const authDialog = document.querySelector("#authDialog");
const confirmDialog = document.querySelector("#confirmDialog");
const profileDialog = document.querySelector("#profileDialog");
const profileDialogContent = document.querySelector("#profileDialogContent");
const recoveryDialog = document.querySelector("#recoveryDialog");
const confirmMessage = document.querySelector("#confirmMessage");
const accountButton = document.querySelector("#accountButton");
const accountMenu = document.querySelector("#accountMenu");
const profileLink = document.querySelector("#profileLink");
const mobileProfileLink = document.querySelector("#mobileProfileLink");
const demoRibbon = document.querySelector("#demoRibbon");
const toast = document.querySelector("#toast");
const annotateDialog = document.querySelector("#annotateDialog");
const annotateQuoteText = document.querySelector("#annotateQuoteText");
const annotateContent = document.querySelector("#annotateContent");
const annotateFormMessage = document.querySelector("[data-annotate-message]");

const DRAFT_KEY = "wenyuan-writing-draft";
const PROFILE_RETURN_SENTINEL = "__current-profile__";
const SWIPE_CLICK_SUPPRESSION_MS = 2000;
const HOME_SESSION_KEY = "wenyuan-home-session";
const HOME_SCROLL_KEY = "wenyuan-home-scroll";
const mobileHomeMedia = window.matchMedia("(max-width: 760px)");
let previousRouteName = null;

const state = {
  session: null,
  works: [],
  settings: null,
  currentWork: null,
  currentExport: null,
  editingWork: null,
  filters: {
    query: "",
    category: "全部",
    sort: "latest",
  },
  browse: {
    works: [],
    nextCursor: null,
    loading: false,
    error: null,
    requestId: 0,
  },
  browseDiscussions: {
    items: [],
    nextCursor: null,
    loading: false,
  },
  discussionRequestId: 0,
  mobileFeed: {
    controller: null,
    signature: "",
    touch: null,
    suppressClick: false,
    suppressClickTimer: null,
  },
  confirmResolver: null,
  toastTimer: null,
  authReturnHash: null,
  accountSecurityReturnHash: null,
  accountSecurityPendingEmail: null,
  accountSecurityChangeStep: 0,
};

function element(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  const childList = Array.isArray(children) ? children : [children];

  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  if (options.htmlFor) node.htmlFor = options.htmlFor;
  if (options.id) node.id = options.id;
  if (options.href) node.setAttribute("href", options.href);
  if (options.type) node.setAttribute("type", options.type);
  if (options.name) node.setAttribute("name", options.name);
  if (options.value != null) node.value = String(options.value);
  if (options.placeholder) node.setAttribute("placeholder", options.placeholder);
  if (options.testId) node.dataset.testid = options.testId;
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      node.dataset[key] = String(value);
    });
  }
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      if (value === false || value == null) return;
      if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    });
  }

  childList.flat().forEach((child) => {
    if (child == null || child === false) return;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  });
  return node;
}

function replaceContent(target, children) {
  target.replaceChildren(...(Array.isArray(children) ? children : [children]));
}

function showToast(message, tone = "normal") {
  window.clearTimeout(state.toastTimer);
  toast.textContent = String(message);
  toast.dataset.tone = tone;
  toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function showLoading(message = "正在整理稿页") {
  replaceContent(
    app,
    element("div", { className: "loading-state", attrs: { role: "status" } }, [
      element("span", { className: "loading-rule" }),
      element("p", { text: message }),
    ]),
  );
}

function showError(title, message, retry) {
  const section = element("section", {
    className: "page-shell error-state",
    attrs: { "aria-labelledby": "error-title" },
  });
  section.append(
    element("p", { className: "eyebrow", text: "页面暂时没有整理好" }),
    element("h2", { id: "error-title", text: title }),
    element("p", { text: message }),
  );
  if (retry) {
    section.append(
      element("button", {
        className: "primary-button",
        type: "button",
        text: "重新加载",
        dataset: { action: "retry-route" },
      }),
    );
  }
  replaceContent(app, section);
}

function updateHeader() {
  demoRibbon.hidden = !service.isDemo;
  if (state.session) {
    accountButton.textContent = state.session.profile.pen_name;
    accountButton.dataset.action = "toggle-account-menu";
    profileLink.href = `#/authors/${encodeURIComponent(
      state.session.profile.id,
    )}`;
    mobileProfileLink.href = profileLink.href;
    delete mobileProfileLink.dataset.action;
    delete mobileProfileLink.dataset.returnHash;
  } else {
    accountButton.textContent = "登录";
    accountButton.dataset.action = "open-auth";
    accountMenu.hidden = true;
    mobileProfileLink.href = "#/";
    mobileProfileLink.dataset.action = "open-auth";
    mobileProfileLink.dataset.returnHash = PROFILE_RETURN_SENTINEL;
  }

  const route = parseRoute(window.location.hash);
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const isMobileNavigation = Boolean(link.closest(".mobile-bottom-nav"));
    const active = isMobileNavigation
      ? (link.dataset.nav === "home" && ["home", "work"].includes(route.name)) ||
        link.dataset.nav === route.name ||
        (link.dataset.nav === "my" &&
          route.name === "author" &&
          route.id === state.session?.profile?.id)
      : (link.dataset.nav === "home" &&
          ["home", "work", "author", "write"].includes(route.name)) ||
        link.dataset.nav === route.name;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function openAuth(tab = "login", returnHash = null) {
  state.authReturnHash = returnHash;
  switchAuthTab(tab);
  if (!authDialog.open) authDialog.showModal();
}

function switchAuthTab(tab) {
  const loginSelected = tab === "login";
  document.querySelector("#loginTab").setAttribute(
    "aria-selected",
    String(loginSelected),
  );
  document.querySelector("#registerTab").setAttribute(
    "aria-selected",
    String(!loginSelected),
  );
  document.querySelector("#loginPanel").hidden = !loginSelected;
  document.querySelector("#registerPanel").hidden = loginSelected;
  document.querySelectorAll("[data-form-message]").forEach((message) => {
    message.textContent = "";
  });
  if (tab === "register") {
    renderTurnstile(document.querySelector("#registerForm"));
  }
}

function closeAuth() {
  if (authDialog.open) authDialog.close();
}

function readTurnstileToken(form) {
  if (!config.turnstileSiteKey) return "demo-turnstile-token";
  const host = form.querySelector("[data-turnstile]");
  return host?.dataset.token || "";
}

async function renderTurnstile(form) {
  if (!config.turnstileSiteKey) return;
  const host = form.querySelector("[data-turnstile]");
  if (!host || host.dataset.rendered) return;
  if (!window.turnstile) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }
  host.dataset.rendered = "true";
  window.turnstile.render(host, {
    sitekey: config.turnstileSiteKey,
    callback: (token) => {
      host.dataset.token = token;
    },
  });
}

function requireVerifiedWrite(returnHash = window.location.hash) {
  if (!state.session) {
    openAuth("login", returnHash);
    return false;
  }
  if (state.session.accountSecurity?.state !== "verified") {
    state.accountSecurityReturnHash = returnHash;
    window.location.hash = "#/account/security";
    showToast("请先验证找回邮箱，再继续操作。", "info");
    return false;
  }
  return true;
}

function routeToAccountSecurityIfUnverified(error) {
  if (String(error?.message ?? "").includes("验证找回邮箱")) {
    state.accountSecurityReturnHash = window.location.hash;
    window.location.hash = "#/account/security";
    showToast("请先验证找回邮箱后再进行此操作。", "info");
    return true;
  }
  return false;
}

async function refreshSessionSecurity() {
  if (!state.session) return;
  state.session.accountSecurity = await service.getAccountSecurityStatus();
}

function openPasswordRecovery() {
  const requestForm = document.querySelector("#recoveryRequestForm");
  const completeForm = document.querySelector("#recoveryCompleteForm");
  requestForm.hidden = false;
  completeForm.hidden = true;
  requestForm.reset();
  completeForm.reset();
  document
    .querySelectorAll(
      '[data-form-message="recovery-request"], [data-form-message="recovery-complete"]',
    )
    .forEach((message) => {
      message.textContent = "";
    });
  if (!recoveryDialog.open) recoveryDialog.showModal();
  renderTurnstile(requestForm);
  requestForm.querySelector('[name="studentNumber"]').focus();
}

function closePasswordRecovery() {
  if (recoveryDialog.open) recoveryDialog.close();
}

function closeProfileEditor() {
  if (profileDialog.open) profileDialog.close();
}

function createProfileEditor(profile) {
  const penNameAvailability = getPenNameChangeAvailability(
    profile.pen_name_changed_at,
  );
  const penNameHint = penNameAvailability.canChange
    ? "笔名每七天最多修改一次；保存新笔名后将开始冷却。"
    : `笔名正在冷却，可于 ${formatDateTime(
        penNameAvailability.nextChangeAt,
      )} 后再次修改。`;
  const form = element("form", {
    className: "profile-form",
    id: "profileForm",
    dataset: { profileId: profile.id },
  });
  const heading = element("h2", {
    id: "profileDialogTitle",
    text: "编辑公开资料",
  });
  const head = element("div", { className: "modal-head" }, [
    element("div", { className: "profile-dialog-title" }, [
      element("p", { className: "eyebrow", text: "个人主页" }),
      heading,
    ]),
    element("button", {
      className: "profile-dialog-close",
      type: "button",
      text: "×",
      dataset: { action: "close-profile-editor" },
      attrs: {
        "aria-label": "关闭编辑资料窗口",
        title: "关闭",
      },
    }),
  ]);

  const fields = element("div", { className: "profile-editor-fields" }, [
    element("div", { className: "profile-field" }, [
      element("label", {}, [
        element("span", { text: "笔名" }),
        element("input", {
          name: "penName",
          value: profile.pen_name,
          attrs: {
            required: true,
            maxlength: 24,
            disabled: !penNameAvailability.canChange,
            "aria-describedby": "pen-name-hint",
          },
        }),
      ]),
      element("p", {
        id: "pen-name-hint",
        className: "profile-meta",
        text: penNameHint,
      }),
    ]),
    element("div", { className: "profile-field profile-bio-field" }, [
      element("label", {}, [
        element("span", { text: "个人简介" }),
        element("textarea", {
          name: "bio",
          attrs: { maxlength: 240, rows: 4 },
        }),
      ]),
    ]),
  ]);
  fields.querySelector("textarea").textContent = profile.bio ?? "";

  const footer = element("div", { className: "profile-dialog-actions" }, [
    element("button", {
      className: "primary-button",
      type: "submit",
      text: "保存公开资料",
    }),
  ]);

  form.append(head, fields, footer);
  return form;
}

function openProfileEditor() {
  if (!state.session?.profile) return;
  replaceContent(profileDialogContent, createProfileEditor(state.session.profile));
  if (!profileDialog.open) profileDialog.showModal();
  profileDialog.querySelector("input:not(:disabled), textarea")?.focus();
}

function requestConfirmation(message) {
  confirmMessage.textContent = message;
  if (!confirmDialog.open) confirmDialog.showModal();
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

function finishConfirmation(value) {
  if (confirmDialog.open) confirmDialog.close();
  state.confirmResolver?.(value);
  state.confirmResolver = null;
}

function renderMeta(items) {
  const meta = element("div", { className: "work-meta" });
  items.forEach((item) => {
    meta.append(element("span", { text: item }));
  });
  return meta;
}

function createWorkRow(work) {
  const article = element("article", {
    className: "work-row",
    dataset: { workId: work.id },
  });
  const margin = element("aside", {
    className: "work-margin",
    attrs: { "aria-label": "作品分类与编辑标记" },
  });
  margin.append(element("span", { text: normalizeCategory(work.category) }));
  if (work.is_featured) {
    margin.append(
      element("span", {
        className: "featured-mark",
        text: "编辑推荐",
      }),
    );
  }

  const body = element("div", { className: "work-body" });
  const title = element("h3");
  title.append(
    element("a", {
      href: `#/works/${encodeURIComponent(work.id)}`,
      text: work.title,
    }),
  );
  const author = element("a", {
    className: "meta-link",
    href: `#/authors/${encodeURIComponent(work.author_id)}`,
    text: work.author_pen_name,
  });
  const meta = element("div", { className: "work-meta" }, [
    author,
    element("span", { text: formatDate(work.created_at) }),
    element("span", { text: `喜欢 ${work.like_count}` }),
    element("span", { text: `讨论 ${work.comment_count}` }),
  ]);
  body.append(
    title,
    meta,
    element("p", {
      className: "work-excerpt",
      text: work.excerpt || createExcerpt(work.content, 96),
    }),
  );
  article.append(margin, body);
  return article;
}

function createFeaturedItem(work, index) {
  const item = element("li", { className: "featured-item" });
  const content = element("div");
  const heading = element("h3");
  heading.append(
    element("a", {
      href: `#/works/${encodeURIComponent(work.id)}`,
      text: work.title,
    }),
  );
  content.append(
    heading,
    element("p", {
      text: `${work.author_pen_name} · ${normalizeCategory(work.category)} · 喜欢 ${work.like_count}`,
    }),
  );
  item.append(
    element("span", {
      className: "featured-index",
      text: String(index + 1).padStart(2, "0"),
    }),
    content,
  );
  return item;
}

function buildActiveDiscussions() {
  return [...state.browseDiscussions.items]
    .sort(
      (left, right) =>
        new Date(right.created_at) - new Date(left.created_at),
    )
    .slice(0, 4);
}

function createDiscussionItem(discussion) {
  const item = element("li", { className: "discussion-item" });
  const heading = element("h3");
  heading.append(
    element("a", {
      href: `#/works/${encodeURIComponent(discussion.work_id)}`,
      text: discussion.work_title,
    }),
  );
  item.append(
    heading,
    element("p", {
      text: discussion.is_deleted
        ? "一条评论已删除，回复仍被保留。"
        : createExcerpt(discussion.content, 46),
    }),
    element("div", { className: "discussion-meta" }, [
      element("span", { text: discussion.user_pen_name }),
      element("span", { text: formatDate(discussion.created_at) }),
    ]),
  );
  return item;
}

function createFilterBand() {
  const band = element("section", {
    className: "filter-band",
    attrs: { "aria-label": "搜索与筛选作品" },
  });
  const form = element("form", {
    className: "filter-form",
    id: "homeFilters",
  });
  const search = element("div", { className: "search-field" });
  search.append(
    element("input", {
      name: "query",
      value: state.filters.query,
      placeholder: "搜索标题、摘要或作者",
      attrs: { "aria-label": "搜索作品" },
    }),
    element("button", { type: "submit", text: "搜索" }),
  );

  const categoryLabel = element("label", { className: "field-label" }, [
    element("span", { text: "分类" }),
  ]);
  const categorySelect = element("select", {
    name: "category",
    attrs: { "aria-label": "按分类筛选" },
  });
  CATEGORIES.forEach((category) => {
    categorySelect.append(
      element("option", {
        value: category,
        text: category,
        attrs: { selected: state.filters.category === category },
      }),
    );
  });
  categoryLabel.append(categorySelect);

  const sortLabel = element("label", { className: "field-label" }, [
    element("span", { text: "排序" }),
  ]);
  const sortSelect = element("select", {
    name: "sort",
    attrs: { "aria-label": "作品排序" },
  });
  [
    ["latest", "最新发布"],
    ["likes", "最多喜欢"],
    ["discussions", "最多讨论"],
  ].forEach(([value, label]) => {
    sortSelect.append(
      element("option", {
        value,
        text: label,
        attrs: { selected: state.filters.sort === value },
      }),
    );
  });
  sortLabel.append(sortSelect);
  form.append(search, categoryLabel, sortLabel);
  band.append(form);
  return band;
}

function calculateAuthors(works = []) {
  const map = new Map();
  works.forEach((work) => {
    const current = map.get(work.author_id) ?? {
      id: work.author_id,
      name: work.author_pen_name,
      works: 0,
      likes: 0,
    };
    current.works += 1;
    current.likes += work.like_count;
    map.set(work.author_id, current);
  });
  return [...map.values()].sort(
    (left, right) => right.likes - left.likes || right.works - left.works,
  );
}

function renderCommunityRail(works = state.browse.works) {
  const rail = element("aside", {
    className: "community-rail",
    attrs: { "aria-label": "社区动态" },
  });
  const authorsSection = element("section", { className: "rail-section" }, [
    element("p", { className: "eyebrow", text: "COMMUNITY" }),
    element("h3", { text: "活跃作者" }),
  ]);
  const authorsList = element("ol", { className: "rail-list" });
  calculateAuthors(works)
    .slice(0, 5)
    .forEach((author) => {
      const item = element("li");
      item.append(
        element("a", {
          href: `#/authors/${encodeURIComponent(author.id)}`,
          text: author.name,
        }),
        element("span", { text: `${author.likes} 获赞` }),
      );
      authorsList.append(item);
    });
  authorsSection.append(authorsList);

  const hotSection = element("section", { className: "rail-section" }, [
    element("p", { className: "eyebrow", text: "READING" }),
    element("h3", { text: "此刻被阅读" }),
  ]);
  const hotList = element("ol", { className: "rail-list" });
  filterAndSortWorks(works, {
    query: "",
    category: "全部",
    sort: "likes",
  })
    .slice(0, 4)
    .forEach((work) => {
      const item = element("li");
      item.append(
        element("a", {
          href: `#/works/${encodeURIComponent(work.id)}`,
          text: work.title,
        }),
        element("span", { text: `${work.like_count}` }),
      );
      hotList.append(item);
    });
  hotSection.append(hotList);

  const submission = state.settings?.submission ?? {
    title: "长期征稿",
    body: "新诗、旧诗、散文、小说、随笔与其他文字均可投稿。",
  };
  const note = element("section", { className: "submission-note" }, [
    element("p", { className: "eyebrow", text: "OPEN CALL" }),
    element("h3", { text: submission.title }),
    element("p", { text: submission.body }),
    element("a", {
      className: "inline-link",
      href: "#/submissions",
      text: "阅读征稿说明",
    }),
  ]);
  rail.append(authorsSection, hotSection, note);
  return rail;
}

function renderDesktopHome() {
  const shell = element("div", { className: "page-shell desktop-home" });
  const browseWorks = state.browse.works;
  const note = state.settings?.editor_note ?? {
    title: "把写下的交给彼此",
    body: "这里持续收录社员的新作，也保留认真、具体、彼此尊重的讨论。",
  };
  const hero = element("section", { className: "hero" });
  const heroTitle = element("div", {}, [
    element("p", {
      className: "eyebrow",
      text: "NORTHWESTERN POLYTECHNICAL UNIVERSITY · LITERATURE",
    }),
  ]);
  const h1 = element("h1", { attrs: { id: "home-title" } });
  h1.append("让作品", element("em", { text: "被读见" }));
  heroTitle.append(h1);
  const intro = element("div", { className: "hero-intro" }, [
    element("p", {
      text: "一个持续更新的社员作品交流空间。写作不必等到某个刊期，讨论也不止停在一句赞美。",
    }),
    element("div", { className: "hero-actions" }, [
      element("a", {
        className: "write-link",
        href: "#/write",
        text: "发表新作",
      }),
      element("a", {
        className: "inline-link",
        href: "#/discussions",
        text: "看看正在讨论什么",
      }),
    ]),
  ]);
  hero.append(heroTitle, intro);

  const editorial = element("section", { className: "editorial-note" }, [
    element("div", {}, [
      element("p", { className: "eyebrow", text: "编辑部短消息" }),
      element("h2", { text: note.title }),
    ]),
    element("p", { text: note.body }),
  ]);

  const leadGrid = element("section", { className: "lead-grid" });
  const featuredPanel = element("div", { className: "lead-panel" }, [
    element("div", { className: "section-kicker" }, [
      element("h2", { text: "编辑推荐" }),
      element("span", { text: "不定期更新" }),
    ]),
  ]);
  const featuredList = element("ol", { className: "featured-list" });
  const featuredWorks = browseWorks
    .filter((work) => work.is_featured)
    .slice(0, 3);
  (featuredWorks.length ? featuredWorks : browseWorks.slice(0, 3)).forEach(
    (work, index) => featuredList.append(createFeaturedItem(work, index)),
  );
  featuredPanel.append(featuredList);

  const discussionsPanel = element("div", { className: "lead-panel" }, [
    element("div", { className: "section-kicker" }, [
      element("h2", { text: "正在讨论" }),
      element("a", {
        className: "inline-link",
        href: "#/discussions",
        text: "全部讨论",
      }),
    ]),
  ]);
  const discussionList = element("ol", { className: "discussion-list" });
  const active = buildActiveDiscussions();
  if (active.length) {
    active.slice(0, 3).forEach((item) => {
      discussionList.append(createDiscussionItem(item));
    });
  } else {
    discussionList.append(
      element("li", {
        className: "discussion-item",
        text: "第一条认真评论正在等待它的读者。",
      }),
    );
  }
  discussionsPanel.append(discussionList);
  leadGrid.append(featuredPanel, discussionsPanel);

  const content = element("section", { className: "content-grid" });
  const worksSection = element("div");
  worksSection.append(
    element("div", { className: "section-heading" }, [
      element("div", {}, [
        element("p", { className: "eyebrow", text: "NEW WRITING" }),
        element("h2", { text: "持续更新的新作" }),
      ]),
      element("p", { text: `已加载 ${browseWorks.length} 篇` }),
    ]),
  );
  const list = element("div", {
    className: "work-list",
    testId: "work-list",
  });
  // 有作品 → 列表；加载失败 → 独立错误块（不再同时显示空态）；
  // 无作品且无错误 → 空态。三者互斥。
  if (browseWorks.length) {
    browseWorks.forEach((work) => list.append(createWorkRow(work)));
  } else if (!state.browse.error) {
    list.append(
      element("div", { className: "empty-state" }, [
        element("h2", { text: "没有找到对应作品" }),
        element("p", { text: "换一个关键词或分类，再试一次。" }),
        element("button", {
          className: "secondary-button",
          type: "button",
          text: "清除筛选",
          dataset: { action: "reset-filters" },
        }),
      ]),
    );
  }
  worksSection.append(list);
  if (state.browse.error) {
    worksSection.append(
      element("div", { className: "empty-state" }, [
        element("p", { text: "加载新一批作品失败。" }),
        element("button", {
          className: "secondary-button",
          type: "button",
          text: "重试加载",
          dataset: { action: "retry-browse" },
        }),
      ]),
    );
  } else if (state.browse.nextCursor) {
    worksSection.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "再读十篇",
          dataset: { action: "load-more" },
        }),
      ]),
    );
  }
  content.append(worksSection, renderCommunityRail(browseWorks));

  shell.append(hero, editorial, leadGrid, createFilterBand(), content);
  replaceContent(app, shell);
}

function resolveAuthReturnHash(returnTarget) {
  if (returnTarget !== PROFILE_RETURN_SENTINEL) return returnTarget;
  if (!state.session?.profile?.id) return null;
  return `#/authors/${encodeURIComponent(state.session.profile.id)}`;
}

function getPreparedExport(trigger) {
  const prepared = state.currentExport;
  if (!prepared || prepared.workId !== trigger.dataset.workId) {
    showToast("已生成的图片已经失效，请重新生成。");
    return null;
  }
  return prepared;
}

function cleanupPreparedExport() {
  const prepared = state.currentExport;
  state.currentExport = null;
  prepared?.previewUrls?.forEach((url) => URL.revokeObjectURL(url));
}

function renderExportActions(prepared, container) {
  const panel = element("section", {
    className: "export-results",
    attrs: { "aria-label": "分享或保存作品图片" },
  });
  panel.append(
    element("h3", { text: `图片已经生成 · ${prepared.files.length} 页` }),
    element("p", { text: "请点击下方按钮分享或保存图片。" }),
  );

  const previews = element("div", { className: "export-previews" });
  prepared.previewUrls.forEach((url, pageIndex) => {
    previews.append(
      element("figure", { className: "export-preview" }, [
        element("img", {
          className: "export-preview-image",
          attrs: {
            src: url,
            alt: `《${prepared.work.title}》第 ${pageIndex + 1} 页预览`,
            width: "1080",
            height: "1920",
          },
        }),
        element("figcaption", {
          text: `第 ${pageIndex + 1} / ${prepared.files.length} 页`,
        }),
      ]),
    );
  });
  panel.append(previews);

  const actions = element("div", { className: "export-result-actions" });
  if (canShareExportFiles(prepared.files)) {
    actions.append(
      element("button", {
        className: "primary-button",
        type: "button",
        text: "分享作品图片",
        dataset: { action: "share-export", workId: prepared.workId },
      }),
    );
  }
  actions.append(
    element("button", {
      className: "secondary-button",
      type: "button",
      text: prepared.files.length > 1 ? "保存全部图片" : "保存图片",
      dataset: { action: "save-export", workId: prepared.workId },
    }),
  );

  if (prepared.files.length > 1) {
    prepared.files.forEach((file, pageIndex) => {
      actions.append(
        element("button", {
          className: "secondary-button",
          type: "button",
          text: `保存第 ${pageIndex + 1} 页`,
          dataset: {
            action: "save-export-page",
            workId: prepared.workId,
            pageIndex,
          },
        }),
      );
    });
  }

  panel.append(actions);
  container.replaceChildren(panel);
}

function createMobileCategoryStrip() {
  const strip = element("nav", {
    className: "mobile-category-strip",
    attrs: { "aria-label": "作品分类" },
  });
  CATEGORIES.forEach((category) => {
    strip.append(
      element("button", {
        type: "button",
        text: category,
        dataset: { action: "mobile-category", category },
        attrs: {
          "aria-pressed": String(state.filters.category === category),
        },
      }),
    );
  });
  return strip;
}

function createMobileSearchBand() {
  const band = element("section", {
    className: "filter-band mobile-search-band",
    attrs: { "aria-label": "搜索作品" },
  });
  const form = element("form", {
    className: "filter-form",
    id: "homeFilters",
  });
  const search = element("div", { className: "search-field" });
  search.append(
    element("input", {
      name: "query",
      value: state.filters.query,
      placeholder: "搜索标题、摘要或作者",
      attrs: { "aria-label": "搜索作品" },
    }),
    element("button", { type: "submit", text: "搜索" }),
  );
  form.append(search);
  band.append(form);
  return band;
}

function buildMobileFeedSignature() {
  // 签名只跟随筛选条件变化；同一筛选下预取追加的新批次不应重置队列。
  return JSON.stringify([
    state.filters.category,
    state.filters.query,
    state.filters.sort,
  ]);
}

function truncatePoetryForCard(content, limit = 280) {
  const characters = Array.from(String(content ?? "").trim());
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, limit).join("")}\n……`;
}

function moveMobileFeed(direction) {
  const controller = state.mobileFeed.controller;
  if (!controller) return false;
  const currentId = controller.current()?.id;
  const work =
    direction === "next" ? controller.next() : controller.previous();
  if (!work || work.id === currentId) return false;
  renderMobileHome();
  window.requestAnimationFrame(() => {
    document.querySelector("[data-mobile-work-card]")?.focus({
      preventScroll: true,
    });
  });
  return true;
}

function clearMobileFeedClickSuppression() {
  state.mobileFeed.suppressClick = false;
  if (state.mobileFeed.suppressClickTimer != null) {
    window.clearTimeout(state.mobileFeed.suppressClickTimer);
    state.mobileFeed.suppressClickTimer = null;
  }
}

function armMobileFeedClickSuppression() {
  clearMobileFeedClickSuppression();
  state.mobileFeed.suppressClick = true;
  state.mobileFeed.suppressClickTimer = window.setTimeout(
    clearMobileFeedClickSuppression,
    SWIPE_CLICK_SUPPRESSION_MS,
  );
}

function attachMobileFeedInteractions(card, work) {
  card.addEventListener("click", (event) => {
    if (state.mobileFeed.suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      clearMobileFeedClickSuppression();
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("a, button")
    ) {
      return;
    }
    window.location.hash = `#/works/${encodeURIComponent(work.id)}`;
  });

  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveMobileFeed(event.key === "ArrowRight" ? "next" : "previous");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      window.location.hash = `#/works/${encodeURIComponent(work.id)}`;
    }
  });

  card.addEventListener(
    "touchstart",
    (event) => {
      clearMobileFeedClickSuppression();
      const touch = event.touches[0];
      if (!touch) return;
      state.mobileFeed.touch = {
        startX: touch.clientX,
        startY: touch.clientY,
        endX: touch.clientX,
        endY: touch.clientY,
      };
    },
    { passive: true },
  );

  card.addEventListener(
    "touchmove",
    (event) => {
      const touch = event.touches[0];
      if (!touch || !state.mobileFeed.touch) return;
      state.mobileFeed.touch.endX = touch.clientX;
      state.mobileFeed.touch.endY = touch.clientY;
    },
    { passive: true },
  );

  card.addEventListener(
    "touchend",
    (event) => {
      const gesture = state.mobileFeed.touch;
      const touch = event.changedTouches[0];
      state.mobileFeed.touch = null;
      if (!gesture) return;
      const deltaX = (touch?.clientX ?? gesture.endX) - gesture.startX;
      const deltaY = (touch?.clientY ?? gesture.endY) - gesture.startY;
      const direction = resolveHorizontalSwipe(deltaX, deltaY);
      if (!direction) return;
      armMobileFeedClickSuppression();
      moveMobileFeed(direction);
    },
    { passive: true },
  );

  card.addEventListener(
    "touchcancel",
    () => {
      state.mobileFeed.touch = null;
    },
    { passive: true },
  );
}

function createMobileWorkCard(work) {
  const poetry = isPoetryCategory(work.category);
  const card = element("article", {
    className: "mobile-work-card",
    id: "mobile-work-card",
    dataset: {
      mobileWorkCard: "",
      workId: work.id,
    },
    attrs: {
      tabindex: "0",
      role: "link",
      "aria-label": `阅读《${work.title}》`,
    },
  });
  const categoryLine = element("div", { className: "mobile-work-category" }, [
    element("span", { text: normalizeCategory(work.category) }),
    work.is_featured
      ? element("span", { className: "mobile-featured-mark", text: "编辑推荐" })
      : null,
  ]);
  const heading = element("h2");
  heading.append(
    element("a", {
      href: `#/works/${encodeURIComponent(work.id)}`,
      text: work.title,
    }),
  );
  const author = element("a", {
    href: `#/authors/${encodeURIComponent(work.author_id)}`,
    text: work.author_pen_name,
  });
  const copy = poetry
    ? truncatePoetryForCard(work.content)
    : work.excerpt || createExcerpt(work.content, 180);

  card.append(
    categoryLine,
    heading,
    element("div", { className: "mobile-work-byline" }, [
      author,
      element("span", { text: formatDate(work.created_at) }),
    ]),
    element("p", {
      className: `mobile-work-copy ${
        poetry ? "mobile-work-copy--poetry" : "mobile-work-copy--prose"
      }`,
      text: copy,
    }),
    element("div", { className: "mobile-work-footer" }, [
      element("span", { text: `喜欢 ${work.like_count}` }),
      element("span", { text: `讨论 ${work.comment_count}` }),
      element("span", { text: "轻触阅读全文" }),
    ]),
  );
  attachMobileFeedInteractions(card, work);
  return card;
}

function maybePrefetchMobileNext() {
  if (state.browse.loading || !state.browse.nextCursor) return;
  if (state.browse.error) return;
  const controller = state.mobileFeed.controller;
  if (!controller) return;
  // 剩余可展示条目 ≤ 2 时预取下一批，保证连续滑动不被分页打断。
  if (controller.position() >= Math.max(state.browse.works.length - 3, 0)) {
    loadMoreWorks();
  }
}

function renderMobileHome() {
  const filtered = state.browse.works;
  const signature = buildMobileFeedSignature();
  if (!state.mobileFeed.controller) {
    state.mobileFeed.controller = createMobileFeedController(filtered);
    state.mobileFeed.signature = signature;
  } else if (signature !== state.mobileFeed.signature) {
    state.mobileFeed.controller.reset(filtered);
    state.mobileFeed.signature = signature;
  } else {
    state.mobileFeed.controller.append(filtered);
  }

  maybePrefetchMobileNext();

  const shell = element("div", { className: "page-shell mobile-home" });
  const masthead = element("header", { className: "mobile-feed-masthead" }, [
    element("p", { className: "eyebrow", text: "ONE PAGE · ONE VOICE" }),
    element("h1", { id: "home-title", text: "让作品被读见" }),
    element("p", { text: "左右轻扫换一篇，向上滑动仍可浏览页面。" }),
  ]);
  const filterPanel = element("details", {
    className: "mobile-feed-filters",
  });
  filterPanel.append(
    element("summary", { text: "搜索作品" }),
    createMobileSearchBand(),
  );
  const stage = element("section", {
    className: "mobile-feed-stage",
    attrs: {
      "aria-label": "移动作品推荐",
      "aria-live": "polite",
    },
  });
  const current = state.mobileFeed.controller.current();

  if (current) {
    const previousDisabled = state.mobileFeed.controller.isAtStart();
    const nextDisabled = state.mobileFeed.controller.isAtEnd();
    stage.append(
      element("div", { className: "mobile-feed-rule" }, [
        element("span", { text: "文苑稿页" }),
        element("span", { text: "横向滑动翻页" }),
      ]),
      createMobileWorkCard(current),
      element(
        "nav",
        {
          className: "mobile-feed-controls",
          attrs: { "aria-label": "切换作品" },
        },
        [
          element("button", {
            className: "mobile-feed-control",
            type: "button",
            text: "← 上一篇",
            dataset: { action: "mobile-feed-previous" },
            attrs: {
              "aria-controls": "mobile-work-card",
              disabled: previousDisabled,
              "aria-disabled": String(previousDisabled),
            },
          }),
          element("button", {
            className: "mobile-feed-control",
            type: "button",
            text: "下一篇 →",
            dataset: { action: "mobile-feed-next" },
            attrs: {
              "aria-controls": "mobile-work-card",
              disabled: nextDisabled,
              "aria-disabled": String(nextDisabled),
            },
          }),
        ],
      ),
    );
  } else if (!state.browse.error) {
    stage.append(
      element("div", { className: "empty-state" }, [
        element("h2", { text: "没有找到对应作品" }),
        element("p", { text: "换一个关键词或分类，再试一次。" }),
        element("button", {
          className: "secondary-button",
          type: "button",
          text: "清除筛选",
          dataset: { action: "reset-filters" },
        }),
      ]),
    );
  }

  if (state.browse.error) {
    // 预取/续载失败：已有作品时重试续载下一批，无作品时重置重载
    stage.append(
      element("div", { className: "empty-state" }, [
        element("p", { text: "加载新一批作品失败。" }),
        element("button", {
          className: "secondary-button",
          type: "button",
          text: "重试加载",
          dataset: {
            action: filtered.length ? "retry-browse-more" : "retry-browse",
          },
        }),
      ]),
    );
  }

  shell.append(masthead, createMobileCategoryStrip(), filterPanel, stage);
  replaceContent(app, shell);
}

function renderHome() {
  if (mobileHomeMedia.matches) {
    renderMobileHome();
    return;
  }
  renderDesktopHome();
}

function createPageHeader(eyebrow, title, description) {
  return element("header", { className: "page-header" }, [
    element("div", {}, [
      element("p", { className: "eyebrow", text: eyebrow }),
      element("h1", { text: title }),
    ]),
    element("p", { text: description }),
  ]);
}

function renderParagraphs(content, category) {
  const isPoetry = isPoetryCategory(category);
  const body = element("article", {
    className: `reading-body ${
      isPoetry ? "reading-body--poetry" : "reading-body--prose"
    }`,
  });
  splitDisplayParagraphs(content).forEach((paragraph) => {
    body.append(element("p", { text: paragraph }));
  });
  return body;
}

function renderAnnotatableBody(content, category) {
  const isPoetry = isPoetryCategory(category);
  const body = element("article", {
    className: `reading-body ${
      isPoetry ? "reading-body--poetry" : "reading-body--prose"
    }`,
  });
  splitDisplayParagraphs(content).forEach((paragraph) => {
    body.append(renderParagraphWithUnits(paragraph, category));
  });
  return body;
}

function renderParagraphWithUnits(paragraph, category) {
  const p = document.createElement("p");
  const chars = Array.from(paragraph);
  let cursor = 0;
  splitQuoteUnits(paragraph, category).forEach((unit) => {
    if (unit.start > cursor) {
      p.append(document.createTextNode(chars.slice(cursor, unit.start).join("")));
    }
    const span = element("span", {
      className: "annotate-unit",
      dataset: { action: "annotate-unit", start: unit.start, end: unit.end },
    });
    span.textContent = unit.text;
    p.append(span);
    cursor = unit.end;
  });
  if (cursor < chars.length) {
    p.append(document.createTextNode(chars.slice(cursor).join("")));
  }
  return p;
}

function userCanManage(authorId) {
  return Boolean(
    state.session &&
      (state.session.profile.id === authorId ||
        state.session.profile.role === "admin"),
  );
}

function setFeaturedLocally(workId, featured) {
  const normalizedId = String(workId);
  const apply = (work) => {
    if (work && String(work.id) === normalizedId) work.is_featured = featured;
  };
  state.works.forEach(apply);
  state.browse.works.forEach(apply);
  apply(state.currentWork);

  const button = document.querySelector(
    `[data-action="toggle-featured"][data-work-id="${CSS.escape(normalizedId)}"]`,
  );
  if (button) {
    button.dataset.featured = String(featured);
    button.textContent = featured ? "取消推荐" : "设为推荐";
    button.setAttribute("aria-pressed", String(featured));
  }

  const margin = document.querySelector(".reading-margin");
  const marker = margin?.querySelector(".featured-mark");
  if (featured && margin && !marker) {
    margin.append(element("p", { className: "featured-mark", text: "编辑推荐" }));
  } else if (!featured) {
    marker?.remove();
  }
}

function createCommentItem(comment, workId, depth = 0) {
  const item = element("li", {
    className: "comment-item",
    dataset: { commentId: comment.id },
  });
  const author = element("a", {
    className: "comment-author",
    href: `#/authors/${encodeURIComponent(comment.user_id)}`,
    text: comment.user_pen_name,
  });
  const head = element("div", { className: "comment-head" }, [
    author,
    element("time", {
      className: "comment-time",
      text: formatDate(comment.created_at),
      attrs: { datetime: comment.created_at },
    }),
  ]);
  const content = element("p", {
    className: comment.is_deleted
      ? "comment-content deleted-comment"
      : "comment-content",
    text: comment.is_deleted ? "该评论已由作者删除" : comment.content,
  });
  item.append(head, content);

  if (!comment.is_deleted) {
    const actions = element("div", { className: "comment-actions" });
    if (state.session) {
      actions.append(
        element("button", {
          type: "button",
          text: "回复",
          dataset: { action: "toggle-reply", commentId: comment.id },
        }),
      );
    }
    if (
      state.session &&
      (state.session.profile.id === comment.user_id ||
        state.session.profile.role === "admin")
    ) {
      actions.append(
        element("button", {
          type: "button",
          text: "删除",
          dataset: { action: "delete-comment", commentId: comment.id, workId },
        }),
      );
    }
    item.append(actions);
  }

  if (state.session) {
    const replyForm = element("form", {
      className: "reply-form",
      dataset: { replyForm: comment.id, workId },
      attrs: { hidden: true },
    });
    replyForm.append(
      element("textarea", {
        name: "content",
        placeholder: `回复 ${comment.user_pen_name}`,
        attrs: { required: true, maxlength: 2000, "aria-label": "回复内容" },
      }),
      element("button", {
        className: "primary-button",
        type: "submit",
        text: "发表回复",
      }),
    );
    item.append(replyForm);
  }

  if (comment.replies?.length) {
    const replies = element("ol", { className: "comment-replies" });
    comment.replies.forEach((reply) => {
      replies.append(createCommentItem(reply, workId, depth + 1));
    });
    item.append(replies);
  }
  return item;
}

let annotateButton = null;
let annotateMode = false;
let pendingAnnotation = null;

// 返回段落相对其所在可批注正文的展示串码点偏移（每个前置段落长度 + 1 个 \n）。
function paragraphDisplayOffset(paragraph, body) {
  const paragraphs = Array.from(body.querySelectorAll("p"));
  let offset = 0;
  for (const p of paragraphs) {
    if (p === paragraph) return offset;
    offset += codepointLength(p.textContent) + 1;
  }
  return offset;
}

// 把选区容器节点 + 偏移换算为段落 textContent 内的码点偏移。
// 正文段落被 .annotate-unit span 包裹后，anchorNode/focusNode 常是 span 内的文本节点，
// selection.anchorOffset/focusOffset 相对该节点而非段落；用 Range 从段首量到该位置。
// 该方式同样正确处理容器为元素的情况（如选区恰好跨到 span 整体时 anchorNode 是 span）。
function selectionToCodePointOffset(container, offset, paragraph) {
  const range = document.createRange();
  range.setStart(paragraph, 0);
  range.setEnd(container, offset);
  return codepointLength(range.toString());
}

function computeQuoteSelection(versionId) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const body = document.querySelector("[data-annotatable]");
  if (!body) return null;
  const anchorPara = selection.anchorNode?.parentElement?.closest("p");
  const focusPara = selection.focusNode?.parentElement?.closest("p");
  if (!anchorPara || anchorPara !== focusPara) {
    return { error: "请在同一段落内选择连续文字" };
  }
  if (!body.contains(anchorPara)) return null;
  const text = anchorPara.textContent;
  const startCp = selectionToCodePointOffset(
    selection.anchorNode,
    selection.anchorOffset,
    anchorPara,
  );
  const endCp = selectionToCodePointOffset(
    selection.focusNode,
    selection.focusOffset,
    anchorPara,
  );
  const start = Math.min(startCp, endCp);
  const end = Math.max(startCp, endCp);
  if (end <= start) return null;
  const paragraphOffset = paragraphDisplayOffset(anchorPara, body);
  return {
    quoteText: codepointSlice(text, start, end),
    startOffset: paragraphOffset + start,
    endOffset: paragraphOffset + end,
    versionId,
  };
}

function showAnnotateButton(event) {
  const body = event.target?.closest?.("[data-annotatable]");
  if (!body) return;
  const selection = computeQuoteSelection(body.dataset.versionId);
  if (!selection) return;
  if (selection.error) {
    showToast(selection.error);
    return;
  }
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  if (!annotateButton) {
    annotateButton = element("button", {
      className: "primary-button annotate-float",
      type: "button",
      text: "添加批注",
      dataset: { action: "open-annotation" },
    });
    annotateButton.style.position = "fixed";
    document.body.append(annotateButton);
  }
  annotateButton.style.left = `${Math.max(8, rect.left)}px`;
  annotateButton.style.top = `${rect.bottom + 8}px`;
  annotateButton.dataset.selection = JSON.stringify(selection);
  annotateButton.hidden = false;
}

function hideAnnotateButton() {
  if (annotateButton) annotateButton.hidden = true;
}

function setAnnotateMode(active) {
  annotateMode = active;
  const entry = document.querySelector("[data-action='annotate-mode']");
  if (entry) entry.textContent = active ? "取消批注" : "添加批注";
  const body = document.querySelector("[data-annotatable]");
  if (active) {
    body?.classList.add("annotating");
    showToast("点一下要批注的句子或诗行");
  } else {
    body?.classList.remove("annotating");
    hideAnnotateButton();
  }
}

function openAnnotation(selection, body) {
  pendingAnnotation = {
    workId: body.dataset.workId,
    workVersionId: selection.versionId || body.dataset.versionId,
    quoteText: selection.quoteText,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
  };
  annotateQuoteText.textContent = `“${selection.quoteText}”`;
  annotateContent.value = "";
  annotateFormMessage.textContent = "";
  if (!annotateDialog.open) annotateDialog.showModal();
  annotateContent.focus();
}

function handleSelection(event) {
  if (annotateMode) return;
  showAnnotateButton(event);
}

async function renderWork(workId) {
  showLoading("正在展开作品");
  cleanupPreparedExport();
  state.currentWork = null;
  try {
    const [work, quotes] = await Promise.all([
      service.getWork(workId),
      service.listWorkQuotes(workId),
    ]);
    state.currentWork = work;
    const shell = element("div", { className: "reading-shell" });
    const head = element("header", { className: "reading-head" });
    const margin = element("aside", { className: "reading-margin" }, [
      element("span", { text: normalizeCategory(work.category) }),
      work.is_featured
        ? element("p", { className: "featured-mark", text: "编辑推荐" })
        : null,
    ]);
    const title = element("div", { className: "reading-title" }, [
      element("p", { className: "eyebrow", text: "WORK" }),
      element("h1", { text: work.title }),
      element("div", { className: "reading-meta" }, [
        element("a", {
          className: "meta-link",
          href: `#/authors/${encodeURIComponent(work.author_id)}`,
          text: work.author_pen_name,
        }),
        element("span", { text: formatDate(work.created_at) }),
        element("span", { text: `${countChineseText(work.content)} 字` }),
      ]),
      element("p", {
        className: "reading-deck",
        text: work.excerpt,
      }),
    ]);
    head.append(margin, title);

    const actionBar = element("div", { className: "work-actions" });
    const likeButton = element("button", {
      className: "like-button",
      type: "button",
      dataset: { action: "toggle-like", workId: work.id },
      attrs: {
        "aria-pressed": String(work.liked_by_current_user),
        "aria-label": work.liked_by_current_user ? "取消喜欢" : "喜欢这篇作品",
      },
    });
    likeButton.append(
      element("span", {
        text: work.liked_by_current_user ? "已喜欢" : "喜欢",
        dataset: { likeLabel: work.id },
      }),
      element("span", {
        text: String(work.like_count),
        dataset: { likeCount: work.id },
      }),
    );
    actionBar.append(likeButton);
    actionBar.append(
      element("a", {
        className: "secondary-button",
        href: `#/works/${encodeURIComponent(work.id)}/versions`,
        text: "查看历史版本",
      }),
    );
    // 移动端长按选区无法可靠唤出浮动批注按钮，提供显式「添加批注」入口进入选择模式。
    if (mobileHomeMedia.matches) {
      actionBar.append(
        element("button", {
          className: "secondary-button annotate-entry",
          type: "button",
          text: "添加批注",
          dataset: { action: "annotate-mode" },
        }),
      );
    }
    actionBar.append(
      element("button", {
        className: "secondary-button export-work-button",
        type: "button",
        text: "生成作品图片",
        dataset: { action: "export-work", workId: work.id },
      }),
    );

    if (userCanManage(work.author_id)) {
      const adminActions = element("div", { className: "admin-actions" });
      if (state.session.profile.role === "admin") {
        adminActions.append(
          element("button", {
            className: "quiet-button",
            type: "button",
            text: work.is_featured ? "取消推荐" : "设为推荐",
            dataset: {
              action: "toggle-featured",
              workId: work.id,
              featured: String(work.is_featured),
            },
            attrs: { "aria-pressed": String(work.is_featured) },
          }),
        );
      }
      adminActions.append(
        element("button", {
          className: "quiet-button",
          type: "button",
          text: "修改作品",
          dataset: { action: "edit-work", workId: work.id },
        }),
        element("button", {
          className: "quiet-button",
          type: "button",
          text: "删除作品",
          dataset: { action: "delete-work", workId: work.id },
        }),
      );
      actionBar.append(adminActions);
    }

    const quotesBlock = element("section", {
      className: "quotes-block",
      attrs: { "aria-labelledby": "quotes-title" },
    });
    quotesBlock.append(
      element("p", { className: "eyebrow", text: "ANNOTATIONS" }),
      element("h2", {
        id: "quotes-title",
        text: `批注 · ${quotes.length}`,
      }),
    );
    if (quotes.length) {
      const quoteList = element("ol", { className: "quote-list" });
      quotes.forEach((quote) => {
        const item = element("li", { className: "quote-item" }, [
          element("blockquote", { className: "quote-text", text: `“${quote.quote_text}”` }),
          element("p", {
            text: quote.is_deleted ? "该批注已删除" : quote.comment_content,
          }),
          element("div", { className: "discussion-meta" }, [
            element("span", { text: quote.user_pen_name }),
            element("time", {
              text: formatDate(quote.created_at),
              attrs: { datetime: quote.created_at },
            }),
          ]),
        ]);
        quoteList.append(item);
      });
      quotesBlock.append(quoteList);
    } else {
      quotesBlock.append(
        element("p", {
          className: "profile-meta",
          text: "还没有批注。选中正文中的一句话，写下你的发现。",
        }),
      );
    }

    const authorNote = element("section", { className: "author-note" }, [
      element("div", {}, [
        element("p", { className: "eyebrow", text: "AUTHOR" }),
        element("h2", { text: work.author_pen_name }),
      ]),
      element("div", {}, [
        element("p", {
          text: work.author_profile?.bio || "作者还没有留下简介。",
        }),
        element("a", {
          className: "inline-link",
          href: `#/authors/${encodeURIComponent(work.author_id)}`,
          text: "查看作者主页",
        }),
      ]),
    ]);

    const commentsBlock = element("section", {
      className: "comments-block",
      attrs: { "aria-labelledby": "comments-title" },
    });
    commentsBlock.append(
      element("p", { className: "eyebrow", text: "DISCUSSION" }),
      element("h2", {
        id: "comments-title",
        text: `讨论 · ${work.comments.length}`,
      }),
    );
    if (state.session) {
      const form = element("form", {
        className: "comment-form",
        dataset: { commentForm: work.id },
      });
      form.append(
        element("textarea", {
          name: "content",
          placeholder: "具体地说说你读到了什么",
          attrs: {
            required: true,
            maxlength: 2000,
            "aria-label": "评论内容",
          },
        }),
        element("button", {
          className: "primary-button",
          type: "submit",
          text: "发表评论",
        }),
      );
      commentsBlock.append(form);
    } else {
      commentsBlock.append(
        element("p", {}, [
          "登录后可以参与讨论。",
          element("button", {
            className: "text-button",
            type: "button",
            text: "现在登录",
            dataset: { action: "open-auth" },
          }),
        ]),
      );
    }
    const commentTree = element("ol", { className: "comment-thread" });
    const roots = buildCommentTree(work.comments);
    if (roots.length) {
      roots.forEach((comment) =>
        commentTree.append(createCommentItem(comment, work.id)),
      );
    } else {
      commentTree.append(
        element("li", {
          className: "empty-state",
          text: "还没有评论。第一位读者可以从一个具体的句子开始。",
        }),
      );
    }
    commentsBlock.append(commentTree);

    const related = state.works
      .filter(
        (item) =>
          item.id !== work.id &&
          (normalizeCategory(item.category) === normalizeCategory(work.category) ||
            item.author_id === work.author_id),
      )
      .slice(0, 3);
    const relatedBlock = element("section", { className: "related-block" }, [
      element("p", { className: "eyebrow", text: "KEEP READING" }),
      element("h2", { text: "继续阅读" }),
    ]);
    const relatedList = element("div", { className: "author-work-list" });
    related.forEach((item) => relatedList.append(createWorkRow(item)));
    relatedBlock.append(relatedList);

    shell.append(
      head,
      (() => {
        const body = renderAnnotatableBody(work.content, work.category);
        body.dataset.workId = work.id;
        body.dataset.versionId = work.current_version_id ?? "";
        body.dataset.annotatable = "";
        return body;
      })(),
      actionBar,
      element("div", {
        className: "export-results-host",
        attrs: { "aria-live": "polite" },
      }),
      quotesBlock,
      authorNote,
      commentsBlock,
      relatedBlock,
    );
    replaceContent(app, shell);
  } catch (error) {
    showError("作品无法打开", error.message, true);
  }
}

async function renderWorkVersions(workId) {
  showLoading("正在打开历史版本");
  try {
    const [work, versions] = await Promise.all([
      service.getWork(workId),
      service.listWorkVersions(workId),
    ]);
    const shell = element("div", { className: "page-shell versions-shell" });
    shell.append(
      createPageHeader(
        "VERSIONS",
        "历史版本",
        "每次修改都会留下一个公开版本。恢复旧版本会生成新的最新版本，不会删除任何历史。",
      ),
      element("p", { className: "profile-meta" }, [
        element("span", { text: work.title }),
        element("span", { text: ` · 共 ${versions.length} 个版本` }),
        element("a", {
          className: "inline-link",
          href: `#/works/${encodeURIComponent(work.id)}`,
          text: "返回正文",
        }),
      ]),
    );
    const list = element("ol", { className: "version-list" });
    versions.forEach((version) => {
      const item = element("li", { className: "version-card" });
      const isCurrent = work.current_version_number === version.version_number;
      item.append(
        element("div", { className: "version-card-head" }, [
          element("span", {
            className: "version-badge",
            text: `第 ${version.version_number} 版`,
          }),
          isCurrent
            ? element("span", { className: "featured-mark", text: "当前版本" })
            : null,
          element("time", {
            text: formatDate(version.created_at),
            attrs: { datetime: version.created_at },
          }),
        ]),
        element("p", {
          className: "version-summary",
          text: version.change_summary,
        }),
        version.restored_from_version_id
          ? element("p", {
              className: "profile-meta",
              text: `由第 ${versions.find((v) => v.id === version.restored_from_version_id)?.version_number ?? "?"} 版恢复而来`,
            })
          : null,
        element("details", { className: "version-body" }, [
          element("summary", { text: "查看正文快照" }),
          renderParagraphs(version.content, version.category),
        ]),
      );
      if (userCanManage(work.author_id) && !isCurrent) {
        item.append(
          element("button", {
            className: "quiet-button",
            type: "button",
            text: "恢复此版本",
            dataset: {
              action: "restore-version",
              workId: work.id,
              sourceVersionId: version.id,
              versionNumber: String(version.version_number),
            },
          }),
        );
      }
      list.append(item);
    });
    shell.append(list);
    replaceContent(app, shell);
  } catch (error) {
    showError("历史版本无法打开", error.message, true);
  }
}

function renderAuthGate() {
  const shell = element("div", { className: "page-shell auth-gate" }, [
    element("p", { className: "eyebrow", text: "WRITING DESK" }),
    element("h2", { text: "登录后开始写作" }),
    element("p", {
      text: "写作台会在本地保存未发布的草稿。学号只用于登录，不会出现在作品或作者主页。",
    }),
    element("button", {
      className: "primary-button",
      type: "button",
      text: "登录或注册",
      dataset: { action: "open-auth", returnHash: "#/write" },
    }),
  ]);
  replaceContent(app, shell);
}

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  } catch {
    return {};
  }
}

async function renderWrite(options = {}) {
  if (!state.session) {
    renderAuthGate();
    return;
  }
  if (!requireVerifiedWrite("#/write")) return;
  state.editingWork = null;
  let draft = readDraft();
  let editing = null;
  if (options.workId) {
    try {
      editing = await service.getWork(options.workId);
      const versions = await service.listWorkVersions(options.workId);
      state.editingWork = {
        work: editing,
        latestVersionNumber: versions[0]?.version_number ?? 1,
      };
      draft = {
        title: editing.title,
        excerpt: editing.excerpt,
        category: editing.category,
        content: editing.content,
      };
    } catch (error) {
      showError("作品无法编辑", error.message, true);
      return;
    }
  }
  const shell = element("div", { className: "page-shell writing-shell" });
  const aside = element("aside", { className: "writing-aside" }, [
    element("div", {}, [
      element("p", { className: "eyebrow", text: "WRITING DESK" }),
      element("p", {
        text: "先把句子写准确，再考虑它会获得多少喜欢。",
      }),
    ]),
    element("p", {
      className: "draft-status",
      text: editing
        ? "正在修改既有作品"
        : Object.keys(draft).length
          ? "已恢复浏览器中的本地草稿"
          : "草稿会自动保存在本机",
      dataset: { draftStatus: "true" },
    }),
  ]);
  const form = element("form", {
    className: "writing-form",
    id: "writingForm",
  });
  form.append(
    element("div", {}, [
      element("h1", {
        text: editing ? "修改作品" : "写一篇新作",
      }),
      editing
        ? element("p", {
            className: "profile-meta",
            text: `当前为第 ${state.editingWork.latestVersionNumber} 版 · 以笔名“${state.session.profile.pen_name}”保存`,
          })
        : element("p", {
            className: "profile-meta",
            text: `以笔名“${state.session.profile.pen_name}”发表`,
          }),
    ]),
  );
  const titleLabel = element("label", {}, [
    element("span", { text: "标题" }),
    element("input", {
      name: "title",
      value: draft.title ?? "",
      placeholder: "给作品一个准确的名字",
      attrs: { required: true, maxlength: 80, autocomplete: "off" },
    }),
  ]);
  const row = element("div", { className: "form-row" });
  const categoryLabel = element("label", {}, [
    element("span", { text: "分类" }),
  ]);
  const select = element("select", {
    name: "category",
    attrs: { required: true },
  });
  PUBLISHABLE_CATEGORIES.forEach((category) => {
    select.append(
      element("option", {
        value: category,
        text: category,
        attrs: { selected: (draft.category ?? "新诗") === category },
      }),
    );
  });
  categoryLabel.append(select);
  const excerptLabel = element("label", {}, [
    element("span", { text: "摘要（可选）" }),
    element("input", {
      name: "excerpt",
      value: draft.excerpt ?? "",
      placeholder: "留空则从正文自动生成",
      attrs: { maxlength: 180 },
    }),
  ]);
  row.append(categoryLabel, excerptLabel);
  const contentLabel = element("label", {}, [
    element("span", { text: "正文" }),
    element("textarea", {
      name: "content",
      value: draft.content ?? "",
      placeholder: "从这里开始。段落之间空一行，阅读时会保留。",
      attrs: { required: true, maxlength: 50000 },
    }),
  ]);
  contentLabel.querySelector("textarea").textContent = draft.content ?? "";
  if (editing) {
    form.append(
      element("label", {}, [
        element("span", { text: "修改说明（必填，1–200 字）" }),
        element("input", {
          name: "changeSummary",
          placeholder: "这版改了什么？例如：补充第三段",
          attrs: { required: true, maxlength: 200, autocomplete: "off" },
        }),
      ]),
    );
  }
  const footer = element("div", { className: "form-footer" }, [
    element("span", {
      className: "word-count",
      text: `${countChineseText(draft.content ?? "")} 字`,
      dataset: { wordCount: "true" },
    }),
    element("button", {
      className: "primary-button",
      type: "submit",
      text: editing ? "保存新版本" : "发布作品",
    }),
  ]);
  form.append(titleLabel, row, contentLabel, footer);
  shell.append(aside, form);
  replaceContent(app, shell);
}

function renderResendControl(nextSendAt) {
  const wrap = element("p", { className: "resend-row" });
  const button = element("button", {
    className: "text-button resend-button",
    type: "button",
    text: "重新发送验证码",
    dataset: { action: "request-recovery-code" },
  });
  const countdown = element("span", { className: "resend-countdown" });
  wrap.append(button, countdown);
  const update = () => {
    const remaining = new Date(nextSendAt || 0).getTime() - Date.now();
    if (remaining > 0) {
      const seconds = Math.max(1, Math.ceil(remaining / 1000));
      countdown.textContent = `${seconds} 秒后可重新发送`;
      button.disabled = true;
      window.setTimeout(update, 500);
    } else {
      countdown.textContent = "";
      button.disabled = false;
    }
  };
  update();
  return wrap;
}

function renderBindingForm(status) {
  const pending = status.state === "pending";
  const resend = element("div", { attrs: { "data-resend-control": "" } });
  if (pending) replaceContent(resend, renderResendControl(status.nextSendAt));
  const form = element("form", {
    className: "stack-form account-security-form",
    id: "bindRecoveryForm",
  });
  form.append(
    element("label", {}, [
      element("span", { text: "找回邮箱" }),
      element("input", {
        name: "recoveryEmail",
        type: "email",
        value: pending ? state.accountSecurityPendingEmail ?? "" : "",
        attrs: { required: true, autocomplete: "email" },
      }),
    ]),
    element("label", {}, [
      element("span", { text: "六位验证码" }),
      element("input", {
        name: "code",
        type: "text",
        inputmode: "numeric",
        maxlength: 6,
        attrs: { required: true, autocomplete: "one-time-code" },
      }),
    ]),
    element("div", { attrs: { "data-turnstile": "" } }),
    element("p", {
      className: "form-message",
      role: "status",
      dataset: { formMessage: "bind" },
    }),
    resend,
    element("button", {
      className: "secondary-button",
      type: "button",
      text: "发送验证码",
      dataset: { action: "request-recovery-code" },
    }),
    element("button", {
      className: "primary-button",
      type: "submit",
      text: "验证并进入",
      dataset: { action: "verify-recovery-code" },
    }),
  );
  renderTurnstile(form);
  return element("section", { className: "account-security-panel" }, [
    element("p", {
      className: "account-security-meta",
      text: pending
        ? `验证码已发送到 ${status.maskedEmail}，验证通过后即可继续操作。`
        : "绑定找回邮箱后，忘记密码时可以通过验证码重置。邮箱只用于验证，不会公开。",
    }),
    form,
  ]);
}

function renderVerifiedSecurity(status) {
  const panel = element("section", { className: "account-security-panel" }, [
    element("p", {
      className: "account-security-meta",
      text: "已绑定找回邮箱，完整邮箱不会显示或公开。",
    }),
    element("p", {
      className: "account-security-masked",
      text: status.maskedEmail,
      dataset: { maskedEmail: "true" },
    }),
  ]);
  const form = element("form", {
    className: "stack-form account-security-form",
    id: "changeEmailForm",
  });
  form.append(
    element("label", {}, [
      element("span", { text: "新找回邮箱" }),
      element("input", {
        name: "newEmail",
        type: "email",
        attrs: { required: true, autocomplete: "email" },
      }),
    ]),
    element("div", { attrs: { "data-turnstile": "" } }),
    element("p", {
      className: "form-message",
      role: "status",
      dataset: { formMessage: "change" },
    }),
    element("button", {
      className: "secondary-button",
      type: "submit",
      text: "发送验证码并更换",
      dataset: { action: "request-email-change" },
    }),
  );
  renderTurnstile(form);
  panel.append(form);
  if (state.accountSecurityReturnHash) {
    panel.append(
      element("button", {
        className: "primary-button",
        type: "button",
        text: "返回继续",
        dataset: { action: "account-security-return" },
      }),
    );
  }
  return panel;
}

function renderChangingSecurity(status) {
  const isOldStep = state.accountSecurityChangeStep !== 1;
  const form = element("form", {
    className: "stack-form account-security-form",
    id: "changeConfirmForm",
  });
  form.append(
    element("p", {
      className: "account-security-meta",
      text: isOldStep
        ? `请先确认当前邮箱 ${status.maskedEmail} 收到的验证码`
        : "请确认新邮箱收到的验证码",
    }),
    element("label", {}, [
      element("span", { text: "六位验证码" }),
      element("input", {
        name: "code",
        type: "text",
        inputmode: "numeric",
        maxlength: 6,
        attrs: { required: true, autocomplete: "one-time-code" },
      }),
    ]),
    element("p", {
      className: "form-message",
      role: "status",
      dataset: { formMessage: "confirm" },
    }),
    element("button", {
      className: "primary-button",
      type: "submit",
      text: isOldStep ? "确认原邮箱" : "确认新邮箱",
      dataset: { action: isOldStep ? "confirm-old-email" : "confirm-new-email" },
    }),
  );
  return element("section", { className: "account-security-panel" }, [form]);
}

async function renderAccountSecurity() {
  showLoading("正在整理账号安全");
  try {
    if (!state.session) {
      const shell = element("div", { className: "page-shell auth-gate" }, [
        element("p", { className: "eyebrow", text: "ACCOUNT SECURITY" }),
        element("h2", { text: "登录后管理账号安全" }),
        element("p", {
          text: "绑定找回邮箱后，忘记密码时可以通过验证码重置。",
        }),
        element("button", {
          className: "primary-button",
          type: "button",
          text: "登录",
          dataset: { action: "open-auth", returnHash: "#/account/security" },
        }),
      ]);
      replaceContent(app, shell);
      return;
    }
    const status = await service.getAccountSecurityStatus();
    const shell = element("div", { className: "page-shell account-security" });
    const head = element("div", { className: "account-security-head" }, [
      element("p", { className: "eyebrow", text: "ACCOUNT SECURITY" }),
      element("h2", { text: "账号安全" }),
      element("p", {
        className: "account-security-meta",
        text: `已登录：${state.session.profile.pen_name}`,
      }),
    ]);
    let body;
    if (status.state === "unbound" || status.state === "pending") {
      body = renderBindingForm(status);
    } else if (status.state === "changing") {
      body = renderChangingSecurity(status);
    } else {
      body = renderVerifiedSecurity(status);
    }
    shell.append(head, body);
    replaceContent(app, shell);
  } catch (error) {
    showError("账号安全无法打开", error.message, true);
  }
}

const accountSecurityActions = {
  "request-recovery-code": async (form) => {
    const data = new FormData(form);
    const email = String(
      data.get("recoveryEmail") ?? state.accountSecurityPendingEmail ?? "",
    ).trim();
    try {
      const result = await service.requestRecoveryEmail(
        email,
        readTurnstileToken(form),
      );
      state.accountSecurityPendingEmail = email;
      showToast(result.message, "success");
      await refreshSessionSecurity();
      const security = state.session?.accountSecurity;
      const message = form.querySelector("[data-form-message]");
      if (message) {
        message.textContent = security?.maskedEmail
          ? `验证码已发送到 ${security.maskedEmail}`
          : result.message;
      }
      const resendControl = form.querySelector("[data-resend-control]");
      if (resendControl) {
        replaceContent(resendControl, renderResendControl(security?.nextSendAt));
      }
      form.querySelector('[name="code"]')?.focus();
    } catch (error) {
      const message = form.querySelector("[data-form-message]");
      if (message) message.textContent = error.message;
    }
  },
  "verify-recovery-code": async (form) => {
    const code = String(new FormData(form).get("code") ?? "").trim();
    try {
      await service.verifyRecoveryEmail(code);
      state.accountSecurityChangeStep = 0;
      showToast("找回邮箱已验证。", "success");
      await refreshSessionSecurity();
      await renderAccountSecurity();
    } catch (error) {
      const message = form.querySelector("[data-form-message]");
      if (message) message.textContent = error.message;
    }
  },
  "request-email-change": async (form) => {
    const newEmail = String(new FormData(form).get("newEmail") ?? "").trim();
    try {
      const result = await service.requestRecoveryEmailChange(
        newEmail,
        readTurnstileToken(form),
      );
      state.accountSecurityChangeStep = 0;
      showToast(result.message, "success");
      await refreshSessionSecurity();
      await renderAccountSecurity();
    } catch (error) {
      const message = form.querySelector("[data-form-message]");
      if (message) message.textContent = error.message;
    }
  },
  "confirm-old-email": async (form) => {
    const code = String(new FormData(form).get("code") ?? "").trim();
    try {
      const result = await service.confirmRecoveryEmailChangeOld(code);
      state.accountSecurityChangeStep = 1;
      showToast(result.message, "success");
      await refreshSessionSecurity();
      await renderAccountSecurity();
    } catch (error) {
      const message = form.querySelector("[data-form-message]");
      if (message) message.textContent = error.message;
    }
  },
  "confirm-new-email": async (form) => {
    const code = String(new FormData(form).get("code") ?? "").trim();
    try {
      await service.confirmRecoveryEmailChangeNew(code);
      state.accountSecurityChangeStep = 0;
      showToast("找回邮箱已更新。", "success");
      await refreshSessionSecurity();
      await renderAccountSecurity();
    } catch (error) {
      const message = form.querySelector("[data-form-message]");
      if (message) message.textContent = error.message;
    }
  },
};

async function renderAuthor(profileId) {
  showLoading("正在整理作者作品");
  try {
    const profile = await service.getProfile(profileId);
    if (state.session?.profile.id === profile.id) {
      Object.assign(state.session.profile, {
        pen_name: profile.pen_name,
        pen_name_changed_at: profile.pen_name_changed_at,
        bio: profile.bio,
        updated_at: profile.updated_at,
      });
      updateHeader();
    }
    const shell = element("div", { className: "page-shell" });
    const header = element("header", { className: "profile-header" });
    const identity = element("div", {}, [
      element("p", {
        className: "eyebrow",
        text: profile.role === "admin" ? "EDITOR / AUTHOR" : "AUTHOR",
      }),
      element("h1", { text: profile.pen_name }),
      element("div", { className: "profile-meta" }, [
        element("span", { text: `加入于 ${formatDate(profile.created_at)}` }),
        profile.role === "admin"
          ? element("span", { text: "编辑管理员" })
          : null,
      ]),
      element("p", {
        className: "profile-bio",
        text: profile.bio || "作者还没有留下简介。",
      }),
    ]);
    if (state.session?.profile.id === profile.id) {
      identity.append(
        element("div", { className: "profile-actions" }, [
          element("button", {
            className: "quiet-button",
            type: "button",
            text: "编辑资料",
            dataset: { action: "open-profile-editor" },
          }),
        ]),
      );
    }
    const stats = element("dl", { className: "profile-stats" });
    [
      ["作品", profile.work_count],
      ["获赞", profile.total_likes],
      ["评论", profile.comment_count],
    ].forEach(([label, value]) => {
      stats.append(
        element("div", {}, [
          element("dt", { text: label }),
          element("dd", { text: value }),
        ]),
      );
    });
    header.append(identity, stats);

    const content = element("section", { className: "profile-content" });
    const works = element("div", {}, [
      element("div", { className: "section-heading" }, [
        element("div", {}, [
          element("p", { className: "eyebrow", text: "WRITING" }),
          element("h2", { text: "公开作品" }),
        ]),
        element("p", { text: `${profile.works.length} 篇` }),
      ]),
    ]);
    const workList = element("div", { className: "author-work-list" });
    if (profile.works.length) {
      profile.works.forEach((work) => workList.append(createWorkRow(work)));
    } else {
      workList.append(
        element("div", {
          className: "empty-state",
          text: "这位作者还没有发表公开作品。",
        }),
      );
    }
    works.append(workList);
    content.append(works);

    if (state.session?.profile.id !== profile.id) {
      content.append(
        element("aside", { className: "submission-note" }, [
          element("p", { className: "eyebrow", text: "ABOUT AUTHORS" }),
          element("h3", { text: "只让作品介绍作者" }),
          element("p", {
            text: "作者主页仅展示笔名、简介和公开创作数据，不公开任何登录凭据。",
          }),
        ]),
      );
    }
    shell.append(header, content);
    replaceContent(app, shell);
  } catch (error) {
    showError("作者主页无法打开", error.message, true);
  }
}

async function loadDiscussionsPage({ reset = true } = {}) {
  const requestId = ++state.discussionRequestId;
  if (reset) {
    state.browseDiscussions.items = [];
    state.browseDiscussions.nextCursor = null;
  }
  state.browseDiscussions.loading = true;
  try {
    const result = await service.listDiscussionsPage({
      cursor: reset ? null : state.browseDiscussions.nextCursor,
      pageSize: 20,
    });
    if (requestId !== state.discussionRequestId) return;
    state.browseDiscussions.items = reset
      ? result.discussions
      : [...state.browseDiscussions.items, ...result.discussions];
    state.browseDiscussions.nextCursor = result.nextCursor;
    state.browseDiscussions.loading = false;
  } catch (error) {
    if (requestId !== state.discussionRequestId) return;
    state.browseDiscussions.loading = false;
    showError("讨论暂时无法加载", error.message, true);
    return;
  }
  if (parseRoute(window.location.hash).name === "discussions") renderDiscussions();
}

function renderDiscussions() {
  const shell = element("div", { className: "page-shell" });
  shell.append(
    createPageHeader(
      "DISCUSSIONS",
      "正在讨论",
      "一条好评论不是判词，而是把自己读到的细节交还给作者和下一位读者。",
    ),
  );
  const list = element("ol", { className: "discussion-page-list" });
  const discussions = state.browseDiscussions.items;
  discussions.forEach((discussion) => {
    const row = element("li", { className: "discussion-row" });
    row.append(
      element("time", {
        text: formatDate(discussion.created_at),
        attrs: { datetime: discussion.created_at },
      }),
      element("div", {}, [
        element("div", { className: "discussion-meta" }, [
          element("a", {
            className: "meta-link",
            href: `#/authors/${encodeURIComponent(discussion.user_id)}`,
            text: discussion.user_pen_name,
          }),
          element("span", { text: "评论了" }),
          element("a", {
            className: "meta-link",
            href: `#/works/${encodeURIComponent(discussion.work_id)}`,
            text: discussion.work_title,
          }),
        ]),
        element("blockquote", {
          text: discussion.is_deleted
            ? "该评论已由作者删除"
            : discussion.content,
        }),
        element("a", {
          className: "inline-link",
          href: `#/works/${encodeURIComponent(discussion.work_id)}`,
          text: "进入讨论",
        }),
      ]),
    );
    list.append(row);
  });
  if (!discussions.length) {
    list.append(
      element("li", {
        className: "empty-state",
        text: "社区里还没有讨论。",
      }),
    );
  }
  shell.append(list);
  if (state.browseDiscussions.nextCursor) {
    shell.append(
      element("div", { className: "load-more-row" }, [
        element("button", {
          className: "primary-button",
          type: "button",
          text: "更多讨论",
          dataset: { action: "load-more-discussions" },
        }),
      ]),
    );
  }
  replaceContent(app, shell);
}

function renderSubmissions() {
  const shell = element("div", { className: "page-shell" });
  const submission = state.settings?.submission ?? {
    title: "长期征稿",
    body: "新诗、旧诗、散文、小说、随笔与其他文字均可投稿。",
  };
  shell.append(
    createPageHeader(
      "OPEN CALL",
      submission.title,
      submission.body,
    ),
  );
  const grid = element("div", { className: "rules-grid" });
  const scope = element("section", {}, [
    element("p", { className: "eyebrow", text: "WHAT TO SHARE" }),
    element("h2", { text: "可以发表什么" }),
    element("p", {
      text: "平台长期接收原创的新诗、旧诗、散文、小说、随笔与其他文字。作品发布后会立即进入新作流，不必等待集中刊发。",
    }),
    element("ul", {}, [
      element("li", { text: "作品应为本人原创。" }),
      element("li", { text: "引用他人文字时清楚标明来源。" }),
      element("li", { text: "标题、摘要和分类应准确反映正文。" }),
      element("li", { text: "作者可以删除自己的作品。" }),
    ]),
  ]);
  const rules = element("section", {}, [
    element("p", { className: "eyebrow", text: "HOW TO RESPOND" }),
    element("h2", { text: "如何参与讨论" }),
  ]);
  const ruleList = element("ol");
  (
    state.settings?.community_rules ?? [
      "讨论作品，不攻击作者。",
      "引用他人文字时注明来源。",
      "管理员仅在违反社区规则时隐藏内容。",
    ]
  ).forEach((rule) => ruleList.append(element("li", { text: rule })));
  rules.append(
    ruleList,
    element("p", {
      text: "评论与回复会持续保留讨论脉络。删除父评论时，其回复不会被一并抹去。",
    }),
  );
  const privacy = element("section", {}, [
    element("p", { className: "eyebrow", text: "PRIVACY" }),
    element("h2", { text: "公开信息边界" }),
    element("p", {
      text: "公开页面只展示笔名、简介、作品和互动数据。学号仅用于登录，不出现在作者主页、作品详情、评论或搜索结果中。",
    }),
  ]);
  const moderation = element("section", {}, [
    element("p", { className: "eyebrow", text: "MODERATION" }),
    element("h2", { text: "管理员职责" }),
    element("p", {
      text: "管理员可以处理违反规则的作品或评论，并维护编辑推荐。所有真实权限同时由数据库 RLS 控制，不依赖界面按钮是否可见。",
    }),
    element("a", {
      className: "write-link",
      href: "#/write",
      text: "开始写作",
    }),
  ]);
  grid.append(scope, rules, privacy, moderation);
  shell.append(grid);
  replaceContent(app, shell);
}

function renderNotFound() {
  replaceContent(
    app,
    element("section", { className: "page-shell empty-state" }, [
      element("p", { className: "eyebrow", text: "404" }),
      element("h2", { text: "这一页没有文字" }),
      element("p", { text: "链接可能已经改变，或者作品已经被作者删除。" }),
      element("a", {
        className: "write-link",
        href: "#/",
        text: "返回新作",
      }),
    ]),
  );
}

function readHomeScroll() {
  try {
    return Number(sessionStorage.getItem(HOME_SCROLL_KEY) || 0);
  } catch {
    return 0;
  }
}

function writeHomeScroll(value) {
  try {
    sessionStorage.setItem(HOME_SCROLL_KEY, String(value));
  } catch {
    // sessionStorage 不可用时静默跳过
  }
}

async function renderCurrentRoute() {
  // 选区批注浮动按钮挂在 document.body 下，路由重绘不会移除它；
  // 选中内容随正文被替换而坍缩时 Chrome 并不触发 selectionchange，必须在这里显式隐藏。
  hideAnnotateButton();
  setAnnotateMode(false);
  if (annotateDialog.open) annotateDialog.close();
  accountMenu.hidden = true;
  closeProfileEditor();
  siteHeader.dataset.menuOpen = "false";
  document
    .querySelector(".menu-toggle")
    .setAttribute("aria-expanded", "false");
  updateHeader();
  const route = parseRoute(window.location.hash);
  if (previousRouteName === "home") writeHomeScroll(window.scrollY || 0);
  previousRouteName = route.name;
  cleanupPreparedExport();
  if (route.name !== "work") state.currentWork = null;
  try {
    if (route.name === "home") renderHome();
    else if (route.name === "work") await renderWork(route.id);
    else if (route.name === "versions") await renderWorkVersions(route.id);
    else if (route.name === "editWork") await renderWrite({ workId: route.id });
    else if (route.name === "author") await renderAuthor(route.id);
    else if (route.name === "write") renderWrite();
    else if (route.name === "account-security") await renderAccountSecurity();
    else if (route.name === "discussions") await loadDiscussionsPage({ reset: true });
    else if (route.name === "submissions") renderSubmissions();
    else renderNotFound();
  } finally {
    if (route.name === "home") {
      window.scrollTo({ top: readHomeScroll(), behavior: "instant" });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    app.focus({ preventScroll: true });
  }
}

function readHomeSession() {
  try {
    const raw = sessionStorage.getItem(HOME_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.filters || !Array.isArray(parsed.works)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveHomeSession() {
  try {
    sessionStorage.setItem(
      HOME_SESSION_KEY,
      JSON.stringify({
        filters: state.filters,
        works: state.browse.works,
        nextCursor: state.browse.nextCursor,
      }),
    );
  } catch {
    // sessionStorage 不可用时静默跳过
  }
}

async function loadBrowseWorks({ reset = true } = {}) {
  const requestId = ++state.browse.requestId;
  const previousWorks = state.browse.works;
  const previousCursor = state.browse.nextCursor;
  if (reset) {
    state.browse.works = [];
    state.browse.nextCursor = null;
    state.browse.error = null;
  }
  state.browse.loading = true;
  try {
    const result = await service.listWorksPage({
      query: state.filters.query,
      category: state.filters.category,
      sort: state.filters.sort,
      cursor: reset ? null : state.browse.nextCursor,
      pageSize: 10,
    });
    if (requestId !== state.browse.requestId) return;
    // 分页 RPC 每页返回 content（移动端诗句卡片依赖），不再从全量列表补齐
    state.browse.works = reset
      ? result.works
      : [...state.browse.works, ...result.works];
    state.browse.nextCursor = result.nextCursor;
    state.browse.error = null;
    state.browse.loading = false;
    saveHomeSession();
  } catch (error) {
    if (requestId !== state.browse.requestId) return;
    // 重置请求失败时恢复已加载批次，避免页面误显示为 0 篇
    if (reset) {
      state.browse.works = previousWorks;
      state.browse.nextCursor = previousCursor;
    }
    state.browse.error = error.message;
    state.browse.loading = false;
  }
  if (parseRoute(window.location.hash).name === "home") renderHome();
}

async function loadMoreWorks() {
  if (!state.browse.nextCursor || state.browse.loading) return;
  await loadBrowseWorks({ reset: false });
}

function setFilters(patch) {
  Object.assign(state.filters, patch);
  loadBrowseWorks({ reset: true });
}

async function refreshWorks() {
  state.works = await service.listWorks();
  state.mobileFeed.signature = "";
  await loadBrowseWorks({ reset: true });
}

async function initialize() {
  showLoading();
  document.addEventListener("mouseup", handleSelection);
  document.addEventListener("touchend", handleSelection);
  document.addEventListener("selectionchange", () => {
    if (!window.getSelection()?.isCollapsed) return;
    hideAnnotateButton();
  });
  annotateDialog.addEventListener("close", () => {
    pendingAnnotation = null;
  });
  try {
    const saved = readHomeSession();
    if (saved) {
      Object.assign(state.filters, saved.filters);
      state.browse.works = saved.works;
      state.browse.nextCursor = saved.nextCursor;
    }
    [state.session, state.settings, state.works] = await Promise.all([
      service.getSession(),
      service.getSiteSettings(),
      service.listWorks(),
    ]);
    if (!saved) await loadBrowseWorks({ reset: true });
    await loadDiscussionsPage({ reset: true });
    updateHeader();
    await renderCurrentRoute();
  } catch (error) {
    showError(
      "社区暂时无法加载",
      `${error.message}。请检查网络或 Supabase 配置后重试。`,
      true,
    );
  }
}

async function handleAuthSubmit(form, mode) {
  const message = document.querySelector(`[data-form-message="${mode}"]`);
  const data = new FormData(form);
  const studentNumber = String(data.get("studentNumber") ?? "").trim();
  const password = String(data.get("password") ?? "");
  if (!validateStudentNumber(studentNumber)) {
    message.textContent = "请输入 20 开头的十位学号。";
    return;
  }
  if (!validatePassword(password)) {
    message.textContent = "密码至少八位，并同时包含字母和数字。";
    return;
  }
  message.textContent = mode === "login" ? "正在登录…" : "正在创建账户…";
  try {
    state.session =
      mode === "login"
        ? await service.signIn({ studentNumber, password })
        : await service.signUp({
            studentNumber,
            password,
            penName: String(data.get("penName") ?? "").trim(),
            recoveryEmail: String(data.get("recoveryEmail") ?? "").trim(),
            captchaToken: readTurnstileToken(form),
          });
    if (mode === "register" && state.session.accountSecurity?.state === "pending") {
      state.accountSecurityPendingEmail = String(
        data.get("recoveryEmail") ?? "",
      ).trim();
    }
    form.reset();
    closeAuth();
    updateHeader();
    await refreshWorks();
    const welcomeMessage =
      mode === "login"
        ? "已登录，欢迎回来。"
        : state.session.accountSecurity?.state === "pending"
          ? "账户已创建，请先验证找回邮箱。"
          : "账户已创建，可以开始写作。";
    showToast(welcomeMessage, "success");
    const returnHash = resolveAuthReturnHash(state.authReturnHash);
    state.authReturnHash = null;
    if (mode === "register" && state.session.accountSecurity?.state === "pending") {
      const target = "#/account/security";
      if (window.location.hash !== target) {
        window.location.hash = target;
      } else {
        await renderCurrentRoute();
      }
    } else if (returnHash && window.location.hash !== returnHash) {
      window.location.hash = returnHash;
    } else {
      await renderCurrentRoute();
    }
  } catch (error) {
    message.textContent = error.message;
  }
}

async function handleLike(button) {
  if (!requireVerifiedWrite(window.location.hash)) return;
  const workId = button.dataset.workId;
  const countNode = button.querySelector(`[data-like-count="${CSS.escape(workId)}"]`);
  const labelNode = button.querySelector(`[data-like-label="${CSS.escape(workId)}"]`);
  const originalPressed = button.getAttribute("aria-pressed") === "true";
  const originalCount = Number(countNode.textContent);
  const optimisticPressed = !originalPressed;
  button.setAttribute("aria-pressed", String(optimisticPressed));
  labelNode.textContent = optimisticPressed ? "已喜欢" : "喜欢";
  countNode.textContent = String(
    Math.max(0, originalCount + (optimisticPressed ? 1 : -1)),
  );
  button.disabled = true;
  try {
    const result = await service.toggleLike(workId);
    button.setAttribute("aria-pressed", String(result.liked));
    labelNode.textContent = result.liked ? "已喜欢" : "喜欢";
    countNode.textContent = String(result.likeCount);
    await refreshWorks();
  } catch (error) {
    button.setAttribute("aria-pressed", String(originalPressed));
    labelNode.textContent = originalPressed ? "已喜欢" : "喜欢";
    countNode.textContent = String(originalCount);
    showToast(`喜欢状态没有保存：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", async (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === "toggle-menu") {
    const open = siteHeader.dataset.menuOpen !== "true";
    siteHeader.dataset.menuOpen = String(open);
    trigger.setAttribute("aria-expanded", String(open));
  } else if (action === "open-auth") {
    event.preventDefault();
    openAuth("login", trigger.dataset.returnHash || null);
  } else if (action === "close-auth") {
    closeAuth();
  } else if (action === "open-password-recovery") {
    event.preventDefault();
    closeAuth();
    openPasswordRecovery();
  } else if (action === "close-recovery") {
    closePasswordRecovery();
  } else if (action === "back-recovery-request") {
    event.preventDefault();
    const requestForm = document.querySelector("#recoveryRequestForm");
    const completeForm = document.querySelector("#recoveryCompleteForm");
    completeForm.hidden = true;
    completeForm.reset();
    requestForm.hidden = false;
    requestForm.querySelector('[name="studentNumber"]').focus();
  } else if (action === "account-security-return") {
    const target = state.accountSecurityReturnHash || "#/";
    state.accountSecurityReturnHash = null;
    window.location.hash = target;
  } else if (action in accountSecurityActions) {
    event.preventDefault();
    const form = trigger.closest("form");
    await accountSecurityActions[action](form);
  } else if (action === "open-profile-editor") {
    openProfileEditor();
  } else if (action === "close-profile-editor") {
    closeProfileEditor();
  } else if (action === "auth-tab") {
    switchAuthTab(trigger.dataset.tab);
  } else if (action === "toggle-account-menu") {
    accountMenu.hidden = !accountMenu.hidden;
  } else if (action === "logout") {
    await service.signOut();
    state.session = null;
    updateHeader();
    showToast("已退出登录。", "success");
    await renderCurrentRoute();
  } else if (action === "reset-filters") {
    setFilters({ query: "", category: "全部", sort: "latest" });
  } else if (action === "load-more") {
    loadMoreWorks();
  } else if (action === "load-more-discussions") {
    if (state.browseDiscussions.loading) return;
    loadDiscussionsPage({ reset: false });
  } else if (action === "retry-browse") {
    loadBrowseWorks({ reset: true });
  } else if (action === "retry-browse-more") {
    loadMoreWorks();
  } else if (action === "mobile-category") {
    setFilters({ category: trigger.dataset.category });
  } else if (action === "mobile-feed-previous") {
    moveMobileFeed("previous");
  } else if (action === "mobile-feed-next") {
    moveMobileFeed("next");
  } else if (action === "retry-route") {
    await initialize();
  } else if (action === "toggle-like") {
    await handleLike(trigger);
  } else if (action === "export-work") {
    const work = state.currentWork;
    if (!work || String(work.id) !== trigger.dataset.workId) {
      showToast("作品内容已经变化，请刷新后重试。");
      return;
    }

    const originalText = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = "正在生成…";
    const resultsContainer = document.querySelector(".export-results-host");
    cleanupPreparedExport();
    resultsContainer?.replaceChildren();

    try {
      const result = await exportWorkImages(work);
      const route = parseRoute(window.location.hash);
      if (
        state.currentWork !== work ||
        route.name !== "work" ||
        String(route.id) !== String(work.id)
      ) {
        return;
      }
      const prepared = {
        work,
        workId: String(work.id),
        blobs: result.blobs,
        files: result.files,
        previewUrls: [],
      };
      state.currentExport = prepared;
      try {
        prepared.files.forEach((file) => {
          prepared.previewUrls.push(URL.createObjectURL(file));
        });
        renderExportActions(prepared, resultsContainer);
      } catch (error) {
        cleanupPreparedExport();
        throw error;
      }
      showToast(
        `已生成 ${result.blobs.length} 页，请点击分享或保存。`,
        "success",
      );
    } catch (error) {
      showToast(`作品图片没有生成：${error.message}`);
    } finally {
      trigger.disabled = false;
      trigger.textContent = originalText;
    }
  } else if (action === "share-export") {
    const prepared = getPreparedExport(trigger);
    if (!prepared) return;
    const originalText = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = "正在分享…";
    try {
      const shareOperation = shareExportFiles(prepared.files, prepared.work);
      Promise.resolve(shareOperation)
        .then(() => showToast("作品图片已交给系统分享。", "success"))
        .catch((error) => {
          if (error?.name !== "AbortError") {
            showToast(`作品图片没有分享：${error.message}`);
          }
        })
        .finally(() => {
          trigger.disabled = false;
          trigger.textContent = originalText;
        });
    } catch (error) {
      trigger.disabled = false;
      trigger.textContent = originalText;
      showToast(`作品图片没有分享：${error.message}`);
    }
  } else if (action === "save-export") {
    const prepared = getPreparedExport(trigger);
    if (!prepared) return;
    try {
      prepared.files.forEach((file) => downloadExportFile(file));
      showToast("已开始保存作品图片。", "success");
    } catch (error) {
      showToast(`作品图片没有保存：${error.message}`);
    }
  } else if (action === "save-export-page") {
    const prepared = getPreparedExport(trigger);
    if (!prepared) return;
    const pageIndex = Number(trigger.dataset.pageIndex);
    const file = prepared.files[pageIndex];
    if (!file) {
      showToast("这一页图片已经失效，请重新生成。");
      return;
    }
    try {
      downloadExportFile(file);
      showToast(`已开始保存第 ${pageIndex + 1} 页。`, "success");
    } catch (error) {
      showToast(`第 ${pageIndex + 1} 页没有保存：${error.message}`);
    }
  } else if (action === "toggle-reply") {
    const form = document.querySelector(
      `[data-reply-form="${CSS.escape(trigger.dataset.commentId)}"]`,
    );
    if (form) {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("textarea").focus();
    }
  } else if (action === "delete-comment") {
    if (!requireVerifiedWrite(window.location.hash)) return;
    const confirmed = await requestConfirmation(
      "删除后会保留回复结构，并显示“该评论已由作者删除”。",
    );
    if (confirmed) {
      try {
        await service.deleteComment(trigger.dataset.commentId);
        showToast("评论已删除。", "success");
        await renderWork(trigger.dataset.workId);
      } catch (error) {
        if (routeToAccountSecurityIfUnverified(error)) return;
        showToast(error.message);
      }
    }
  } else if (action === "edit-work") {
    const workId = trigger.dataset.workId;
    window.location.hash = `#/works/${encodeURIComponent(workId)}/edit`;
  } else if (action === "delete-work") {
    if (!requireVerifiedWrite(window.location.hash)) return;
    const confirmed = await requestConfirmation(
      "作品删除后无法从平台恢复，相关点赞和评论也会一并移除。",
    );
    if (confirmed) {
      try {
        await service.deleteWork(trigger.dataset.workId);
        await refreshWorks();
        showToast("作品已删除。", "success");
        window.location.hash = "#/";
      } catch (error) {
        if (routeToAccountSecurityIfUnverified(error)) return;
        showToast(error.message);
      }
    }
  } else if (action === "restore-version") {
    const workId = trigger.dataset.workId;
    const sourceVersionId = trigger.dataset.sourceVersionId;
    const versionNumber = trigger.dataset.versionNumber;
    const changeSummary = window.prompt(
      `恢复到第 ${versionNumber} 版。请填写一句修改说明（必填）：`,
      `恢复第 ${versionNumber} 版`,
    );
    if (changeSummary === null) return;
    trigger.disabled = true;
    try {
      const versions = await service.listWorkVersions(workId);
      const expected = versions[0]?.version_number ?? null;
      await service.restoreWorkVersion({
        workId,
        sourceVersionId,
        expectedVersionNumber: expected,
        changeSummary: String(changeSummary).trim(),
      });
      await refreshWorks();
      showToast("已恢复旧版本。", "success");
      const target = `#/works/${encodeURIComponent(workId)}/versions`;
      if (window.location.hash !== target) {
        window.location.hash = target;
      } else {
        await renderCurrentRoute();
      }
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    } finally {
      if (trigger.isConnected) trigger.disabled = false;
    }
  } else if (action === "annotate-mode") {
    setAnnotateMode(!annotateMode);
  } else if (action === "open-annotation") {
    const raw = trigger.dataset.selection;
    if (!raw) return;
    const selection = JSON.parse(raw);
    const body = document.querySelector("[data-annotatable]");
    if (!body) return;
    openAnnotation(selection, body);
  } else if (action === "annotate-unit") {
    if (!annotateMode) return;
    const paragraph = trigger.closest("p");
    const body = document.querySelector("[data-annotatable]");
    if (!body || !paragraph || !body.contains(paragraph)) return;
    openAnnotation(
      {
        quoteText: trigger.textContent,
        startOffset:
          paragraphDisplayOffset(paragraph, body) + Number(trigger.dataset.start),
        endOffset: paragraphDisplayOffset(paragraph, body) + Number(trigger.dataset.end),
        versionId: body.dataset.versionId,
      },
      body,
    );
  } else if (action === "close-annotate") {
    annotateDialog.close();
  } else if (action === "toggle-featured") {
    if (!requireVerifiedWrite(window.location.hash)) return;
    const workId = trigger.dataset.workId;
    const previous = trigger.dataset.featured === "true";
    const next = !previous;
    trigger.disabled = true;
    setFeaturedLocally(workId, next);
    try {
      await service.setFeatured(workId, next);
      showToast("编辑推荐状态已更新。", "success");
    } catch (error) {
      setFeaturedLocally(workId, previous);
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    } finally {
      if (trigger.isConnected) trigger.disabled = false;
    }
  } else if (action === "cancel-confirm") {
    finishConfirmation(false);
  } else if (action === "accept-confirm") {
    finishConfirmation(true);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.id === "loginForm") {
    event.preventDefault();
    await handleAuthSubmit(form, "login");
  } else if (form.id === "registerForm") {
    event.preventDefault();
    await handleAuthSubmit(form, "register");
  } else if (form.id === "homeFilters") {
    event.preventDefault();
    const data = new FormData(form);
    // 回车提交会先触发一次即时加载；清除 300ms 防抖定时器，避免再次重复加载
    clearTimeout(window.__homeSearchTimer);
    setFilters({
      query: String(data.get("query") ?? "").trim(),
    });
  } else if (form.id === "annotateForm") {
    event.preventDefault();
    const content = String(new FormData(form).get("content") ?? "").trim();
    if (!content) {
      annotateFormMessage.textContent = "批注不能为空。";
      return;
    }
    const workId = pendingAnnotation?.workId;
    if (!workId) return;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await service.createQuotedComment({
        workId,
        workVersionId: pendingAnnotation.workVersionId,
        quoteText: pendingAnnotation.quoteText,
        startOffset: pendingAnnotation.startOffset,
        endOffset: pendingAnnotation.endOffset,
        content,
      });
      annotateDialog.close();
      pendingAnnotation = null;
      setAnnotateMode(false);
      showToast("批注已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      annotateFormMessage.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  } else if (form.id === "writingForm") {
    event.preventDefault();
    if (!requireVerifiedWrite(window.location.hash)) return;
    const wasEditing = Boolean(state.editingWork);
    const data = new FormData(form);
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    submit.textContent = wasEditing ? "正在保存…" : "正在发布…";
    try {
      const work = wasEditing
        ? await service.createWorkVersion({
            workId: state.editingWork.work.id,
            expectedVersionNumber: state.editingWork.latestVersionNumber,
            title: data.get("title"),
            excerpt: data.get("excerpt"),
            category: data.get("category"),
            content: data.get("content"),
            changeSummary: data.get("changeSummary"),
          })
        : await service.createWork({
            title: data.get("title"),
            excerpt: data.get("excerpt"),
            category: data.get("category"),
            content: data.get("content"),
          });
      localStorage.removeItem(DRAFT_KEY);
      state.editingWork = null;
      await refreshWorks();
      showToast(wasEditing ? "版本已保存。" : "作品已发布。", "success");
      window.location.hash = `#/works/${encodeURIComponent(work.id)}`;
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) {
        submit.disabled = false;
        submit.textContent = wasEditing ? "保存新版本" : "发布作品";
        return;
      }
      showToast(`作品没有发布：${error.message}`);
      submit.disabled = false;
      submit.textContent = wasEditing ? "保存新版本" : "发布作品";
    }
  } else if (form.matches("[data-comment-form]")) {
    event.preventDefault();
    if (!requireVerifiedWrite(window.location.hash)) return;
    const workId = form.dataset.commentForm;
    const content = new FormData(form).get("content");
    try {
      await service.addComment(workId, content);
      form.reset();
      showToast("评论已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    }
  } else if (form.matches("[data-reply-form]")) {
    event.preventDefault();
    if (!requireVerifiedWrite(window.location.hash)) return;
    const workId = form.dataset.workId;
    const content = new FormData(form).get("content");
    try {
      await service.addComment(workId, content, form.dataset.replyForm);
      showToast("回复已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) return;
      showToast(error.message);
    }
  } else if (form.id === "recoveryRequestForm") {
    event.preventDefault();
    const data = new FormData(form);
    const studentNumber = String(data.get("studentNumber") ?? "").trim();
    const message = document.querySelector(
      '[data-form-message="recovery-request"]',
    );
    if (!validateStudentNumber(studentNumber)) {
      message.textContent = "请输入 20 开头的十位学号。";
      return;
    }
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    submit.textContent = "正在发送…";
    try {
      const result = await service.requestPasswordRecovery(
        studentNumber,
        readTurnstileToken(form),
      );
      message.textContent = result.message;
      document.querySelector(
        '[data-form-message="recovery-complete"]',
      ).textContent = result.message;
      const completeForm = document.querySelector("#recoveryCompleteForm");
      completeForm.hidden = false;
      form.hidden = true;
      completeForm.querySelector('[name="studentNumber"]').value = studentNumber;
      renderTurnstile(completeForm);
      completeForm.querySelector('[name="code"]').focus();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.textContent = "发送验证码";
    }
  } else if (form.id === "recoveryCompleteForm") {
    event.preventDefault();
    const data = new FormData(form);
    const studentNumber = String(data.get("studentNumber") ?? "").trim();
    const code = String(data.get("code") ?? "").trim();
    const newPassword = String(data.get("newPassword") ?? "");
    const message = document.querySelector(
      '[data-form-message="recovery-complete"]',
    );
    if (!validateStudentNumber(studentNumber)) {
      message.textContent = "请输入 20 开头的十位学号。";
      return;
    }
    if (!validatePassword(newPassword)) {
      message.textContent = "密码至少八位，并同时包含字母和数字。";
      return;
    }
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    submit.textContent = "正在重设…";
    try {
      const result = await service.completePasswordRecovery(
        studentNumber,
        code,
        newPassword,
        readTurnstileToken(form),
      );
      message.textContent = result.message;
      closePasswordRecovery();
      showToast(result.message, "success");
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.textContent = "重设密码";
    }
  } else if (form.matches(".account-security-form")) {
    event.preventDefault();
    const action = form.querySelector("[data-action]")?.dataset.action;
    if (action && accountSecurityActions[action]) {
      await accountSecurityActions[action](form);
    }
  } else if (form.id === "profileForm") {
    event.preventDefault();
    if (!requireVerifiedWrite(window.location.hash)) return;
    const data = new FormData(form);
    const penNameInput = form.elements.namedItem("penName");
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "正在保存…";
    try {
      const profile = await service.updateProfile(form.dataset.profileId, {
        penName:
          penNameInput instanceof HTMLInputElement
            ? penNameInput.value
            : state.session.profile.pen_name,
        bio: data.get("bio"),
      });
      state.session.profile = profile;
      state.works.forEach((work) => {
        if (work.author_id === profile.id) work.author_pen_name = profile.pen_name;
      });
      state.browseDiscussions.items.forEach((comment) => {
        if (comment.user_id === profile.id) comment.user_pen_name = profile.pen_name;
      });
      updateHeader();
      showToast("公开资料已更新。", "success");
      closeProfileEditor();
      await renderAuthor(profile.id);
    } catch (error) {
      if (routeToAccountSecurityIfUnverified(error)) {
        submit.disabled = false;
        submit.textContent = "保存公开资料";
        return;
      }
      showToast(error.message);
      submit.disabled = false;
      submit.textContent = "保存公开资料";
    }
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.form?.id === "homeFilters") {
    if (target.name === "category") setFilters({ category: target.value });
    if (target.name === "sort") setFilters({ sort: target.value });
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return;
  }
  if (target.form?.id === "writingForm") {
    const form = target.form;
    const formData = new FormData(form);
    const counter = form.querySelector("[data-word-count]");
    counter.textContent = `${countChineseText(String(formData.get("content") ?? ""))} 字`;
    if (state.editingWork) return;
    const draft = Object.fromEntries(formData);
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const status = document.querySelector("[data-draft-status]");
    if (status) status.textContent = "草稿已保存在本机";
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "query") {
    clearTimeout(window.__homeSearchTimer);
    window.__homeSearchTimer = setTimeout(() => {
      setFilters({ query: target.value.trim() });
    }, 300);
  }
});

authDialog.addEventListener("close", () => {
  document.querySelectorAll("[data-form-message]").forEach((message) => {
    message.textContent = "";
  });
});

recoveryDialog.addEventListener("close", () => {
  document.querySelectorAll("[data-form-message]").forEach((message) => {
    message.textContent = "";
  });
});

confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishConfirmation(false);
});

window.addEventListener("hashchange", renderCurrentRoute);

mobileHomeMedia.addEventListener("change", () => {
  const route = parseRoute(window.location.hash);
  if (route.name === "home") renderHome();
});

if (!window.location.hash) {
  window.location.hash = "#/";
}

initialize();
