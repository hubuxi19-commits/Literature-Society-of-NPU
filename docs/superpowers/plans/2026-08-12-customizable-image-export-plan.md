# Customizable Image Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centered image-export workbench with a recommended default template, persistent typography controls, lightweight pagination preview, and final 1080×1920 PNG generation.

**Architecture:** Keep pagination/rendering in `js/image-export.mjs`, with one normalized options object driving preview DOM and PNG encoding. Keep dialog state/persistence in `js/app.js`; follow existing static dialog and editorial-paper patterns.

**Tech Stack:** Native ES modules, semantic HTML dialog/form controls, CSS custom properties, Node test runner, Playwright.

## Global Constraints

- Default: Song, 36px, left, 1.9 line-height, standard margins, title/author visible, rice-paper.
- Fonts: Song/FangSong/Kai/Hei; 28–52px in 2px steps; left/center/right; line-height 1.5/1.7/1.9/2.1; compact/standard/wide margins.
- Paper: rice paper, white, light xuan texture; output fixed 1080×1920 PNG.
- Preview never encodes PNG; final encoding begins only after “生成图片”.
- Versioned localStorage with safe fallback/reset; no database or work-content changes.

---

### Task 1: Normalized layout settings

**Files:** Modify `js/image-export.mjs`; test `tests/image-export.test.mjs`.

**Interfaces:** Produce `DEFAULT_EXPORT_LAYOUT`, `normalizeExportLayout(value)`, and `applyExportLayout(page, layout)`.

- [ ] Add failing tests for defaults, valid settings, invalid fallback, and applied CSS properties/classes.
- [ ] Run `node --test tests/image-export.test.mjs`; confirm expected missing-export failures.
- [ ] Implement frozen maps, normalization, CSS variables, alignment and paper classes.
- [ ] Re-run the focused tests; confirm zero failures.

### Task 2: Shared preview and final-page preparation

**Files:** Modify `js/image-export.mjs`; test `tests/image-export.test.mjs`.

**Interfaces:** Produce `prepareExportPages(work, options)` returning `{ root, pages, layout, cleanup() }`; `exportWorkImages(work, { layout })` reuses it and alone encodes PNG.

- [ ] Add failing tests for layout propagation, hidden first-page header geometry, and cleanup.
- [ ] Run focused tests; confirm `prepareExportPages` is missing.
- [ ] Extract existing DOM pagination to the shared preparer while preserving overflow checks and filenames.
- [ ] Re-run focused tests; confirm zero failures.

### Task 3: Centered workbench and persistence

**Files:** Modify `index.html`, `js/app.js`, `assets/styles.css`; test `tests/static-checks.mjs`, `tests/browser-check.cjs`.

**Interfaces:** Consume Task 1/2 APIs; produce `#exportDialog`, `#exportLayoutForm`, `#exportLayoutPreview`, and storage key `wenyuan-export-layout-v1`.

- [ ] Add failing checks for open-without-encoding, defaults, live alignment/page update, persistence/reset and explicit generation.
- [ ] Run static/browser checks; confirm missing-dialog failures.
- [ ] Add labeled semantic controls for all confirmed settings plus close, paging, reset and generate actions.
- [ ] Implement normalized persistence, debounced shared-DOM preview, cleanup and stale-result invalidation.
- [ ] Style a refined centered two-column editorial workbench, one-column below 760px, with 44px controls and no overflow.
- [ ] Generate via `exportWorkImages(work, { layout })`, render existing share/save results and close on success.
- [ ] Re-run static/browser checks; confirm zero failures.

### Task 4: Full regression and delivery

**Files:** Modify only for a test-backed regression fix.

- [ ] Run `npm run test:unit`; confirm zero failures.
- [ ] Run `npm run test:browser`; confirm desktop/mobile checks and no console/page errors.
- [ ] Inspect desktop/mobile screenshots for fit, readability and overflow.
- [ ] Apply verified changes to the clean upload clone preserving line endings, run `npm test`, commit, push `main`, and verify GitHub Pages.
