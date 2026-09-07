---
title: Renderer menu dispatch, menu context sync, and UI request bus
status: done
priority: critical
assignee: opus
blocked_by: [3]
---

# Renderer menu dispatch and context sync

Make menu clicks do things, and feed main the context it needs for labels and enabled state. Read `index.md` › Architecture › 6, 7, 8.

## Steps

1. Create `src/utils/ui-request.ts`, generalising `src/utils/palette-request.ts` (leave that file alone):
   ```ts
   export type UiRequest =
     | { type: "rename-workspace"; projectId: string; path: string }
     | { type: "merge-worktree"; projectId: string; path: string }
     | { type: "delete-worktree"; projectId: string; path: string }
     | { type: "remove-project"; projectId: string }
     | { type: "open-notifications" }
     | { type: "pane-search"; paneId: string }
     | { type: "ghosts" };
   export function onUiRequest(listener: (req: UiRequest) => void): () => void;
   export function requestUi(req: UiRequest): void;
   ```
   Subscribers for these are added in tickets 5 and 6; this ticket only emits.
2. Create `src/lib/menu-handlers.ts`:
   ```ts
   export interface MenuChrome {
     openSettings: (page?: SettingsPageId) => void;
     togglePalette: () => void;
     openPaletteView: (view: PaletteView) => void;
     openNewWorkspace: () => void;
     addProject: () => void;
     openFeedback: () => void;
     openAgents: () => void;
     openProjectSettings: (projectId: string) => void;
     resumeAgent: (agentId: string) => void;
     showGhosts: () => void;
   }
   export type MenuHandler = (args?: Record<string, unknown>) => void;
   export function createMenuHandlers(chrome: MenuChrome): Record<string, MenuHandler>;
   export function dispatchMenuCommand(payload: MenuCommandPayload, handlers: Record<string, MenuHandler>): void;
   ```
   `createMenuHandlers` = `createSharedKeybindingHandlers({ prewarmNewAgent: true })` + primary handlers (`settings`, `command-palette`, `toggle-sidebar`, `history-back`, `history-forward`, `new-workspace`; `close-tab` as in `App.tsx:419`) + the menu-only commands. Every handler reads `getState()` like `keybinding-commands.ts` does. Helpers `activeWorkspace()` returning `{ project, workspace, path }` from `useProjectStore` / `useAppStore`, and `focusedPaneId()` (reuse the lookup in `getFocusedBrowserRef`, extract if needed). Menu-only handlers:
   - `add-project` → `chrome.addProject()`; `open-in-editor` → `openInEditor(path)` from `src/lib/editor.ts`; `reveal-in-finder` → `window.electronAPI.shell.showItemInFolder(path)`; `close-window` → `window.close()` (primary) — main routes it; `copy-workspace-path` → clipboard + success toast like `copy-branch`.
   - `find` → `requestUi({ type: "pane-search", paneId })` for the focused pane.
   - `notifications` → `requestUi({ type: "open-notifications" })`; `your-issues` → the same branching `useIssuesShortcut.tsx:102-115` does (Linear when Linear is configured else GitHub; read the hook and mirror it without React) via `chrome.openPaletteView`; `home` → `setActiveWorkspace(HOME_PATH)`; `processes` / `stats` → `chrome.openPaletteView("processes" | "stats")`.
   - `switch-workspace` `{ path }` → `useProjectStore.getState().selectWorkspace(projectId, idx)` (find the project/index by path; fall back to `setActiveWorkspace(path)`). `next-workspace` / `prev-workspace` → build the ordered list `[HOME_PATH, ...visible workspaces of every project in sidebar order]` using `buildSidebarItems` from `src/utils/sidebar-items.ts` (flatten folder members in place), find the active index, step ±1 with wrap, then switch. Put this ordering in an exported pure function `orderedWorkspacePaths(projects)` and unit-test it.
   - `rename-workspace` / `merge-worktree` / `delete-worktree` / `remove-project` → ensure the sidebar is visible (`useProjectStore.getState().sidebarCollapsed`-style flag; read `toggleSidebar` to find the actual field) then `requestUi(...)` with the active project/workspace.
   - `hide-workspace` → extract the hide-and-navigate logic from `Sidebar.tsx:375-385` into `hideWorkspaceAndNavigate(projectId, path)` in `src/store/workspace-actions.ts`, use it from both `Sidebar.tsx` and here.
   - `move-to-folder` `{ folderId }` → `applySidebarChange(projectId, folderId ? placeInFolder(items, path, folderId) : placeAfterFolder(items, path, currentFolderId))` mirroring `ProjectItem.tsx:484-528`.
   - `project-settings` → `chrome.openProjectSettings(projectId)`.
   - `split-with` `{ contentType }` → the `splitWithContent` logic from `useCommands.tsx:91-99` (move that function to `src/lib/pane-actions.ts` as `splitFocusedPaneWith(contentType, paneCommand?)` and have `useCommands` call it); for `agent` compute the command with `resolveWorkspaceCommand`. `convert-to` `{ contentType }` → mirror the `convert-to-*` palette actions (`useCommands.tsx:249-289`); extract similarly as `convertFocusedPaneTo`.
   - `detach-pane` → `movePaneToNewWindow(focusedPaneId)` from `src/lib/window-handoff.ts`; `detach-tab` → `detachTabToNewWindow(activeTabId)` (added in ticket 6; import it now and stub with a `TODO` comment if it does not exist yet — no, ticket 6 depends on this ticket, so add the export in `window-handoff.ts` here with the real implementation moved from `TabBar.tsx:300-320`; ticket 6 then switches `TabBar` to call it).
   - `run-setup-script` → `runWorkspaceSetupScript(path, project.worktreeStartScript)` when set; `view-all-agents` → `chrome.openAgents()`; `focus-agent` `{ agentId }` → `chrome.resumeAgent(agentId)`; `remote-control` → `chrome.openSettings("remote")`; `pin-tab` → `togglePinTab(activeTabId)`.
   - `help-shortcuts` → `chrome.openSettings("keybindings")`; `submit-feedback` → `chrome.openFeedback()`; `ghosts` → `chrome.showGhosts()`.
   - `dispatchMenuCommand` looks up `handlers[payload.commandId]`; unknown ids log `console.warn` once.
3. Create `src/hooks/useMenuContextSync.ts`: `useMenuContextSync()` subscribes (`store.subscribe`) to `useAppStore`, `useProjectStore`, `useAgentStore`, `usePreferencesStore`; derives a `MenuContext` in an exported pure `deriveMenuContext(app, projects, agents, prefs)`; pushes via `window.electronAPI.menu.setContext` when `JSON.stringify` differs from the last push, trailing-debounced 100 ms; pushes once on mount. Derivation notes: `projects[].workspaces` uses `buildSidebarItems` order and excludes hidden; `label` = `ws.name ?? ws.branch`; `agents` = agents whose status is active (read `AgentInfo.status` values in `src/store/agent-store.ts` / `electron/agent-persistence.ts` and pick the "running"/"needs input" ones); `focusedPane.contentType` from `paneContentType[focusedPaneId]` (agent panes: check how the store marks them, else report `terminal`); `activeTab.pinned` from the tab; `panelCount` = `Object.keys(layout.panels).length`; `editorName` = `preferences.defaultEditor || null`; `project.hasSetupScript` = `!!worktreeStartScript`. Unit-test `deriveMenuContext` with fixture state.
4. `src/App.tsx`: build `menuHandlersRef.current = createMenuHandlers({...})` next to `handlersRef` (line ~416) using the existing callbacks (`handleOpenSettings`, `setPaletteOpen`, `handleOpenPaletteView`, `setNewWorkspaceOpen`, `handleAddProject`, `handleOpenFeedback`, `setAgentsOpen`, `handleOpenProjectSettings`, `handleResumeAgent` — it takes an `AgentInfo`; look it up from `useAgentStore` by id, and `showGhosts`: add `const [showGhosts, setShowGhosts] = useState(false)` here now with the same 5 s timeout, render nothing yet — ticket 5 moves the overlay). Replace `handlersRef.current` contents with the keybinding subset of `menuHandlersRef.current` so there is one map (keep `dispatchKeybinding` behaviour identical: it only needs `Record<string, () => void>`; pass `menuHandlers` since extra keys are harmless and handlers ignore `args`). Register `useMountEffect(() => window.electronAPI.menu.onMenuCommand(p => dispatchMenuCommand(p, menuHandlersRef.current)))`. Mount `useMenuContextSync()`.
5. `src/DetachedApp.tsx`: register `onMenuCommand` with `createSharedKeybindingHandlers({ prewarmNewAgent: false })` wrapped by `dispatchMenuCommand`.
6. Tests: `src/lib/__tests__/menu-handlers.test.ts` — `orderedWorkspacePaths` (Home first, folders flattened in place, hidden excluded), `next-workspace` wraps, `dispatchMenuCommand` calls the handler with args and warns on unknown ids, and `createMenuHandlers` covers every id in `MENU_ONLY_COMMANDS` plus every `DEFAULT_KEYBINDINGS` id except `browser-*` and `terminal-search` (assert the key set). `src/hooks/__tests__/useMenuContextSync.test.ts` for `deriveMenuContext`. Follow `src/lib/__tests__/keybinding-commands.test.ts` for store setup.
7. Manual smoke in `pnpm dev`: every menu item does something; Workspace menu greys out on Home; Switch Workspace radio follows the sidebar; Agents lists a running agent and focuses it; rebinding a key updates the menu.
8. Run both `tsc` configs, `npx vitest run src`, `pnpm lint` on touched files.

## Files to touch
- `src/utils/ui-request.ts` — new bus
- `src/lib/menu-handlers.ts` — new handler map + dispatch
- `src/lib/pane-actions.ts` — new, `splitFocusedPaneWith` / `convertFocusedPaneTo` extracted from `useCommands.tsx`
- `src/lib/window-handoff.ts` — add `detachTabToNewWindow(tabId)` (logic from `TabBar.tsx`)
- `src/store/workspace-actions.ts` — add `hideWorkspaceAndNavigate`
- `src/components/sidebar/Sidebar/Sidebar.tsx` — use `hideWorkspaceAndNavigate`
- `src/components/command-palette/useCommands.tsx` — use `pane-actions`
- `src/hooks/useMenuContextSync.ts` — new
- `src/App.tsx` — handlers, `onMenuCommand`, context sync, ghosts state
- `src/DetachedApp.tsx` — `onMenuCommand` with shared handlers
- `src/lib/__tests__/menu-handlers.test.ts`, `src/hooks/__tests__/useMenuContextSync.test.ts` — new
