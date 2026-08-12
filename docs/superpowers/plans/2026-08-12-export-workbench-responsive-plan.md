# Export Workbench Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the export workbench usable at medium desktop widths without horizontal scrolling or clipped actions.

**Architecture:** Add a dedicated 1100px breakpoint between the existing desktop and 760px mobile layouts. Verify computed grid columns, overflow, preview ratio and action visibility in Playwright.

### Task 1: Responsive regression

- [ ] Add browser assertions at 920px, 1024px and 1440px.
- [ ] Run the browser test and confirm 920px/1024px fail under the current double-column layout.

### Task 2: Medium-width layout

- [ ] Add an `@media (max-width: 1099px) and (min-width: 761px)` rule.
- [ ] Switch the workbench to one column, make the control grid use three columns where space permits, keep the preview centered and the actions sticky.
- [ ] Ensure the dialog and workbench use vertical overflow only.
- [ ] Re-run browser and complete tests.

### Task 3: Delivery

- [ ] Sync only verified files to the clean upload clone.
- [ ] Commit, push `main`, and verify GitHub Pages contains the 1099px breakpoint.
