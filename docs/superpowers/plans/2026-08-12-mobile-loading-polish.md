# Mobile Loading Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove disruptive full-page loading screens during normal navigation, shorten first useful render, and make mobile feed transitions feel stable without changing the site’s editorial identity.

**Architecture:** Introduce a small, independently tested stale-while-revalidate cache for route data. Keep existing route content visible while requests run, defer non-route initialization requests, and update only the mobile feed card when moving between works.

**Tech Stack:** Vanilla ES modules, DOM APIs, CSS, Node test runner, Playwright browser checks.

## Global Constraints

- Do not add runtime dependencies.
- Do not change Supabase schema or public data contracts.
- Preserve the paper-and-vermilion editorial visual language.
- Keep all mobile interactive targets at least 44px.
- Never replace usable page content with the full-page “正在整理稿页” state during normal route navigation.

---

### Task 1: Route data cache

**Files:**
- Create: `js/route-cache.mjs`
- Create: `tests/route-cache.test.mjs`

**Interfaces:**
- Produces: `createRouteCache({ maxEntries, ttlMs, now })`, with `get`, `set`, `delete`, and `clear` methods.
- Consumes: plain string keys and arbitrary cached values.

- [ ] Write tests proving fresh values are returned, expired values are rejected, and oldest entries are evicted.
- [ ] Run `node --test tests/route-cache.test.mjs` and confirm failure because the module does not exist.
- [ ] Implement the minimal bounded TTL cache.
- [ ] Re-run `node --test tests/route-cache.test.mjs` and confirm all cases pass.

### Task 2: Non-blocking navigation and startup

**Files:**
- Modify: `js/app.js`
- Modify: `tests/static-checks.mjs`

**Interfaces:**
- Consumes: `createRouteCache` from Task 1.
- Produces: cached work/profile reads, background discussion loading, and content-preserving route transitions.

- [ ] Add failing static and browser-harness assertions that normal work/author routes do not invoke the full-page loader and that startup does not await discussion pagination before first route render.
- [ ] Run the focused checks and confirm they fail against the current implementation.
- [ ] Cache successful work and author route payloads for five minutes, prefetch works on `pointerdown`/`touchstart`, and retain current content while uncached routes load.
- [ ] Render the saved home session immediately; move settings, directory, and discussion refreshes behind first route render without changing their eventual state.
- [ ] Re-run the focused checks and route-cache tests.

### Task 3: Stable mobile feed updates and visual polish

**Files:**
- Modify: `js/app.js`
- Modify: `assets/styles.css`
- Modify: `tests/browser-check.cjs`

**Interfaces:**
- Consumes: existing mobile feed controller.
- Produces: in-place card updates, compact mobile masthead, safe dynamic viewport sizing, and unobtrusive local loading feedback.

- [ ] Add a failing mobile browser assertion that moving to the next feed item preserves the `.mobile-home` node.
- [ ] Run the mobile browser check and confirm it fails because the whole home tree is currently replaced.
- [ ] Replace only the feed stage/card when moving or appending prefetched items.
- [ ] Use `100dvh` with `100svh` fallback, reduce small-screen masthead/card spacing, and add an accessible thin route-progress indicator.
- [ ] Run the mobile browser check and confirm navigation, 44px targets, and stable home-node identity pass.

### Task 4: Full verification and upload

**Files:**
- Modify: `README.md` only if an existing performance note needs an update.

**Interfaces:**
- Consumes: all preceding changes.
- Produces: a tested GitHub commit based on the current remote `main` SHA.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:browser`.
- [ ] Inspect the final diff for unrelated changes and secrets.
- [ ] Create one atomic Git commit with the current remote commit as parent and update `refs/heads/main` without force.
- [ ] Verify the GitHub Pages deployment and smoke-test the mobile route.
