---
title: Menu command catalog, MenuContext type, and pure menu template builder with tests
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Menu command catalog and pure template builder

Build the data model the native menu is rendered from, and the pure function that turns it into an Electron template. No Electron runtime wiring in this ticket; that is ticket 3. Read the **Menu specification** and **Architecture** sections of `index.md` first; this ticket implements the tree there exactly.

## Steps

1. Create `src/lib/menu-commands.ts`. **Zero imports except `type` imports from `./keybinding-defs`.** No DOM references (main imports it). Export:
   - `MENU_ONLY_COMMANDS` as a `const` tuple of ids: `add-project`, `open-in-editor`, `reveal-in-finder`, `close-window`, `find`, `copy-workspace-path`, `notifications`, `your-issues`, `home`, `processes`, `stats`, `switch-workspace`, `rename-workspace`, `hide-workspace`, `move-to-folder`, `merge-worktree`, `delete-worktree`, `project-settings`, `remove-project`, `split-with`, `convert-to`, `detach-pane`, `run-setup-script`, `view-all-agents`, `focus-agent`, `remote-control`, `pin-tab`, `detach-tab`, `help-docs`, `help-shortcuts`, `help-release-notes`, `submit-feedback`, `help-report-issue`, `ghosts`.
   - `type MenuCommandId = (typeof DEFAULT_KEYBINDINGS)[number]["id"] | (typeof MENU_ONLY_COMMANDS)[number]` — if the keybinding ids are not literal-typed, fall back to `string` for that half and keep the menu-only half literal.
   - `SHARED_WINDOW_COMMANDS: ReadonlySet<string>` listing every id `createSharedKeybindingHandlers` in `src/lib/keybinding-commands.ts` returns (read the function; include the nine `select-tab-N` ids). Add a test in `src/lib/__tests__/keybinding-commands.test.ts` asserting `new Set(Object.keys(createSharedKeybindingHandlers()))` equals `SHARED_WINDOW_COMMANDS`, so the two cannot drift.
   - `interface MenuCommandPayload { commandId: string; args?: Record<string, unknown> }`.
   - `interface MenuContext` exactly as written in `index.md` › Architecture › 2.
   - `EXTERNAL_LINKS = { docs: "https://github.com/orrybaram/manor#readme", releaseNotes: "https://github.com/orrybaram/manor/blob/main/CHANGELOG.md", newIssue: "https://github.com/orrybaram/manor/issues/new" }`.
2. Create `electron/app-menu-template.ts`. Import only `type { MenuItemConstructorOptions } from "electron"` plus the two shared leaf modules. Export:
   ```ts
   export interface MenuTemplateState {
     context: MenuContext | null;
     bindings: Record<string, KeyCombo>;
     isPackaged: boolean;
     platform: "mac" | "other";
     appName: string;
   }
   export interface MenuActions {
     send: (commandId: string, args?: Record<string, unknown>) => void;
     zoom: (delta: number | "reset") => void;
     checkForUpdates: () => void;
     openExternal: (url: string) => void;
     revealDataFolder: () => void;
   }
   export function buildMenuTemplate(state: MenuTemplateState, actions: MenuActions): MenuItemConstructorOptions[];
   ```
   Implementation rules:
   - A private helper `cmd(id, label, opts?)` returns an item with `click: () => actions.send(id, args)`, `accelerator: bindings[id] ? comboToAccelerator(bindings[id], platform) : undefined`, and `registerAccelerator: false` whenever an accelerator is set. Every keybinding-backed item goes through it.
   - Follow the tree in `index.md` exactly, including separators, submenu nesting, dynamic submenus, and every disabled/checked rule noted in parentheses. Labels use macOS title case and a trailing `…` where the spec shows one.
   - "Open in <Editor>": label `Open in ${editorName}` when set, otherwise `Open in Editor` disabled.
   - Workspace menu: the items from Rename Workspace down are `enabled: !!context?.workspace && !context.isHome`. Switch Workspace submenu lists `context.projects` as nested submenus (project → workspace items, `type: "radio"`, `checked` when path equals `activeWorkspacePath`, click sends `switch-workspace` with `{ path }`); with no projects it is a single disabled "No Workspaces" item. Move to Folder submenu: one `checkbox` item per `context.project.folders` (checked when `workspace.folderId` matches, click sends `move-to-folder` `{ folderId }`), then a separator and "Remove from Folder" (enabled only when `workspace.folderId` is set, sends `move-to-folder` `{ folderId: null }`). Merge/Delete Worktree disabled when `workspace.isMain`.
   - Pane menu: enabled as a group when `activeWorkspacePath` is set. Split With / Convert To submenus send `split-with` / `convert-to` with `{ contentType }`; Convert To items are `type: "radio"` checked on `focusedPane.contentType`; Convert To is disabled with no focused pane. Move Tab to Next Panel disabled when `panelCount < 2`. Move Pane to New Window disabled with no focused pane.
   - Agents menu: the dynamic block lists `context.agents` as `${name} — ${workspaceLabel ?? "Home"}` sending `focus-agent` `{ agentId }`; empty → disabled "No Active Agents". Run Setup Script enabled only when `project?.hasSetupScript`.
   - Window menu: Pin Tab label is `Unpin Tab` when `activeTab?.pinned`; both Pin and Move Tab to New Window disabled with no active tab. Use `{ role: "minimize" }`, `{ role: "zoom" }`, `{ role: "front" }`, and give the top-level item `role: "window"` so AppKit appends the window list.
   - View › zoom items: `accelerator` `CmdOrCtrl+0` / `CmdOrCtrl+=` / `CmdOrCtrl+-` **registered** (no `registerAccelerator: false`), clicks call `actions.zoom("reset" | 0.1 | -0.1)`. Developer submenu only when `!isPackaged`, containing `{ role: "reload" }`, `{ role: "forceReload" }`, `{ role: "toggleDevTools" }`. Full screen is `{ role: "togglefullscreen" }`.
   - Help: top-level `role: "help"`. Manor Help / Release Notes / Report an Issue call `actions.openExternal` with `EXTERNAL_LINKS`. Keyboard Shortcuts… sends `help-shortcuts`. Reveal Data Folder calls `actions.revealDataFolder`. Toggle Developer Tools `{ role: "toggleDevTools" }` only when `isPackaged`.
   - App menu: on `platform === "mac"` only; `role: "about"`, Check for Updates… when `isPackaged` (click `actions.checkForUpdates`), Settings… via `cmd("settings", "Settings…")`, then `services`, `hide`, `hideOthers`, `unhide`, `quit` roles with separators as in the spec. On other platforms omit the app menu and put Settings… at the bottom of File and Quit after it.
   - Close Window: `click: () => actions.send("close-window")`, no accelerator.
3. Tests in `electron/app-menu-template.test.ts` (import the builder directly; it has no runtime Electron dependency). Build a fixture context and default bindings via `resolveBindings({}, "MacIntel")`. Assert at least:
   - Top-level labels in order: `Manor, File, Edit, View, Workspace, Pane, Agents, Window, Help`.
   - Settings… lives in the app menu with accelerator `Cmd+,` and `registerAccelerator === false`.
   - New Agent in File shows `Cmd+N`; after `resolveBindings({ "new-agent": "meta+shift+a" }, "MacIntel")` it shows `Cmd+Shift+A`.
   - With `context: null` or `isHome: true`, Rename Workspace is disabled; with a non-main workspace it is enabled; with `isMain: true`, Merge Worktree is disabled.
   - Switch Workspace lists projects and radio-checks the active path; clicking a workspace item calls `send("switch-workspace", { path })` (invoke `click` with a stub `send`).
   - Pin Tab label flips to Unpin Tab when the active tab is pinned.
   - Developer submenu present when `isPackaged: false`, absent when `true`; Check for Updates… the reverse.
   - The zoom items have registered accelerators (no `registerAccelerator: false`) and every `cmd()` item with an accelerator has it set to `false`. Walk the whole tree for that invariant.
4. Run renderer and electron `tsc` (see gates in ticket 1), `npx vitest run electron/app-menu-template.test.ts src/lib`, and `pnpm lint` on touched files.

## Files to touch
- `src/lib/menu-commands.ts` — new
- `electron/app-menu-template.ts` — new
- `electron/app-menu-template.test.ts` — new
- `src/lib/__tests__/keybinding-commands.test.ts` — add the drift test
