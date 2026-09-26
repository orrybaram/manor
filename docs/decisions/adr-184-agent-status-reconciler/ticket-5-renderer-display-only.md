---
title: Renderer displays published status + reason; drop complete
status: todo
priority: high
assignee: sonnet
blocked_by: [4]
---

# Renderer displays published status + reason; drop complete

Read `index.md` and `/CONTEXT.md`.

1. The renderer subscribes to the `agent-status` channel and stores
   `{ status, reason, kind }` per pane. This replaces the `pty-agent-status-*` listener that
   feeds `paneAgentStatus`: rename the map or reshape it as needed, and follow the pane
   lifecycle cleanup.
2. Delete `useAgentDisplay.deriveStatus` and its `lastAgentStatus` fallback, the static
   lifecycle map, and `useDebouncedAgentStatus`. Callers read the published status
   directly. Keep `pickBestPaneStatus` and the tab/workspace/project aggregation hooks,
   since they summarise panes.
3. Remove `"complete"` from `AgentStatus` everywhere. Unify the three declarations into
   one shared type (`src/electron.d.ts`), with `electron/terminal-host/types.ts` and the
   reconciler importing or mirroring it. The `electron.d.ts` copy currently lacks `"pi"`
   in `AgentKind`; fix that.
   Also update `AgentDot`, `workspace-indicator.ts`, `src/lib/harness.ts` and the remote
   client, `src/remote-client/main.ts`.
4. `AgentDot` shows the published `reason` as its tooltip. The agents list shows a
   `completed` lifecycle as a small lifecycle badge rather than a status dot. Use the
   existing UI components (`.claude/rules/ui-components.md`).
5. Tests: update the renderer tests that assert `complete`, and add a test that the
   tooltip shows the reason.

Checks: tsc over the 3 configs, eslint, and targeted vitest (`src/`).

## Files to touch
- `src/store/app-store.ts` (the pane status map and listener), `src/hooks/useAgentDisplay.ts`, `useDebouncedAgentStatus.ts` (delete), `useTabAgentStatus.ts`, `useWorkspaceAgentStatus.ts`, `useProjectAgentStatus.ts`, `useMenuContextSync.ts`
- `src/components/ui/AgentDot/AgentDot.tsx`, `src/lib/workspace-indicator.ts`, `src/lib/harness.ts`, `src/remote-client/main.ts`, the agents list component, `src/components/command-palette/useAgentCommands.tsx`, `src/components/sidebar/WorkspaceIndicatorDot.tsx`, `src/store/agent-store.ts`
- `src/electron.d.ts`, `electron/preload.ts` (remove the old channel), `electron/terminal-host/types.ts`
- related tests
