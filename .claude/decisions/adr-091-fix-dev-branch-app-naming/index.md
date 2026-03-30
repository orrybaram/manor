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

# ADR-091: Fix dev build branch-based app naming

## Context

We have code in `electron/main.ts` (lines 1270-1278) that sets `app.name` to include the git branch in dev mode, so multiple worktree instances are distinguishable. However, this never visibly worked because on macOS:

- `app.name` only affects the **menu bar** app name
- The **Dock label** is always "Electron" for unpackaged apps (determined by the Electron.app bundle's CFBundleName — cannot be changed at runtime)
- The **Cmd+Tab** app name is also from the bundle
- The **window title** comes from `index.html`'s `<title>Manor</title>` and is never updated

So two worktree instances appear identical everywhere users actually look.

## Decision

Set the `BrowserWindow` title to `Manor (branch)` and handle the `page-title-updated` event to prevent the HTML `<title>` tag from overriding it. This makes the branch visible in:

- Dock tooltips (hover over icon)
- Window list in Cmd+Tab (click and hold on Dock icon, or Cmd+Tab then arrow down)
- Mission Control / Exposé
- Window > menu items

Keep the existing `app.name` change for the menu bar.

Changes:
- `electron/main.ts`: After `createWindow()`, set the window title and add a `page-title-updated` handler to preserve it

## Consequences

- Users can distinguish multiple worktree instances in all macOS window management UIs
- The Dock icon label will still say "Electron" (unavoidable for unpackaged apps), but every other surface shows the branch
- No changes to production behavior (guarded by `!app.isPackaged`)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
