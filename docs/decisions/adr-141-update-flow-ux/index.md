---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-141: Surface Update Flow to User

## Context

ADR-010 added `electron-updater`, IPC bridge, preload events, GitHub publish config, and a `ticket-4-renderer-toast` marked `done`. In practice the renderer side is silent: a grep across `src/` finds zero consumers of `window.electron.updater`. Users running Manor get an automatic background download but receive no UI feedback that an update exists, has downloaded, or is waiting to install. The `autoInstallOnAppQuit = true` flag means updates eventually land on next clean quit, but for a long-running terminal app that's effectively never.

The plumbing is correct; only the UX layer is missing. The grilling pass settled the product decisions:

- **Q1/Q2/Q13**: One sticky toast on `update-downloaded`. No badge, no `update-available` toast, no auto-dismiss.
- **Q3**: Toast actions are "Restart now" + "Later". Re-fires next launch if dismissed (electron-updater re-emits `update-downloaded` against the cached artifact).
- **Q4/Q10**: Manual trigger from native menu *and* AboutModal. AboutModal also shows current version, last-checked, and a pending-update row.
- **Q5/Q8**: Toast trio ("Checking…" → "Up to date" / found / "Couldn't check") fires only on user-initiated checks. Auto-checks stay silent except on download-complete.
- **Q6/Q9**: No new preferences, stable channel only, defaults preserved.
- **Q7**: Recheck every 4h after the initial 5s check.
- **Q11**: `lastChecked` timestamp is in-memory only — `null` until first check, no persistence.
- **Q12**: All update UI is hidden when `!app.isPackaged`.

Two repo facts shape the decision:

1. The toast component (`src/components/ui/Toast/ToastItem.tsx`) supports `persistent` and a single `action`, but has no secondary action or dismiss control. A persistent toast cannot currently be dismissed by the user. The "Later" affordance from Q3 forces an extension.
2. `app.isPackaged` is not currently bridged to the renderer. Q12 needs a reliable signal so dev builds hide all update UI.

## Decision

Six tickets, sequential. Each builds on the previous commit on `main`.

### 1. Backend updater enhancements (`electron/updater.ts`, preload, IPC, types)

Forward two missing events (`checking-for-update`, `update-not-available`) so the renderer can show "Checking…" and "Up to date" states. Add a 4-hour `setInterval` after the initial 5s check. Tag manual-check requests so the renderer knows to fire the trio only when triggered by the user (track `lastTriggerWasManual: boolean` in the main process; emit it as part of the `checking-for-update` payload, or use a dedicated channel `updater:manual-check-started`). Skip all updater wiring when `!app.isPackaged`. Expose `app.isPackaged` to the renderer via a synchronous preload constant (`window.electronAPI.env.isPackaged`) — synchronous because the renderer needs it to conditionally render at first paint.

### 2. Toast secondary action + dismiss control

Extend `Toast` schema with `secondaryAction?: { label, onClick }`. ToastItem renders both buttons when present. For `persistent: true` toasts, render an `X` close affordance that calls `removeToast`. This is a small-scope toast component change that future toasts will reuse — not a feature flag.

### 3. Updater store (`src/store/updater-store.ts`)

New zustand store, in-memory only. Shape: `{ pending: UpdateInfo | null, lastChecked: number | null, checking: boolean, lastTriggerWasManual: boolean, error: string | null }`. Subscribes to `window.electronAPI.updater.on*` events at module init (idempotent). Exposes `triggerManualCheck()` which sets `lastTriggerWasManual = true` and calls `checkForUpdates`. The store is the single source of truth shared by AboutModal and the toast hook.

### 4. AboutModal additions (`src/components/statusbar/AboutModal/AboutModal.tsx`)

When `window.electronAPI.env.isPackaged`, append below the existing version line and above the "Inspired by" divider:
- "Check for Updates" `<Button>` — disabled while `checking`, calls `updaterStore.triggerManualCheck()`.
- Subtitle: "Last checked: {relative time}" or "Last checked: never".
- When `pending` is set, an inline row: "Manor {version} ready" + small "Restart" `<Button>` calling `quitAndInstall`.

When `!app.isPackaged`, render exactly the current modal contents (no additions).

### 5. Toast wiring (`src/hooks/useUpdaterToasts.ts` mounted in `App.tsx`)

A subscription hook that watches the updater store and emits/updates toasts:
- On `pending` set → sticky toast "Manor {v} ready to install" with primary "Restart now" (`quitAndInstall`) and secondary "Later" (`removeToast`). Toast id: `updater-pending` (deduplicated by store).
- On `checking && lastTriggerWasManual` → loading toast "Checking for updates…" with id `updater-checking`.
- On manual check resolves to "no update" → success toast "You're on the latest version" replacing `updater-checking`.
- On error && `lastTriggerWasManual` → error toast "Couldn't check for updates" with full error in `detail`, replacing `updater-checking`.
- Auto-check transitions never produce checking/up-to-date/error toasts. Only `pending` produces output for auto-checks.

### 6. Native menu — explicit appMenu submenu (`electron/app-lifecycle.ts`)

Replace `{ role: "appMenu" }` with a hand-built submenu mirroring macOS defaults (`role: "about"`, `role: "services"`, `role: "hide"`, `role: "hideOthers"`, `role: "unhide"`, `role: "quit"`) plus a "Check for Updates…" item between About and Services that calls the same `checkForUpdates()` from `electron/updater.ts`. The menu item is omitted entirely when `!app.isPackaged`.

## Consequences

**Better**
- Users on long-running sessions actually learn about updates instead of silently running stale builds.
- Update flow becomes discoverable through three orthogonal surfaces (auto toast, AboutModal, native menu) — each Mac user finds it through their own habit.
- Toast component gains a reusable secondary-action + dismiss pattern other features can adopt.
- Single store backs all UI so state stays consistent across surfaces.

**Tradeoffs**
- Hand-built appMenu submenu must be maintained against macOS conventions. If Apple adds a new default item, we won't get it for free.
- 4-hour `setInterval` runs forever in long sessions (negligible cost — one HTTPS GET).
- In-memory `lastChecked` (Q11) means "Last checked: never" appears every launch until either auto-check (5s) or manual check fires. Acceptable per the grilling.

**Risks**
- Toast component changes touch a shared primitive. Need to verify no existing toast caller breaks (no caller currently sets `secondaryAction` so additive).
- Code-signing requirement for production updates is unchanged from ADR-010 — verifying the full flow end-to-end requires a signed build (not testable in dev).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
