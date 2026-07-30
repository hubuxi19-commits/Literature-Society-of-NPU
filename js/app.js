import { config } from "./config.mjs";
import { createDataService } from "./data-service.mjs";
import {
  buildCommentTree,
  countChineseText,
  createExcerpt,
  filterAndSortWorks,
  formatDate,
  parseRoute,
  validatePassword,
  validateStudentNumber,
} from "./utils.mjs";

const service = createDataService(config);
const app = document.querySelector("#app");
const siteHeader = document.querySelector(".site-header");
const authDialog = document.querySelector("#authDialog");
const confirmDialog = document.querySelector("#confirmDialog");
const confirmMessage = document.querySelector("#confirmMessage");
const accountButton = document.querySelector("#accountButton");
const accountMenu = document.querySelector("#accountMenu");
const profileLink = document.querySelector("#profileLink");
const demoRibbon = document.querySelector("#demoRibbon");
const toast = document.querySelector("#toast");

const CATEGORIES = ["全部", "诗歌", "散文", "小说", "随笔", "其他"];
const DRAFT_KEY = "wenyuan-writing-draft";

const state = {
  session: null,
  works: [],
  settings: null,
  discussions: [],
  filters: {
    query: "",
    category: "全部",
    sort: "latest",
  },
  confirmResolver: null,
  toastTimer: null,
  authReturnHash: null,
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
  } else {
    accountButton.textContent = "登录";
    accountButton.dataset.action = "open-auth";
    accountMenu.hidden = true;
  }

  const route = parseRoute(window.location.hash);
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active =
      (link.dataset.nav === "home" && ["home", "work", "author", "write"].includes(route.name)) ||
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
}

function closeAuth() {
  if (authDialog.open) authDialog.close();
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
  margin.append(element("span", { text: work.category }));
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
      text: `${work.author_pen_name} · ${work.category} · 喜欢 ${work.like_count}`,
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
  return [...state.discussions]
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

function calculateAuthors() {
  const map = new Map();
  state.works.forEach((work) => {
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

function renderCommunityRail() {
  const rail = element("aside", {
    className: "community-rail",
    attrs: { "aria-label": "社区动态" },
  });
  const authorsSection = element("section", { className: "rail-section" }, [
    element("p", { className: "eyebrow", text: "COMMUNITY" }),
    element("h3", { text: "活跃作者" }),
  ]);
  const authorsList = element("ol", { className: "rail-list" });
  calculateAuthors()
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
  filterAndSortWorks(state.works, {
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
    body: "诗歌、散文、小说、随笔与其他文字均可投稿。",
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

function renderHome() {
  const shell = element("div", { className: "page-shell" });
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
  const featuredWorks = state.works
    .filter((work) => work.is_featured)
    .slice(0, 3);
  (featuredWorks.length ? featuredWorks : state.works.slice(0, 3)).forEach(
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

  const filtered = filterAndSortWorks(state.works, state.filters);
  const content = element("section", { className: "content-grid" });
  const worksSection = element("div");
  worksSection.append(
    element("div", { className: "section-heading" }, [
      element("div", {}, [
        element("p", { className: "eyebrow", text: "NEW WRITING" }),
        element("h2", { text: "持续更新的新作" }),
      ]),
      element("p", { text: `共 ${filtered.length} 篇` }),
    ]),
  );
  const list = element("div", {
    className: "work-list",
    testId: "work-list",
  });
  if (filtered.length) {
    filtered.forEach((work) => list.append(createWorkRow(work)));
  } else {
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
  content.append(worksSection, renderCommunityRail());

  shell.append(hero, editorial, leadGrid, createFilterBand(), content);
  replaceContent(app, shell);
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

function renderParagraphs(content) {
  const body = element("article", { className: "reading-body" });
  String(content ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .forEach((paragraph) => {
      body.append(element("p", { text: paragraph }));
    });
  return body;
}

function userCanManage(authorId) {
  return Boolean(
    state.session &&
      (state.session.profile.id === authorId ||
        state.session.profile.role === "admin"),
  );
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

async function renderWork(workId) {
  showLoading("正在展开作品");
  try {
    const work = await service.getWork(workId);
    const shell = element("div", { className: "reading-shell" });
    const head = element("header", { className: "reading-head" });
    const margin = element("aside", { className: "reading-margin" }, [
      element("span", { text: work.category }),
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
          }),
        );
      }
      adminActions.append(
        element("button", {
          className: "quiet-button",
          type: "button",
          text: "删除作品",
          dataset: { action: "delete-work", workId: work.id },
        }),
      );
      actionBar.append(adminActions);
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
          (item.category === work.category || item.author_id === work.author_id),
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
      renderParagraphs(work.content),
      actionBar,
      authorNote,
      commentsBlock,
      relatedBlock,
    );
    replaceContent(app, shell);
  } catch (error) {
    showError("作品无法打开", error.message, true);
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

function renderWrite() {
  if (!state.session) {
    renderAuthGate();
    return;
  }
  const draft = readDraft();
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
      text: Object.keys(draft).length ? "已恢复浏览器中的本地草稿" : "草稿会自动保存在本机",
      dataset: { draftStatus: "true" },
    }),
  ]);
  const form = element("form", {
    className: "writing-form",
    id: "writingForm",
  });
  form.append(
    element("div", {}, [
      element("h1", { text: "写一篇新作" }),
      element("p", {
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
  CATEGORIES.filter((category) => category !== "全部").forEach((category) => {
    select.append(
      element("option", {
        value: category,
        text: category,
        attrs: { selected: (draft.category ?? "诗歌") === category },
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
  const footer = element("div", { className: "form-footer" }, [
    element("span", {
      className: "word-count",
      text: `${countChineseText(draft.content ?? "")} 字`,
      dataset: { wordCount: "true" },
    }),
    element("button", {
      className: "primary-button",
      type: "submit",
      text: "发布作品",
    }),
  ]);
  form.append(titleLabel, row, contentLabel, footer);
  shell.append(aside, form);
  replaceContent(app, shell);
}

async function renderAuthor(profileId) {
  showLoading("正在整理作者作品");
  try {
    const profile = await service.getProfile(profileId);
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

    if (state.session?.profile.id === profile.id) {
      const form = element("form", {
        className: "profile-form",
        id: "profileForm",
        dataset: { profileId: profile.id },
      });
      form.append(
        element("h2", { text: "编辑公开资料" }),
        element("label", {}, [
          element("span", { text: "笔名" }),
          element("input", {
            name: "penName",
            value: profile.pen_name,
            attrs: { required: true, maxlength: 24 },
          }),
        ]),
        element("label", {}, [
          element("span", { text: "简介" }),
          element("textarea", {
            name: "bio",
            attrs: { maxlength: 240 },
          }),
        ]),
        element("button", {
          className: "primary-button",
          type: "submit",
          text: "保存资料",
        }),
      );
      form.querySelector("textarea").textContent = profile.bio ?? "";
      content.append(form);
    } else {
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

async function loadAllDiscussions() {
  const worksWithComments = await Promise.all(
    state.works.map(async (work) => {
      try {
        const detail = await service.getWork(work.id);
        return detail.comments.map((comment) => ({
          ...comment,
          work_id: work.id,
          work_title: work.title,
        }));
      } catch {
        return [];
      }
    }),
  );
  return worksWithComments
    .flat()
    .sort(
      (left, right) =>
        new Date(right.created_at) - new Date(left.created_at),
    );
}

async function renderDiscussions() {
  showLoading("正在收拢讨论");
  try {
    state.discussions = await loadAllDiscussions();
    const shell = element("div", { className: "page-shell" });
    shell.append(
      createPageHeader(
        "DISCUSSIONS",
        "正在讨论",
        "一条好评论不是判词，而是把自己读到的细节交还给作者和下一位读者。",
      ),
    );
    const list = element("ol", { className: "discussion-page-list" });
    state.discussions.forEach((discussion) => {
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
    if (!state.discussions.length) {
      list.append(
        element("li", {
          className: "empty-state",
          text: "社区里还没有讨论。",
        }),
      );
    }
    shell.append(list);
    replaceContent(app, shell);
  } catch (error) {
    showError("讨论暂时无法加载", error.message, true);
  }
}

function renderSubmissions() {
  const shell = element("div", { className: "page-shell" });
  const submission = state.settings?.submission ?? {
    title: "长期征稿",
    body: "诗歌、散文、小说、随笔与其他文字均可投稿。",
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
      text: "平台长期接收原创诗歌、散文、小说、随笔以及暂时难以归类的文字。作品发布后会立即进入新作流，不必等待集中刊发。",
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

async function renderCurrentRoute() {
  accountMenu.hidden = true;
  siteHeader.dataset.menuOpen = "false";
  document
    .querySelector(".menu-toggle")
    .setAttribute("aria-expanded", "false");
  updateHeader();
  const route = parseRoute(window.location.hash);
  try {
    if (route.name === "home") renderHome();
    else if (route.name === "work") await renderWork(route.id);
    else if (route.name === "author") await renderAuthor(route.id);
    else if (route.name === "write") renderWrite();
    else if (route.name === "discussions") await renderDiscussions();
    else if (route.name === "submissions") renderSubmissions();
    else renderNotFound();
  } finally {
    window.scrollTo({ top: 0, behavior: "instant" });
    app.focus({ preventScroll: true });
  }
}

async function refreshWorks() {
  state.works = await service.listWorks();
}

async function refreshDiscussionsPreview() {
  const candidates = [...state.works]
    .sort((left, right) => right.comment_count - left.comment_count)
    .slice(0, 4);
  const details = await Promise.all(
    candidates.map(async (work) => {
      try {
        const detail = await service.getWork(work.id);
        return detail.comments.map((comment) => ({
          ...comment,
          work_id: work.id,
          work_title: work.title,
        }));
      } catch {
        return [];
      }
    }),
  );
  state.discussions = details.flat();
}

async function initialize() {
  showLoading();
  try {
    [state.session, state.settings, state.works] = await Promise.all([
      service.getSession(),
      service.getSiteSettings(),
      service.listWorks(),
    ]);
    await refreshDiscussionsPreview();
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
          });
    form.reset();
    closeAuth();
    updateHeader();
    await refreshWorks();
    showToast(
      mode === "login" ? "已登录，欢迎回来。" : "账户已创建，可以开始写作。",
      "success",
    );
    const returnHash = state.authReturnHash;
    state.authReturnHash = null;
    if (returnHash && window.location.hash !== returnHash) {
      window.location.hash = returnHash;
    } else {
      await renderCurrentRoute();
    }
  } catch (error) {
    message.textContent = error.message;
  }
}

async function handleLike(button) {
  if (!state.session) {
    openAuth("login", window.location.hash);
    return;
  }
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
    openAuth("login", trigger.dataset.returnHash || null);
  } else if (action === "close-auth") {
    closeAuth();
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
    state.filters = { query: "", category: "全部", sort: "latest" };
    renderHome();
  } else if (action === "retry-route") {
    await initialize();
  } else if (action === "toggle-like") {
    await handleLike(trigger);
  } else if (action === "toggle-reply") {
    const form = document.querySelector(
      `[data-reply-form="${CSS.escape(trigger.dataset.commentId)}"]`,
    );
    if (form) {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("textarea").focus();
    }
  } else if (action === "delete-comment") {
    const confirmed = await requestConfirmation(
      "删除后会保留回复结构，并显示“该评论已由作者删除”。",
    );
    if (confirmed) {
      try {
        await service.deleteComment(trigger.dataset.commentId);
        showToast("评论已删除。", "success");
        await renderWork(trigger.dataset.workId);
      } catch (error) {
        showToast(error.message);
      }
    }
  } else if (action === "delete-work") {
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
        showToast(error.message);
      }
    }
  } else if (action === "toggle-featured") {
    try {
      await service.setFeatured(
        trigger.dataset.workId,
        trigger.dataset.featured !== "true",
      );
      await refreshWorks();
      showToast("编辑推荐状态已更新。", "success");
      await renderWork(trigger.dataset.workId);
    } catch (error) {
      showToast(error.message);
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
    state.filters.query = String(data.get("query") ?? "").trim();
    renderHome();
  } else if (form.id === "writingForm") {
    event.preventDefault();
    const data = new FormData(form);
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    submit.textContent = "正在发布…";
    try {
      const work = await service.createWork({
        title: data.get("title"),
        excerpt: data.get("excerpt"),
        category: data.get("category"),
        content: data.get("content"),
      });
      localStorage.removeItem(DRAFT_KEY);
      await refreshWorks();
      showToast("作品已发布。", "success");
      window.location.hash = `#/works/${encodeURIComponent(work.id)}`;
    } catch (error) {
      showToast(`作品没有发布：${error.message}`);
      submit.disabled = false;
      submit.textContent = "发布作品";
    }
  } else if (form.matches("[data-comment-form]")) {
    event.preventDefault();
    const workId = form.dataset.commentForm;
    const content = new FormData(form).get("content");
    try {
      await service.addComment(workId, content);
      form.reset();
      showToast("评论已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      showToast(error.message);
    }
  } else if (form.matches("[data-reply-form]")) {
    event.preventDefault();
    const workId = form.dataset.workId;
    const content = new FormData(form).get("content");
    try {
      await service.addComment(workId, content, form.dataset.replyForm);
      showToast("回复已发表。", "success");
      await renderWork(workId);
    } catch (error) {
      showToast(error.message);
    }
  } else if (form.id === "profileForm") {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const profile = await service.updateProfile(form.dataset.profileId, {
        pen_name: data.get("penName"),
        bio: data.get("bio"),
      });
      state.session.profile = profile;
      updateHeader();
      showToast("公开资料已更新。", "success");
      await renderAuthor(profile.id);
    } catch (error) {
      showToast(error.message);
    }
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.form?.id === "homeFilters") {
    if (target.name === "category") state.filters.category = target.value;
    if (target.name === "sort") state.filters.sort = target.value;
    renderHome();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return;
  }
  if (target.form?.id === "writingForm") {
    const form = target.form;
    const draft = Object.fromEntries(new FormData(form));
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const counter = form.querySelector("[data-word-count]");
    counter.textContent = `${countChineseText(draft.content ?? "")} 字`;
    const status = document.querySelector("[data-draft-status]");
    if (status) status.textContent = "草稿已保存在本机";
  }
});

authDialog.addEventListener("close", () => {
  document.querySelectorAll("[data-form-message]").forEach((message) => {
    message.textContent = "";
  });
});

confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishConfirmation(false);
});

window.addEventListener("hashchange", renderCurrentRoute);

if (!window.location.hash) {
  window.location.hash = "#/";
}

initialize();
