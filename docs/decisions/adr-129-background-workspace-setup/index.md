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

# ADR-129: Background Workspace Setup

## Context

Creating a new workspace runs a multi-step setup flow rendered by `WorkspaceSetupView`:

1. Main-process git ops — prune, fetch, create-worktree, persist (synchronous inside the `projects:createWorktree` IPC).
2. UI switch to new workspace.
3. Optional `setup-script` phase — runs the project's configured start script inside a `<MiniTerminal>` PTY that is mounted as a child of `WorkspaceSetupView`.

If the user navigates away from the workspace setup view (e.g. clicks another workspace in the sidebar) while the setup-script is still running, `WorkspaceSetupView` unmounts. That cascades: `MiniTerminal` unmounts, `useMiniTerminal` cleanup fires, cleanup calls `window.electronAPI.pty.close(paneId)` (src/hooks/useMiniTerminal.ts:48), and the PTY — along with the running setup script — is killed.

The main-process git ops themselves are unaffected (they run to completion in the main process regardless of view lifecycle). Only the setup-script phase dies, because the renderer-owned MiniTerminal is what spawns and owns the PTY.

The user has asked for a fix where:
1. The setup script keeps running in the background when the view unmounts.
2. A persistent toast appears showing that setup is still in progress.
3. When setup finishes, the persistent toast is dismissed and the existing "Workspace setup complete" success toast fires.

## Decision

Move PTY ownership for the setup-script phase out of `MiniTerminal` and into a store-level orchestrator, so the PTY's lifetime is decoupled from the component tree. `MiniTerminal` gains an "attach" mode that lets it observe an already-running PTY without creating or killing it. When the setup view unmounts while the script is still running, a persistent toast is shown; completion hooks on the orchestrator dismiss that toast and emit the existing success toast.

### Architecture

**Orchestrator (store-level setup-script runner)**

Add a function `startSetupScript(wsPath, script)` owned by the renderer store layer (co-located with `createWorktree` in `project-store.ts`, or a new helper module imported by it). It is responsible for:

- Generating a stable session ID: `setup-${wsPath.replace(/\//g, "-")}` (matches the ID `WorkspaceSetupView` already uses).
- Calling `window.electronAPI.pty.create(sessionId, wsPath, cols, rows)` with reasonable default dimensions.
- Writing the command: `${script}; exit\r` (same `exitOnComplete` semantics the current view uses).
- Subscribing to `pty.onExit(sessionId, ...)` at store scope — unaffected by any view unmount — and on exit:
  - `updateWorktreeSetupStep(wsPath, "setup-script", "done")`.
  - `completeWorktreeSetup(wsPath)` if not already completed.
  - Remove the background persistent toast if present (see below) and emit the existing "Workspace setup complete" success toast.
  - `clearWorktreeSetup(wsPath)` after the view has had a chance to transition out (preserve existing fade-out UX when the view is mounted).

`createWorktree` in `project-store.ts` calls `startSetupScript` at the point where it currently marks the setup-script step "pending" (line ~388). The view no longer spawns the PTY.

**MiniTerminal attach mode**

Add an `attach?: boolean` prop to `MiniTerminal` / `useMiniTerminal`. When true:

- `start()` skips `pty.create` — the PTY is assumed to already exist (same `sessionId`). All other setup (xterm creation, fit, output/exit listeners) still runs so the user sees live output when the view is mounted.
- `cleanup()` skips `pty.close` — the PTY continues running after unmount. xterm's `dispose()` and subscription cleanup still run to prevent memory leaks.

`WorkspaceSetupView` sets `attach` on the MiniTerminal used for the setup-script phase. Scrollback lost on re-mount is acceptable for this phase — the persistent toast is the source of truth for "is setup still running" while the view is unmounted.

**Persistent background toast**

When `WorkspaceSetupView` unmounts while `!fading` and the setup-script step is still in-progress, emit:

```ts
{
  id: `worktree-setup-${wsPath}`,
  message: `Setting up "${wsName}"…`,
  status: "loading",
  persistent: true,
}
```

On orchestrator completion, the toast is removed and the existing success toast (currently fired by `handleSetupComplete` in `WorkspaceEmptyState`) is emitted from the orchestrator instead — so it fires regardless of whether the view is mounted. If the user navigates back to the setup view before completion, the persistent toast is cleared on mount.

If the setup-script exits with an error (pty reports nonzero exit if the API surfaces it; otherwise preserve existing "always mark done" behavior as a follow-up), the toast transitions to `status: "error"`.

### Files to change

- `src/store/project-store.ts` — add `startSetupScript` orchestrator; call it from `createWorktree` when the setup-script step exists.
- `src/hooks/useMiniTerminal.ts` — add `attach` handling in `start` and `cleanup`.
- `src/components/ui/MiniTerminal.tsx` — plumb `attach` prop through.
- `src/components/sidebar/WorkspaceSetupView.tsx` — pass `attach` on the setup MiniTerminal; emit persistent toast on unmount-while-running; clear toast on mount.
- `src/components/sidebar/WorkspaceEmptyState.tsx` — remove success-toast emission from `handleSetupComplete` (moved to orchestrator); preserve fade-out transition logic.

## Consequences

**Better**
- Setup scripts survive UI navigation — users can start setup and move on.
- Clear signal (toast) that background work is happening.
- Unified completion path in the orchestrator: one place decides "setup is done," emits success toast, and clears state — view is decoration.

**Tradeoffs**
- On re-mount, xterm scrollback is empty for the setup-script terminal (we do not buffer output in the main process). The toast covers the "is it still running" question; detailed output is only available if the user stays on the view. Acceptable for setup scripts, which are typically short; a follow-up ADR can add main-process ring-buffer scrollback if users want it.
- `MiniTerminal` now has two lifecycle modes. Attach mode is opt-in and narrowly scoped to the setup flow; other callers are unaffected.
- Success-toast emission moves from the view to the store. `handleSetupComplete` still runs for the fade-out transition, but the toast fires even when the view is unmounted.

**Risks**
- If `pty.create` is re-invoked with an already-existing session ID (e.g. the view mounts in attach mode before the orchestrator has called create), the behavior depends on the main-process PTY handler. Attach mode skips `pty.create`, so as long as the orchestrator runs first (it does — `createWorktree` kicks it off before the view advances the setup-script step), this is safe.
- Setup-script exit with nonzero code is currently treated the same as success (step marked "done"). We preserve that behavior in the orchestrator to keep this ADR scoped; tracking non-zero exit / error UX is a follow-up.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
