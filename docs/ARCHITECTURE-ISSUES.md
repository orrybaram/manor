# Architecture Audit — Issues & Inconsistencies

Log of issues surfaced while producing [`ARCHITECTURE.md`](./ARCHITECTURE.md). Each entry is scoped small enough to be an ADR or a one-PR fix. Severity is a rough guide, not a priority order.

> **Note:** A prior audit pass claimed `.env` was committed to the repo. That was incorrect — `.gitignore` lists `.env` and `git ls-files` shows only `.env.example` tracked. Credentials are not exposed.

---

## High

### 1. `pnpm kill` script targets the wrong daemon paths — ✅ Resolved

**Location:** `package.json:19`

Script now points at `~/.manor/daemon/terminal-host.{pid,sock,token}`. A follow-up could replace the inline shell with a Node script that imports `DAEMON_DIR` to prevent future drift.

---

### 2. Duplicate ADR numbers in `docs/decisions/` — ✅ Resolved

Collisions renumbered using the "oldest wins the number" rule (alphabetical tiebreak). New numbers:

- `adr-001-split-electron-main` → `adr-119`
- `adr-001-browser-pane-features` → `adr-120`
- `adr-001-git-push` → `adr-121`
- `adr-057-webview-context-menu-devtools` → `adr-122`
- `adr-093-standardize-input-component` → `adr-123`
- `adr-116-stale-task-reconciliation` → `adr-124`

Root-cause fix (ADR workflow skill coordinating number allocation across worktrees) still pending.

---

### 3. Orphan ADR files at `docs/` root — ✅ Resolved

- `docs/ADR-077-project-setup-wizard.md` → `docs/decisions/adr-125-project-setup-wizard/index.md`
- `docs/ADR-session-restore.md` → `docs/decisions/adr-126-session-restore/index.md`

Titles updated to match lowercase-slug / numbered convention. No `adr-session-restore*` family exists — issue #20's "may be superseded" note was stale.

---

### 4. `manorDataDir()` duplicated across seven files — ✅ Resolved

**Locations:** `electron/persistence.ts:30`, `electron/task-persistence.ts:6`, `electron/preferences.ts:5`, `electron/keybindings.ts`, `electron/window.ts:14`, `electron/linear.ts`, `electron/shell.ts`

**Resolved:** via ADR-127. All duplicated definitions have been consolidated into `electron/paths.ts`, which is now the single source of truth for `manorDataDir()`, `manorHomeDir()`, and named file getters. All call sites import from this central module.

---

### 5. Two conflicting persistence roots (`~/Library/Application Support/Manor` vs `~/.manor`) — ✅ Resolved

Manor stores app data in two different locations depending on who writes it:

| Path | Used for | Platform-aware? |
|---|---|---|
| `manorDataDir()` → `~/Library/Application Support/Manor/` (macOS) | projects, tasks, prefs, keybindings, theme, window state | yes |
| `~/.manor/` (hardcoded) | daemon socket/pid/token, hook port, webview server port, worktrees, hook scripts | no |

**Resolved:** via ADR-127. The split is now documented in `ARCHITECTURE.md` under "Filesystem layout". The intentional design — `~/.manor/` for external-tool discovery, `manorDataDir()` for internal-only state — is explained. See the "Rule for adding a new path" section for guidance on where new files should go.

---

## Medium

### 6. Inconsistent IPC argument validation

**Location:** `electron/ipc/*.ts`

`electron/ipc-validate.ts` provides `assertString`, `assertPositiveInt`, etc. Seven IPC files use them (`misc`, `tasks`, `branches-diffs`, `pty`, `webview`, `projects`, `integrations`); six files do not (`layout`, `ports`, `theme`, `processes`, plus `types.ts` / `index.ts` which are non-handler). The renderer is trusted because it's in-process, but the IPC surface is also exposed to the preload — a misbehaving renderer extension or a future API consumer can send malformed args and hit runtime type errors.

**Fix:** Extend validator usage to all handler files, or add a schema wrapper (zod/valibot) that each `ipcMain.handle` is required to go through.

---

### 7. `src/store/app-store.ts` is 86 KB

The app store owns pane/tab/panel tree state, closed-pane snapshots, active workspace tracking, focus, and a lot of composite actions. At 86 KB it's the largest file in the codebase and a hotspot for merge conflicts. Pure tree mutations have been extracted (`pane-tree.ts`, `panel-tree.ts`), but the store still bundles unrelated concerns (focus tracking, closed-pane history, tabbing, panels).

**Fix:** Split into slices — `useFocusStore`, `useTabStore`, `useClosedPanesStore`, etc. — or apply Zustand's slice pattern within a single store. Track via an ADR.

---

### 8. Linear API key stored in plaintext

**Location:** `electron/linear.ts` (key persisted to the data dir)

Linear authenticates with a user-supplied API key that Manor writes to disk in plaintext. File permissions inherit from the user umask, so any other process running as the user can read it.

**Fix:** Use the OS keychain via `keytar` (or `electron.safeStorage` on macOS, which is already linked via the Electron runtime). No new dependency needed for the latter.

---

### 9. Forward-looking TODOs reference an unimplemented ADR (`adr-107`)

**Locations:** `electron/main.ts:10`, `electron/ipc/misc.ts:51, 115`, `electron/notifications.ts:65`, `electron/branch-watcher.ts:57`

Five `TODO(adr-107)` / `TODO(remote-backend)` comments mark places where direct `execFile` / filesystem reads bypass the backend abstraction. These aren't bugs — they're intentional markers for when the remote backend lands. But there's no ADR-107 in `docs/decisions/`, so a reader following the trail hits a dead end.

**Fix:** Either (a) write ADR-107 describing the remote backend plan so the TODOs link to real context, or (b) drop the TODO markers and document the boundary in `ARCHITECTURE.md` instead.

---

### 10. No React error boundary at the top level

**Location:** `src/App.tsx`

A runtime error in any rendering component crashes the entire app window to a white screen. Electron apps tend to live a long time (session persistence encourages it), so a single bad state is a high-cost failure.

**Fix:** Add a top-level `ErrorBoundary` with a "reload window" fallback. Pipe errors to `sourcemap-symbolication.ts` (already present for main-process errors) so renderer stack traces resolve too.

---

### 11. No UI end-to-end tests

Vitest covers stores, managers, and the daemon. The renderer UI has no Playwright / WebdriverIO / Spectron coverage. Manual regressions around pane layout, modal focus, and keyboard shortcut interactions are observed and documented in the ADR log but can't be caught automatically.

**Fix:** Add a thin Playwright setup for a handful of critical flows (new workspace → new terminal → agent status detected → pane split → pane close). Running against a dev build is fine — don't need packaged.

---

## Low

### 12. Renderer types for IPC return values are under-specified

**Location:** `src/electron.d.ts`

Many `window.electronAPI.*` methods return `Promise<unknown>` or widely-typed objects that the renderer then narrows by hand. This defeats a lot of the value of the preload abstraction.

**Fix:** Generate types from the handler return signatures, or share types between `electron/` and `src/` in a common `types/` directory (requires minor tsconfig path updates).

---

### 13. No ESLint rule for circular imports

**Location:** `eslint.config.js`

The store and electron directories have enough cross-references that a circular import would be easy to miss. ESLint flat config is already set up; adding `eslint-plugin-import` with `import/no-cycle` is a one-line config change.

---

### 14. Postinstall `electron-rebuild` can fail silently

**Location:** `package.json:18`

`postinstall: electron-rebuild` can print a warning and exit non-zero without blocking the install in some pnpm configurations. `node-pty` then loads against the wrong ABI and the first terminal spawn crashes. Reproduction is platform-specific and hard.

**Fix:** Audit `.pnpmrc` and ensure `engine-strict` / `enable-pre-post-scripts` are configured so postinstall failures are loud.

---

### 15. `pnpm package` fails without `.env`

**Location:** `package.json:11`

```
"package": "source .env && vite build && electron-builder"
```

`source .env` errors in zsh/bash if `.env` is missing. Contributors cloning the repo for the first time hit a cryptic shell error. The README notes most contributors only need `pnpm dev`, but the error is still unfriendly.

**Fix:** Wrap in `test -f .env && source .env ; vite build && electron-builder`, or move signing config into a script that errors with a clear message.

---

### 16. Inconsistent ADR slug style in `decisions/`

**Location:** `docs/decisions/`

Slug style varies: some ADRs describe the *feature* (`adr-007-pr-popover`), others the *fix* (`adr-002-fix-fg-process-detection-hang`, `adr-019-fix-task-status-lifecycle`). Both are defensible; mixing them makes the list harder to scan.

**Fix:** Pick a convention in the ADR workflow skill and document it. Not worth renaming existing ADRs.

---

### 17. No rate limiting on GitHub / Linear calls

The GitHub manager spawns `gh` per request; the Linear manager calls GraphQL per request. No queue, no debounce, no backoff. A user scrolling fast through linked issues could in theory burn through rate limits.

**Fix:** Add a shared request queue with a small concurrency cap (e.g. 4) and exponential backoff on 429.

---

### 18. `localStorage` is not cleared on logout/reinstall

**Location:** `src/store/preferences-store.ts` and similar

Sidebar width, collapsed project state, etc. persist in `localStorage`. If a user uninstalls and reinstalls, old UI prefs come back — usually fine, occasionally confusing (e.g. pointing at a project that no longer exists).

**Fix:** Version the localStorage key (`manor:preferences:v2`) and add a migration step on load.

---

## Process / documentation

### 19. `README.md` references distribution steps that assume `.env`

**Location:** `README.md:150`

README tells contributors to `cp .env.example .env` before `pnpm package`. This is fine for release maintainers but most contributors don't need signing and shouldn't be nudged to fill in placeholder Apple credentials. The "most contributors only need `pnpm dev`" caveat is one line below but easy to miss.

**Fix:** Reorder so the `pnpm dev` path is top of the "Getting Started" section and signing is in a separate "Releasing" section far below.

---

### 20. Session-persistence ADR is draft-quality and misfiled — ✅ Resolved via issue #3

Moved to `docs/decisions/adr-126-session-restore/index.md` with a proper ADR number. Status is `Proposed` (confirmed on re-read); content is still draft-quality but that's a separate concern.

---

## Summary table

| # | Severity | Area | One-line fix |
|---|---|---|---|
| 1 | ✅ | Build | Update `pnpm kill` daemon paths |
| 2 | ✅ | Docs | Renumber colliding ADRs |
| 3 | ✅ | Docs | Relocate orphan ADR files |
| 4 | ✅ | Code | Deduplicate `manorDataDir()` |
| 5 | ✅ | Code | Document/unify `~/.manor` vs data dir |
| 6 | Medium | Code | Consistent IPC arg validation |
| 7 | Medium | Code | Split `app-store.ts` |
| 8 | Medium | Security | Use keychain for Linear key |
| 9 | Medium | Docs | Write ADR-107 or remove TODOs |
| 10 | Medium | Code | Add top-level error boundary |
| 11 | Medium | Tests | Add Playwright smoke suite |
| 12 | Low | Types | Type preload return values |
| 13 | Low | Tooling | `import/no-cycle` lint rule |
| 14 | Low | Build | Harden postinstall |
| 15 | Low | Build | Make `.env` optional in `pnpm package` |
| 16 | Low | Docs | ADR slug convention |
| 17 | Low | Code | Rate-limit external APIs |
| 18 | Low | Code | Version localStorage keys |
| 19 | Process | Docs | Reorder README |
| 20 | ✅ | Docs | Fix session-restore ADR placement |
