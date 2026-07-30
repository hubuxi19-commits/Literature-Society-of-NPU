# 文苑文学社区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可直接预览、可接入全新 Supabase、可部署到 GitHub Pages 的高校文学社作品交流平台。

**Architecture:** 应用是原生 ES Modules 单页应用，使用哈希路由和一个可替换的数据服务接口。未配置 Supabase 时使用内存演示服务；配置公开 URL 与 `anon` 密钥后切换到 Supabase 服务。所有真实写权限由数据库 RLS 兜底。

**Tech Stack:** HTML5、CSS3、JavaScript ES Modules、Supabase JavaScript SDK v2、Node.js `node:test`、Python Playwright、GitHub Pages。

## Global Constraints

- 产品是持续更新作品与讨论的文学社交平台，不使用刊期、季刊、封面作品或本期主题。
- 视觉使用纸白 `#F3EEE3`、浅纸 `#FBF8F1`、正文墨 `#1D1B18`、浅墨 `#696158`、朱砂 `#8C2F2B`、细线 `#CFC4B3`。
- 不使用玻璃拟态、大面积渐变、表情符号导航、圆角卡片瀑布流或首页全文展开。
- 学号只作为登录输入，不进入公开资料表，不在任何公开页面展示。
- 密码只由 Supabase Auth 处理，不进入业务表或前端查询。
- 前端仓库只允许出现 Supabase URL 与 `anon` 密钥，不允许出现 `service_role` 或数据库密码。
- 桌面端验证尺寸为 1440×1000，移动端为 390×844，并检查 768 像素断点。

---

### Task 1: 纯函数与路由基础

**Files:**
- Create: `tests/utils.test.mjs`
- Create: `js/utils.mjs`

**Interfaces:**
- Consumes: 原始日期、学号、密码、作品数组、评论数组和哈希字符串。
- Produces: `validateStudentNumber(value)`, `validatePassword(value)`, `studentNumberToAuthEmail(value)`, `formatDate(value)`, `createExcerpt(value, limit)`, `countChineseText(value)`, `buildCommentTree(comments)`, `parseRoute(hash)`, `filterAndSortWorks(works, filters)`, `escapeText(value)`。

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateStudentNumber,
  validatePassword,
  studentNumberToAuthEmail,
  createExcerpt,
  buildCommentTree,
  parseRoute,
  filterAndSortWorks,
} from "../js/utils.mjs";

test("学号必须是 20 开头的十位数字", () => {
  assert.equal(validateStudentNumber("2023123456"), true);
  assert.equal(validateStudentNumber("1923123456"), false);
});

test("学号映射为内部 Auth 标识", () => {
  assert.equal(studentNumberToAuthEmail(" 2023123456 "), "2023123456@accounts.wenyuan.invalid");
});

test("密码必须同时包含字母和数字且不少于八位", () => {
  assert.equal(validatePassword("wenyuan88"), true);
  assert.equal(validatePassword("12345678"), false);
});

test("摘要压缩空白并限制长度", () => {
  assert.equal(createExcerpt(" 山川\\n\\n与我们同行 ", 6), "山川 与我们…");
});

test("评论构建树并保留孤立回复", () => {
  const tree = buildCommentTree([
    { id: "2", parent_id: "1", created_at: "2026-01-02" },
    { id: "1", parent_id: null, created_at: "2026-01-01" },
    { id: "3", parent_id: "missing", created_at: "2026-01-03" },
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].replies[0].id, "2");
});

test("哈希路由识别作品和作者", () => {
  assert.deepEqual(parseRoute("#/works/abc"), { name: "work", id: "abc" });
  assert.deepEqual(parseRoute("#/authors/u1"), { name: "author", id: "u1" });
});

test("作品按关键词、分类和热度过滤排序", () => {
  const works = [
    { id: "1", title: "晚风", excerpt: "旧操场", author_pen_name: "松声", category: "诗歌", like_count: 1, comment_count: 2, created_at: "2026-01-01" },
    { id: "2", title: "河流", excerpt: "向北", author_pen_name: "白露", category: "散文", like_count: 9, comment_count: 0, created_at: "2026-01-02" },
  ];
  assert.deepEqual(filterAndSortWorks(works, { query: "操场", category: "全部", sort: "latest" }).map(item => item.id), ["1"]);
  assert.deepEqual(filterAndSortWorks(works, { query: "", category: "全部", sort: "likes" }).map(item => item.id), ["2", "1"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/utils.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `js/utils.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create the named exports with deterministic validation, immutable comment-tree construction, route parsing for all six routes, and stable filtering/sorting. `escapeText` returns a string for safe assignment through `textContent`; HTML rendering must not rely on it as an HTML sanitizer.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/utils.test.mjs`

Expected: 7 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/utils.test.mjs js/utils.mjs
git commit -m "test: define community utility behavior"
```

### Task 2: 演示数据服务与权限行为

**Files:**
- Create: `tests/data-service.test.mjs`
- Create: `js/demo-data.mjs`
- Create: `js/data-service.mjs`
- Create: `js/config.example.mjs`
- Create: `js/config.mjs`

**Interfaces:**
- Consumes: 登录凭据、作品字段、评论字段和当前会话。
- Produces: `createDataService(config)`, plus async methods `getSession`, `signIn`, `signUp`, `signOut`, `listWorks`, `getWork`, `createWork`, `deleteWork`, `toggleLike`, `addComment`, `deleteComment`, `getProfile`, `updateProfile`, `getSiteSettings`。

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";

test("演示成员可以登录、发布、点赞、回复和删除自己的内容", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  assert.equal(session.profile.pen_name, "松声");
  const work = await service.createWork({ title: "新作", excerpt: "摘要", content: "正文", category: "诗歌" });
  assert.equal(work.author_id, session.profile.id);
  const liked = await service.toggleLike(work.id);
  assert.equal(liked.liked, true);
  const root = await service.addComment(work.id, "读过了");
  const reply = await service.addComment(work.id, "谢谢", root.id);
  assert.equal(reply.parent_id, root.id);
  await service.deleteComment(root.id);
  assert.equal((await service.getWork(work.id)).comments.find(item => item.id === root.id).is_deleted, true);
  await service.deleteWork(work.id);
  await assert.rejects(() => service.getWork(work.id), /作品不存在/);
});

test("普通成员不能删除他人作品，管理员可以", async () => {
  const member = createDataService({ mode: "demo" });
  await member.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  await assert.rejects(() => member.deleteWork("work-river"), /没有权限/);
  const admin = createDataService({ mode: "demo" });
  await admin.signIn({ studentNumber: "2023000001", password: "editor88" });
  await admin.deleteWork("work-river");
  await assert.rejects(() => admin.getWork("work-river"), /作品不存在/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/data-service.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write minimal implementation**

Implement isolated demo state per service instance, seeded with at least four authors, six works, likes, nested comments and site settings. `config.mjs` exports `{ mode: "demo", supabaseUrl: "", supabaseAnonKey: "" }`. The service selects demo mode when credentials are empty; the Supabase branch uses the same method signatures and lazy-loads the official v2 browser SDK.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/data-service.test.mjs`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/data-service.test.mjs js/demo-data.mjs js/data-service.mjs js/config.example.mjs js/config.mjs
git commit -m "feat: add demo and Supabase data services"
```

### Task 3: 应用外壳与文学社区视觉

**Files:**
- Create: `tests/e2e_smoke.py`
- Create: `index.html`
- Create: `assets/styles.css`

**Interfaces:**
- Consumes: `js/app.js` rendered elements and stable `data-testid` selectors.
- Produces: semantic application shell, authentication dialog, confirmation dialog, toast region, responsive navigation and complete visual token system.

- [ ] **Step 1: Write the failing browser smoke test**

```python
from playwright.sync_api import sync_playwright

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.goto("http://127.0.0.1:4173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="让作品被读见").wait_for()
        assert page.get_by_test_id("work-list").is_visible()
        assert page.get_by_role("link", name="开始写作").is_visible()
        browser.close()

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python "C:\Users\legion\.agents\skills\webapp-testing\scripts\with_server.py" --server "python -m http.server 4173 --bind 127.0.0.1" --port 4173 -- python tests/e2e_smoke.py`

Expected: FAIL because `index.html` or the expected interface does not exist.

- [ ] **Step 3: Write minimal implementation**

Create a semantic shell with skip link, header, navigation, `<main id="app">`, footer, auth `<dialog>`, confirmation `<dialog>` and `aria-live` toast. Build CSS variables from the locked palette, system Song/FangSong stacks, directory-style ruled lists,朱批边注, 2:1 desktop layout, 768px and 600px responsive rules, focus styles and reduced-motion override.

- [ ] **Step 4: Run static checks**

Run: `node tests/static-checks.mjs` after Task 4 adds it.

Expected after Task 4: all structural checks pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e_smoke.py index.html assets/styles.css
git commit -m "feat: build literary community shell"
```

### Task 4: 路由、页面渲染与完整交互

**Files:**
- Create: `tests/static-checks.mjs`
- Create: `js/app.js`
- Modify: `index.html`
- Modify: `assets/styles.css`

**Interfaces:**
- Consumes: all utilities and data-service methods from Tasks 1–2.
- Produces: renderers and event handlers for home, work, author, write, discussions and submissions views; auth, search, category, sort, like, comment, reply, delete, profile editing and mobile navigation interactions.

- [ ] **Step 1: Write the failing static test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("HTML 使用独立样式和模块脚本并包含可访问弹窗", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /assets\\/styles\\.css/);
  assert.match(html, /type="module" src="\\.\\/js\\/app\\.js"/);
  assert.match(html, /<dialog[^>]+id="authDialog"/);
  assert.doesNotMatch(html, /service_role/i);
});

test("公开源代码不包含完整演示学号的可见文案", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, />\\s*20\\d{8}\\s*</);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/static-checks.mjs`

Expected: FAIL because `js/app.js` is missing or module entry is absent.

- [ ] **Step 3: Write minimal implementation**

Implement a single application state object, hashchange routing, event delegation and renderer functions. Use `textContent` for user data through DOM construction helpers. The home view contains editor note, featured works, active discussions, filters, work list and community rail. The work view contains long-form text, actions, author block and comment tree. The write view keeps a localStorage draft. Auth uses one dialog with login/register tabs. All mutations re-render only after service confirmation except optimistic likes with rollback.

- [ ] **Step 4: Run all unit/static tests**

Run: `node --test tests/*.test.mjs tests/static-checks.mjs`

Expected: all tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/static-checks.mjs js/app.js index.html assets/styles.css
git commit -m "feat: implement community routes and interactions"
```

### Task 5: Supabase schema, Auth trigger and RLS

**Files:**
- Create: `tests/schema.test.mjs`
- Create: `supabase/schema.sql`

**Interfaces:**
- Consumes: Supabase Auth `auth.users`, `auth.uid()` and authenticated/anon roles.
- Produces: `profiles`, `works`, `likes`, `comments`, `site_settings`, helper functions, triggers, indexes and enabled RLS policies.

- [ ] **Step 1: Write the failing schema contract test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("schema enables RLS and never creates a password column", async () => {
  const sql = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  for (const table of ["profiles", "works", "likes", "comments", "site_settings"]) {
    assert.match(sql, new RegExp(`alter table public\\\\.${table} enable row level security`, "i"));
  }
  assert.doesNotMatch(sql, /\\bpassword\\b/i);
  assert.match(sql, /auth\\.uid\\(\\)/i);
  assert.match(sql, /handle_new_user/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/schema.test.mjs`

Expected: FAIL because `supabase/schema.sql` is missing.

- [ ] **Step 3: Write minimal implementation**

Create idempotent extensions, tables, constraints, updated-at trigger, new-user profile trigger, aggregate-friendly indexes and policies. Profiles are publicly readable but expose no login identifier. Members can update only their own non-role fields through a protected RPC or column-specific grant. Authors manage their own works; admins manage all works and feature flags. Likes are self-owned. Comments use soft delete through an RPC that enforces owner/admin rights. Site settings are public-read/admin-write.

- [ ] **Step 4: Run schema test**

Run: `node --test tests/schema.test.mjs`

Expected: 1 test passes, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/schema.test.mjs supabase/schema.sql
git commit -m "feat: add secure Supabase schema and policies"
```

### Task 6: 浏览器验证、文档与交付

**Files:**
- Modify: `tests/e2e_smoke.py`
- Create: `tests/browser_check.py`
- Create: `package.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `SECURITY.md`
- Create: `screenshots/desktop-home.png`
- Create: `screenshots/mobile-home.png`
- Create: `screenshots/desktop-reading.png`

**Interfaces:**
- Consumes: completed application and local static server.
- Produces: repeatable commands, screenshots, deployment instructions and final verification evidence.

- [ ] **Step 1: Expand the failing browser test**

The browser test must navigate home → work → author → discussions → submissions, exercise search/category/sort, open/close auth, log in with the documented demo member, open the write desk, publish a work, like it, comment, reply, verify member cannot see admin-only controls, log in as admin and verify admin controls, then repeat layout checks at 390×844. It must collect console errors and assert `document.documentElement.scrollWidth <= window.innerWidth`.

- [ ] **Step 2: Run browser test and observe failures**

Run with the webapp-testing helper and the local static server.

Expected: any missing selector, interaction or responsive defect produces a failing assertion with the affected route.

- [ ] **Step 3: Fix only observed browser defects**

Adjust `app.js`, `styles.css` or semantic labels for failures. Add a regression assertion for each defect before applying its fix.

- [ ] **Step 4: Write operational documentation**

README must include:

- `python -m http.server 4173` local preview.
- demo accounts without showing them in public application pages.
- new Supabase project creation, `schema.sql` execution, Auth email confirmation setting, config values and RLS verification queries.
- `node --test` and Playwright test commands.
- Git initialization, remote addition, commit, push and GitHub Pages “Deploy from a branch” instructions.
- custom domain and HTTPS notes.
- explicit warning that `anon` is public but `service_role` must never enter the frontend.
- production checklist for school email binding, password recovery, abuse prevention, content moderation, backups and policy testing.

SECURITY.md must document responsible reporting, secret handling, Auth/RLS boundaries and the limitations of deterministic student-number login identifiers.

- [ ] **Step 5: Run complete verification**

Run:

```bash
node --test tests/*.test.mjs tests/static-checks.mjs
python -m compileall tests
python "C:\Users\legion\.agents\skills\webapp-testing\scripts\with_server.py" --server "python -m http.server 4173 --bind 127.0.0.1" --port 4173 -- python tests/browser_check.py
git diff --check
git status --short
```

Expected: all Node tests pass; Python compile succeeds; browser checks pass at desktop and mobile sizes with zero unexpected console errors and no horizontal overflow; `git diff --check` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add README.md SECURITY.md package.json .gitignore tests screenshots
git commit -m "docs: add verification and deployment guide"
```
