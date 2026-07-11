---
title: Orchestrator pseudo-workspace + pinned sidebar entry + auto-launch/resume
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Orchestrator pseudo-workspace + pinned sidebar entry + auto-launch/resume

The user-facing surface: a pinned, always-present top-level "Orchestrator" entry
that opens a persistent agent session scoped above all projects. Depends on
ticket 1 (harness command + adapter). Renderer-only; does not require the MCP
tools to exist to render.

## What to build

1. **Sentinel workspace** — a constant `ORCHESTRATOR_PATH` (e.g.
   `"__orchestrator__"`) in a shared renderer module (e.g. `src/lib/harness.ts`
   or a new `src/lib/orchestrator.ts`). Its real cwd is `~/.manor/orchestrator`
   (create the dir on first launch); the sentinel is what keys the layout.
   Layout keying already accepts opaque strings (`app-store.ts`
   `workspaceLayouts: Record<string,…>`), so `setActiveWorkspace(ORCHESTRATOR_PATH)`
   works without a project.

2. **Pinned sidebar row** — `src/components/sidebar/Sidebar/Sidebar.tsx`: insert a
   single clickable row in `.content` **above** the "Projects" `ContextMenu.Root`
   header (~line 229), outside `projects.map` so it's exempt from drag/reorder.
   Mirror the existing home/`isMain` "local" visual language from
   `ProjectItem.tsx` (house-style icon + fixed label "Orchestrator"). Show an
   active/indicator state when `activeWorkspacePath === ORCHESTRATOR_PATH`.
   Clicking calls `setActiveWorkspace(ORCHESTRATOR_PATH)`. Use `ui/` components.

3. **Global agentCommand resolution for the sentinel.** Every
   `project?.agentCommand ?? DEFAULT_AGENT_COMMAND` fallback that can run for the
   sentinel path must instead use the resolved orchestrator harness command
   (`resolveOrchestratorAdapter(prefs).launchCommand()` from ticket 1) when
   `workspacePath === ORCHESTRATOR_PATH`. Sites:
   - `src/App.tsx` `handleNewTask` (~520-533), `handleNewTaskWithPrompt`
     (~536-561), and the prewarm command (~270).
   - `src/hooks/useTerminalLifecycle.ts` agentCommand/agentKind resolution
     (~226-234) and `tasks.setPaneContext` (~257-262).
   Ensure `projects.find(p => p.workspaces.some(w => w.path === activeWorkspacePath))`
   sites (App.tsx ~523/539, useTerminalLifecycle ~229) tolerate `undefined` for
   the sentinel and take the orchestrator branch.

4. **Auto-launch on first open.** When the orchestrator surface is opened and has
   no tabs, create a tab and seed `pendingStartupCommand[ORCHESTRATOR_PATH]` with
   the harness launch command, and seed the **primer** (ticket 5) as the first
   prompt injected after launch. Reuse `setPendingStartupCommand` /
   `addTab` exactly as `handleNewTaskWithPrompt` does.

5. **Resume on relaunch.** The sentinel persists in `layout.json` like any
   workspace (`flushLayoutSave` persists the active workspace; the orchestrator is
   saved whenever active). On boot (`App.tsx` mount effect ~48-63), after
   `loadPersistedLayout()`, if the orchestrator layout exists, restore it via the
   normal `_cachedLayout` path; re-launch the harness through the existing
   pending-command / `useTerminalLifecycle.ts:301` auto-resume machinery. Do NOT
   auto-*activate* it over the user's last project unless it was the active
   surface at quit.

## Files to touch
- `src/lib/orchestrator.ts` (or `src/lib/harness.ts`) — `ORCHESTRATOR_PATH` const + cwd helper.
- `src/components/sidebar/Sidebar/Sidebar.tsx` — pinned row above Projects (~227-229).
- `src/App.tsx` — sentinel-aware agentCommand resolution + auto-launch (~270, ~520-561, mount ~48-63).
- `src/hooks/useTerminalLifecycle.ts` — sentinel-aware agentCommand/agentKind/pane-context (~226-262, ~301-320).
- (styles) sidebar CSS module for the pinned row.
