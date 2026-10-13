---
title: Agent launches and setup scripts spawn on the server
status: in-progress
priority: high
assignee: opus
blocked_by: [3]
---

# Agent launches and setup scripts spawn on the server

ADR-227 D5. This change applies to both platforms, through
`createManorServer`.

## Do
- **Agent launch.**
  - When `layout.apply` adds a new tab with a pending command of kind
    `agent-startup`, the server spawns the session right away. The same goes
    for `startAgentInWorkspace` (`electron/routes/agents.ts:250`).
  - To spawn, call the same `createSession` + `deliverPendingCommand` path
    that `pty.create` uses (`electron/bridge/handlers/pty.ts:226, 314, 403`).
    Factor that path into a server function, `spawnPane(deps, paneId, opts)`.
  - Record the pane's session in `LayoutStore` (`paneSessions`).
  - A renderer mounting the pane later goes through `createOrAttach`, which
    must attach and must not respawn or re-deliver. Add a test for this.
- **Setup scripts.**
  - `workspaceOps.create` (`electron/workspace-ops.ts:116-142`) runs the
    setup script in a new tab whose pending command is `script; exit`,
    spawned with `spawnPane`.
  - Delete:
    - `runSetupScript` in `electron/renderer-bridge.ts:190`;
    - the `run-setup-script` app command handling in `src/App.tsx:556-567`;
    - `startSetupScript` / `runWorkspaceSetupScript` in
      `src/store/project-store.ts:252,336`;
    - the store's own setup run in `createWorktree` (~:1340).
  
  Progress still goes out as `projects.onWorktreeSetupProgress`.
- **Pane context.**
  - Derive `{projectId, projectName, workspacePath}` for a pane on the
    server from `ProjectManager` and `LayoutStore`: the workspace that holds
    the pane and the project that owns that workspace.
  - Use it in the agent pipeline's `getPaneContext`. The renderer's
    `agents.setPaneContext` stays as an override.
  - This replaces the host's `paneContextFrom(manifest, layout, paneId)` for
    any pane that is in its layout.
- **Tests:**
  - spawn-on-apply
  - no double delivery on attach
  - setup script runs with no renderer
  - pane context for a server-spawned pane

## Files to touch
- `electron/bridge/handlers/pty.ts`
- `electron/server/spawn-pane.ts` (new)
- `electron/layout/layout-store.ts`
- `electron/layout/pending-commands.ts`
- `electron/routes/agents.ts`
- `electron/workspace-ops.ts`
- `electron/renderer-bridge.ts`
- `src/App.tsx`
- `src/store/project-store.ts`
- `electron/agent-status/pipeline.ts`
- `electron/server/create-manor-server.ts`
