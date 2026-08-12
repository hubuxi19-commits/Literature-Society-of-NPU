# Mobile Filter Search Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile category strip and collapsed search panel with one accessible row containing a category menu, search input, and explicit search button.

**Architecture:** Reuse the existing filter state and submit pipeline. Build one mobile-only form with a native `details` category menu, keep category selection immediate, and make keyword requests occur only on form submission.

**Tech Stack:** Vanilla ES modules, DOM APIs, CSS, Node test runner, Playwright.

## Global Constraints

- Desktop filters remain unchanged.
- Mobile layout is `[当前分类 ▾] [搜索作品] [搜索]` on one row.
- Category selection filters immediately and closes the menu.
- Typing does not request; button click and Enter submit the search.
- All controls remain at least 44px high and the page has no horizontal overflow.
- Existing paper-and-vermilion styling and non-blocking route loading remain unchanged.

---

### Task 1: Lock the mobile toolbar behavior

**Files:**
- Modify: `tests/static-checks.mjs`
- Modify: `tests/browser-check.cjs`

**Interfaces:**
- Consumes: the rendered `.mobile-filter-bar` form.
- Produces: assertions for one-row structure, explicit submit, menu state, category selection, and combined category/query search.

- [ ] Add a static check requiring `createMobileFilterBar`, a category menu, and the absence of the old strip/details calls in `renderMobileHome`.
- [ ] Add a 390×844 browser check for the three visible controls, 44px targets, closed-by-default menu, category selection, button search, Enter search, and no input-time request.
- [ ] Run focused checks and confirm they fail because the combined bar does not exist.

### Task 2: Implement the combined toolbar

**Files:**
- Modify: `js/app.js`
- Modify: `assets/styles.css`

**Interfaces:**
- Produces: `createMobileFilterBar()` and `closeMobileCategoryMenu()`.
- Consumes: `CATEGORIES`, `state.filters`, `setFilters`, and the existing `homeFilters` submit handler.

- [ ] Replace the two old mobile builders with `createMobileFilterBar()`.
- [ ] Render the category `details` button, complete category menu, query input, and submit button.
- [ ] Close the category menu after selection and when clicking outside.
- [ ] Restrict the 300ms input debounce to non-mobile filter forms so mobile typing remains local until submit.
- [ ] Add compact grid/menu CSS with 44px targets and no overflow.
- [ ] Re-run focused static and browser checks until green.

### Task 3: Verify and publish

**Files:**
- Create: `docs/superpowers/plans/2026-08-12-mobile-filter-search-bar-plan.md`

**Interfaces:**
- Consumes: the completed toolbar changes.
- Produces: one atomic fast-forward commit on remote `main`.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:browser`.
- [ ] Review the final diff and exclude generated screenshots and dependencies.
- [ ] Upload the app, CSS, tests, and this plan as one non-force commit.
- [ ] Wait for GitHub Pages and verify the deployed toolbar assets.
