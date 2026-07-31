# Final Fix Report

Date: 2026-07-31  
Branch: `codex/mobile-feed-export`  
Reviewed base: `0fc9a60`  
Implementation commit: `8122710` (`fix: resolve final mobile and export review findings`)

## Outcome

All Important and Minor items in `final-review-findings.md` were addressed in one implementation wave. No Supabase production credentials were changed, no production migration was run, and no deployment, push, merge, or GitHub Pages publication was performed.

## TDD Evidence

Tests were added or strengthened before the production changes.

### RED

- `node --test --test-isolation=none tests/image-export.test.mjs`
  - 11 passed, 4 failed as expected.
  - Failures reproduced collapsed prose newlines, absent prose separator preservation, silent oversized poetry-line acceptance, and the missing per-page overflow assertion.
- `node --test --test-isolation=none tests/data-service.test.mjs`
  - 6 passed, 1 failed as expected because demo `createWork` accepted `诗歌` and arbitrary categories.
- `node --test --test-isolation=none tests/static-checks.mjs`
  - 5 passed, 5 failed as expected for the missing mobile bottom navigation, missing `touchcancel`/consume-only swipe suppression, missing disabled/category/safe-area styles, missing preview cleanup/ratio implementation, and stale README branch instructions.
- `npm run test:browser`
  - Failed as expected at `导出结果没有为每一页显示图片预览` before preview rendering was implemented.

The initial sandboxed Node and browser runs could not spawn child processes (`EPERM`). Focused unit tests were therefore run with Node's `--test-isolation=none`, and the browser/full-suite commands were rerun with the approved local child-process permission. The assertions then executed normally and produced the RED/GREEN evidence above and below.

### GREEN

- `node --test --test-isolation=none tests/image-export.test.mjs`
  - 15/15 passed.
- `node --test --test-isolation=none tests/data-service.test.mjs`
  - 7/7 passed.
- `node --test --test-isolation=none tests/static-checks.mjs`
  - 10/10 passed.
- `npm run test:browser`
  - Passed after the focused integration corrections; desktop and 390×844 mobile flows verified.
- Fresh pre-commit `npm test`
  - Unit/static: 65/65 passed.
  - Browser: passed; desktop and mobile flows verified.
- Fresh pre-commit `git diff --check`
  - Exit 0; no whitespace errors. Git emitted only the repository's LF-to-CRLF checkout warnings.

## Finding-by-Finding Changes

### 1. Mobile navigation and category UI

- Added a horizontally scrollable strip with exactly `全部、新诗、旧诗、散文、小说、随笔、其他`.
- Mobile search now has a dedicated search-only form; the misleading mobile sort control is absent.
- Category selection rebuilds the feed queue at its first item.
- Added a persistent safe-area-aware bottom navigation with exactly `翻阅、讨论、写作、我的`.
- Kept the desktop filter and navigation presentation unchanged.
- Browser coverage verifies labels, real horizontal overflow/scrollability at 390×844, queue reset, absence of mobile sorting, and all four bottom destinations.

### 2. Boundary swipe click consumption

- Every recognized horizontal gesture now sets click suppression whether or not the cursor can move.
- Suppression is cleared only by the consumed click; it is no longer cleared on the next animation frame.
- Added `touchcancel` cleanup.
- Browser coverage checks successful swipes plus first-item and last-item boundary swipes, including unchanged hash/work ID after the consumed click.

### 3. Export text integrity and overflow safety

- Prose export units preserve internal single newlines and explicit paragraph-gap newline text.
- Prose renders with `white-space: pre-wrap`.
- Pagination continues to split oversized prose by character boundary without losing text.
- An indivisible oversized poetry line now returns a clear error instead of being placed on a clipped page.
- Removed hidden overflow from the export page/body.
- Every rendered page and body is checked for `scrollHeight <= clientHeight` immediately before PNG encoding; generation errors instead of encoding an overflowing page.
- Unit and browser probes verify exact paragraph text/newlines, no text loss, oversized-line errors, and zero page/body overflow across every generated page.

### 4. Export previews and lifecycle cleanup

- Added one 1080×1920-ratio preview per prepared file.
- Preview URLs use `URL.createObjectURL` and are tracked on the prepared export.
- `cleanupPreparedExport()` revokes all preview URLs and releases the prepared blobs/files by clearing `state.currentExport`.
- Cleanup runs before regeneration, on route changes, and when a work view is re-rendered.
- A stale async generation result is discarded if navigation changes the active work while generation is running.
- Browser coverage verifies preview count, displayed ratio, natural 1080×1920 dimensions, regeneration cleanup, route-change cleanup, and independent temporary download-URL cleanup.

### 5. README release sequence

- Removed the stale `codex/literature-community-redesign` push/merge block and all `--no-ff` guidance.
- Retained one authoritative primary-checkout sequence using `git merge --ff-only codex/mobile-feed-export`, verification, and `git push origin main` only after approval and database migration verification.

### 6. Disabled feed controls

- Added muted border/color/opacity and `cursor: not-allowed` for `.mobile-feed-control:disabled`.
- Hover/active styling is restricted to `:not(:disabled)` controls.

### 7. Demo category validation

- Demo and Supabase `createWork` now share a `PUBLISHABLE_CATEGORIES` validator.
- Demo coverage rejects both the legacy `诗歌` value and an arbitrary category while retaining all six approved publishable categories.

## Changed Files

- `README.md`
- `index.html`
- `assets/styles.css`
- `js/app.js`
- `js/data-service.mjs`
- `js/image-export.mjs`
- `tests/browser-check.cjs`
- `tests/data-service.test.mjs`
- `tests/image-export.test.mjs`
- `tests/static-checks.mjs`
- `screenshots/mobile-home.png`
- `screenshots/mobile-reading.png`
- `screenshots/export-preview.png` (new)

## Visual Inspection

- `screenshots/mobile-home.png`: verified the approved category strip, single-card feed, disabled previous control, and persistent four-item bottom navigation at 390×844.
- `screenshots/mobile-reading.png`: verified poetry line preservation, reading-before-interaction order, export entry point, and persistent bottom navigation without horizontal overflow.
- `screenshots/export-preview.png`: verified all 11 generated pages appear at the intended portrait ratio, page numbering is legible, text remains inside each page, and the local wordmark stays in the reserved footer area.

## Self-Review

- Re-read every Important and Minor finding against the final diff.
- Confirmed mobile-only selectors contain the new category and navigation treatments; the desktop filter renderer remains unchanged.
- Confirmed suppression is set before attempting movement and reset only inside the click-consumption branch.
- Confirmed the export renderer calls `assertExportPageFits` for every page before `renderPageBlob`.
- Confirmed preview URL creation tracks URLs incrementally, so even partial URL-creation failure is cleaned by the single cleanup function.
- Confirmed route cleanup clears both URLs and the prepared file/blob references, including same-work re-renders.
- Confirmed README contains exactly one `git merge --ff-only codex/mobile-feed-export` command and no stale branch/`--no-ff` text.
- Confirmed no Supabase production credential, service-role key, migration execution claim, deployment claim, merge, push, or production-state mutation was introduced.

## Concerns / Handoff

- Oversized indivisible poetry lines intentionally produce a clear generation error; the implementation does not shrink typography because that could make page-to-page typography inconsistent.
- The release remains gated on a responsible operator running and verifying the existing Supabase migration in the correct project, then performing the documented primary-checkout fast-forward integration. Neither action was attempted here.
- This report is committed separately after implementation commit `8122710`; its own commit is the commit that introduces `.superpowers/sdd/final-fix-report.md` and is reported in the task handoff because embedding its own SHA would change that SHA.
