---
title: Move setup-script PTY to store; add MiniTerminal attach mode
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Move setup-script PTY to store; add MiniTerminal attach mode

Move ownership of the setup-script PTY out of `WorkspaceSetupView` / `MiniTerminal` and into a store-level orchestrator so the PTY's lifetime is no longer coupled to component mount/unmount. Add an `attach` mode to `MiniTerminal` so the view can observe an already-running PTY without spawning or killing it. Centralize the "setup complete" success toast in the orchestrator.

## Goals

1. Setup-script PTY keeps running when `WorkspaceSetupView` unmounts.
2. The existing "Workspace setup complete" success toast fires regardless of whether the view is mounted at the time of completion.
3. `MiniTerminal`'s default behavior (for every other caller) is unchanged.

## Implementation

### 1. Orchestrator: `startSetupScript(wsPath, script)`

Add in `src/store/project-store.ts` (or a small co-located helper module imported by it — your call, keep it simple). Signature:

```ts
function startSetupScript(wsPath: string, script: string): void
```

Responsibilities:

- Generate session ID: `` `setup-${wsPath.replace(/\//g, "-")}` `` — this MUST match what `WorkspaceSetupView` uses today (see src/components/sidebar/WorkspaceSetupView.tsx:144) so attach mode can hook up to the same session.
- Call `window.electronAPI.pty.create(sessionId, wsPath, cols, rows)`. Use reasonable default dimensions (e.g. 80×24). The view will re-fit when/if it mounts — that is xterm's problem, not ours.
- Write the command with exit semantics: `` `${script}; exit\r` ``. Wait for the shell-ready signal the current code uses: subscribe once to `pty.onCwd(sessionId, ...)` (same as useMiniTerminal.ts:124) and send the command on the first CWD event. Fallback: send after a 3s timeout if no CWD event arrives.
- Subscribe to `pty.onExit(sessionId, ...)` at store scope. This subscription outlives any view. On exit:
  1. Dispose the onCwd subscription + clear the fallback timer (if still pending).
  2. `useAppStore.getState().updateWorktreeSetupStep(wsPath, "setup-script", "done")`.
  3. `useAppStore.getState().completeWorktreeSetup(wsPath)`.
  4. Remove the background persistent toast if present (ticket 2 will create it; here just make the removal call — `useToastStore.getState().removeToast(\`worktree-setup-${wsPath}\`)` — unconditional remove is a no-op if absent).
  5. Emit the success toast (moved from `WorkspaceEmptyState.handleSetupComplete`):
     ```ts
     useToastStore.getState().addToast({
       id: `workspace-setup-${Date.now()}`,
       message: "Workspace setup complete",
       status: "success",
     });
     ```
  6. Dispose the onExit subscription itself.
- Do NOT call `clearWorktreeSetup(wsPath)` from the orchestrator. `WorkspaceEmptyState`'s fade-out transition (`handleFadeInEnd`) already clears it when the view is mounted, and if the view is unmounted the next view mount will see `completed: true` and skip the setup phase entirely. Leaving the cleared-on-next-mount semantics intact keeps the fade-out UX identical for the mounted case.

### 2. Wire into `createWorktree`

In `src/store/project-store.ts`, inside `createWorktree`, find the block near line 383-394 that currently handles `startScript`. Today, if there's a start script, it just marks `setup-script` as `pending` and the view spawns the PTY.

New behavior: after marking `setup-script` pending (only needed if `agentCommand` is also present — preserve existing conditional), call `startSetupScript(wsPath, startScript)` whenever `startScript` is truthy. If there is no start script, behavior is unchanged.

The view's auto-transition effect (WorkspaceSetupView.tsx:102-116) will flip the step from `pending` → `in-progress` once the other steps are done. The orchestrator controls the actual process; the view only reflects state.

### 3. MiniTerminal `attach` prop

In `src/components/ui/MiniTerminal.tsx`, add to props:

```ts
/**
 * Attach to an existing PTY session instead of creating a new one.
 * When true: start() skips pty.create; cleanup() skips pty.close.
 * All other setup (xterm open, output/exit subscriptions) still runs so
 * the user sees live output while the view is mounted.
 */
attach?: boolean;
```

Plumb to `useMiniTerminal`.

### 4. `useMiniTerminal` attach behavior

In `src/hooks/useMiniTerminal.ts`:

- Accept `attach?: boolean` in the options.
- In `start()`, wrap the `await window.electronAPI.pty.create(...)` call (line 106) so it is skipped when `attach === true`. Do NOT skip xterm open, FitAddon, or any listener subscription — those are still needed for live output.
- In `cleanup()`, wrap the `window.electronAPI.pty.close(paneIdRef.current)` call (lines 47-50) so it is skipped when `attach === true`. Keep the xterm dispose and subscription cleanup — those are renderer-local and must still run.
- Keep `paneIdRef.current = sessionId` (line 65) so `pty.write` (input forwarding) still targets the right session if interactive is ever set — attach mode here is non-interactive in practice, but keep the code symmetric.

### 5. WorkspaceSetupView: attach, don't spawn

In `src/components/sidebar/WorkspaceSetupView.tsx`, pass `attach` to the `<MiniTerminal>` used for the setup script (around line 167). The orchestrator owns creation/destruction; the view is now a display.

No other behavioral changes to this file in this ticket — the step-transition effect (lines 102-116) and `handleTerminalExit` (lines 131-133) stay as-is. `handleTerminalExit` firing from the view-local `onExit` subscription is fine; it becomes a no-op redundancy with the orchestrator's exit handler because `updateWorktreeSetupStep(wsPath, "setup-script", "done")` is idempotent.

### 6. Remove success toast from WorkspaceEmptyState

In `src/components/sidebar/WorkspaceEmptyState.tsx`, `handleSetupComplete` currently emits the success toast (lines 350-359). Remove the `addToast` call. Keep `setPhase("transitioning")` — the fade-out transition is still driven by the view. The orchestrator now owns toast emission.

## Files to touch

- `src/store/project-store.ts` — add `startSetupScript`; call from `createWorktree`.
- `src/hooks/useMiniTerminal.ts` — add `attach` option; gate `pty.create` and `pty.close` on it.
- `src/components/ui/MiniTerminal.tsx` — plumb `attach` prop.
- `src/components/sidebar/WorkspaceSetupView.tsx` — pass `attach` on the setup-script MiniTerminal.
- `src/components/sidebar/WorkspaceEmptyState.tsx` — remove success-toast emission from `handleSetupComplete`.

## Verification

- Run `bun run typecheck` and `bun run build`.
- Manual smoke (documented for the reviewer, not required in this ticket): create a workspace with a long-running setup script, navigate away mid-script, confirm the PTY keeps running (the process remains in `ps` / no `pty.close` IPC fires). Navigate back — MiniTerminal re-mounts in attach mode and shows live output again (scrollback empty is expected). On completion, success toast fires in both cases.
