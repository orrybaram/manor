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

# ADR-170: Native macOS application menu

## Context

Manor's menu bar is Electron boilerplate. `electron/app-lifecycle.ts:423-499` builds four menus: the app menu, the stock `editMenu` role, a View menu of Reload / Force Reload / DevTools / zoom / full screen, and the stock `windowMenu` role. Nothing in it names a Manor concept. Workspaces, panes, panels, tabs, agents, diff, browser, projects, the command palette and the sidebar are reachable only by memorised shortcut or through ⌘K.

Concrete problems:

- **No `Settings… ⌘,` in the app menu.** Every Mac app has it there; `settings` is a keybinding (`src/lib/keybindings.ts`) but not a menu item.
- **Edit is the stock role.** Substitutions, Speech, AutoFill, Paste and Match Style, Delete are word-processor items. Nothing Manor-specific (Find, Copy Branch Name) is there.
- **View is developer chrome.** Reload / Force Reload reload the entire renderer. `Cmd+R` is registered as a menu accelerator for that, while `browser-reload` is also `Cmd+R` in the keybinding registry. The View menu holds none of Manor's actual view surface: sidebar, palette, notifications, navigation history, Home, Processes, Stats.
- **Window is the stock role.** Manor has tabs (Safari puts tab navigation in Window) and detached windows (ADR-156/157). None appear.
- **Discoverability.** macOS indexes every menu item in Help › Search. A full menu makes the whole command surface searchable for free, and greys out what is not applicable so a new user learns the model by looking.
- **Zoom items hard-code `mainWindow`** (`app-lifecycle.ts:459,469,483`), so zooming with a detached window focused zooms the wrong window.

Constraints discovered during research:

- The keybinding registry (`DEFAULT_KEYBINDINGS`, `KeyCombo`, serialize/deserialize) lives in `src/lib/keybindings.ts`, which references `navigator` and `KeyboardEvent`. Main already imports leaf modules from `src/` (`electron/paths.ts` imports `src/lib/home-path.ts`, split out for exactly this reason), so a DOM-free leaf is the established pattern.
- Key dispatch is renderer-side (`dispatchKeybinding` in `src/lib/keybinding-commands.ts`), so the menu must not compete for the same keys. Electron's `registerAccelerator: false` (macOS) shows a shortcut in the menu without registering it with the system. The current template already works around the conflict by dropping Back/Forward from the Window menu; the proper fix is display-only accelerators everywhere the renderer owns the key.
- `KeybindingsManager.onChange` (`electron/keybindings.ts:71`) holds a single callback, already used by `electron/ipc/misc.ts:204` to push changes to the renderer. A menu rebuild on change needs a second listener.
- Main → renderer commands already flow over the `"app-command"` channel (`electron/renderer-bridge.ts`), but that is HTTP-shaped, targets `getAllWindows()[0]`, and its correlated dispatch table (`src/lib/app-commands.ts`) is for MCP tools that validate args and throw. Menu clicks are fire-and-forget UI intents that need a different handler map (the one keybindings use, plus chrome-level actions living in `App.tsx`) and window-aware routing. They get their own channel.
- `src/DetachedApp.tsx` mounts the shared keybinding handlers but registers no `onAppCommand`. Menu commands must therefore be routed in main: window-agnostic commands go to the focused renderer window, everything else to the primary.
- Several menu actions exist only as component-local state: workspace inline rename, the merge/delete/remove-project dialogs (`ProjectItem.tsx`), the notifications popover open state, pane search (`useTerminalHotkeys`, `BrowserPane`, `DiffPane` each listen for ⌘F themselves), the ghosts overlay (`CommandPalette.tsx`), and tab detach (drag-only in `TabBar.tsx`). `src/utils/palette-request.ts` is the precedent for reaching those from outside the tree: a tiny listener bus that `App` (or the owning component) subscribes to.
- Baseline before this work: renderer `tsc` clean; electron `tsc -p tsconfig.electron.json` has 13 pre-existing errors in files this ADR does not touch; `pnpm lint` reports 35 pre-existing problems (some in `preload.ts`, `useCommands.tsx`, `app-store.ts`). Verification gates are "no new errors", not "zero".

## Decision

Replace the inline template with a Manor-specific menu built from one shared registry, with display-only accelerators, clicks routed to the renderer's existing command handlers, and enabled/checked state driven by a compact context the renderer pushes to main.

### Menu specification

`*` marks a command that does not exist yet. Everything else has a handler today. Items in brackets are dynamic.

```
Manor
  About Manor
  Check for Updates…                (packaged builds only)
  ─────
  Settings…                    ⌘,
  ─────
  Services ▸
  ─────
  Hide Manor / Hide Others / Show All
  ─────
  Quit Manor                   ⌘Q

File
  New Agent                    ⌘N
  New Tab                      ⌘T
  New Browser                 ⇧⌘B
  New Workspace…              ⇧⌘N
  Add Project…
  ─────
  Open Diff                   ⇧⌘G
  Open in <Editor>                  (label uses preferences.defaultEditor; disabled when unset)
  Reveal in Finder *
  ─────
  Close Pane                   ⌘W
  Close Tab                   ⇧⌘W
  Close Panel
  Close Window *                    (no accelerator; ⇧⌘W stays Close Tab)
  Reopen Closed Pane          ⇧⌘T

Edit
  Undo / Redo                       (roles)
  ─────
  Cut / Copy / Paste / Select All   (roles)
  ─────
  Find…                        ⌘F   (routed to the focused pane's search) *
  ─────
  Copy Branch Name            ⇧⌘.
  Copy Workspace Path *
                                    (AppKit appends Start Dictation and Emoji & Symbols itself)

View
  Command Palette              ⌘K
  Toggle Sidebar               ⌘\
  Notifications *
  Your Issues
  ─────
  Home                              (checked while on Home)
  Processes
  Stats
  ─────
  Back                        ⌃⌘[
  Forward                     ⌃⌘]
  ─────
  Actual Size                  ⌘0   (registered accelerators, applied to the focused window)
  Zoom In                      ⌘=
  Zoom Out                     ⌘-
  ─────
  Toggle Full Screen                (role)
  ─────
  Developer ▸                       (dev builds only: Reload, Force Reload, Toggle Developer Tools)

Workspace                           (disabled as a group on Home / with no workspace)
  Switch Workspace ▸                [Project › workspaces, radio-checked on active; sidebar order, hidden excluded]
  Next Workspace *            ⌃⌘↓
  Previous Workspace *        ⌃⌘↑
  ─────
  Rename Workspace
  Hide Workspace
  Move to Folder ▸                  [folders of the active project, checked on current; "Remove from Folder" when in one]
  ─────
  Merge Worktree…                   (disabled for the main workspace)
  Delete Worktree…                  (disabled for the main workspace)
  ─────
  Project Settings…
  Remove Project…

Pane                                (disabled as a group with no active workspace)
  Split Horizontal             ⌘D
  Split Vertical              ⇧⌘D
  Split With ▸   Terminal / Browser / Diff / Agent
  Convert To ▸   Terminal / Browser / Diff / Agent   (current type checked)
  ─────
  Next Pane                    ⌘]
  Previous Pane                ⌘[
  ─────
  Split Panel Right           ⌥⌘\
  Split Panel Down           ⇧⌥⌘\
  Next Panel                  ⌥⌘]
  Previous Panel              ⌥⌘[
  Move Tab to Next Panel            (disabled with one panel)
  ─────
  Move Pane to New Window           (ADR-157; disabled with no focused pane)

Agents
  New Agent                    ⌘N
  Run Setup Script                  (disabled when the project has no worktreeStartScript)
  View All Agents…
  ─────
  [active agents: "<name> — <workspace>", click focuses it]   ("No Active Agents", disabled, when empty)
  ─────
  Remote Control…                   (Settings › Remote Control)

Window
  Minimize                     ⌘M   (role)
  Zoom                              (role)
  ─────
  Next Tab                    ⇧⌘]
  Previous Tab                ⇧⌘[
  Pin Tab / Unpin Tab               (label follows the active tab)
  Move Tab to New Window            (ADR-156) *
  ─────
  Bring All to Front                (role)
  ─────
  [window list]                     (AppKit, via role: "window")

Help                                (role: "help" so macOS adds the search field)
  Manor Help                        (opens the GitHub README)
  Keyboard Shortcuts…               (Settings › Keybindings)
  Release Notes                     (opens CHANGELOG on GitHub)
  ─────
  Submit Feedback…
  Report an Issue on GitHub
  ─────
  Reveal Data Folder                (main-side: shell.showItemInFolder(manorDataDir()))
  Toggle Developer Tools            (packaged builds; dev builds have it under View › Developer)
  ─────
  Ghosts!?
```

Every item that corresponds to a keybinding id shows that binding (defaults merged with the user's overrides) and is `registerAccelerator: false`. Rebinding a shortcut in Settings updates the menu live. The three zoom items are the exception: they keep registered accelerators because app zoom is implemented in main and the renderer only intercepts those keys when a browser pane is focused (`dispatchKeybinding` skips `browser-*` matches otherwise).

### Architecture

**1. Shared, DOM-free registry: `src/lib/keybinding-defs.ts`.** Holds `KeyCombo`, `KeybindingCategory`, `KeybindingDef`, `DEFAULT_KEYBINDINGS`, `platformDefaults(platform: string)`, `serializeCombo`, `deserializeCombo`, a new `resolveBindings(overrides, platform)` (defaults merged with serialized overrides, the logic `keybindings-store.ts` does today), and a new `comboToAccelerator(combo, platform)` that emits Electron accelerator strings (`"Cmd+Shift+D"`, `"Ctrl+Cmd+Up"`). `src/lib/keybindings.ts` re-exports all of it and keeps only the `navigator`/`KeyboardEvent` helpers. Two new defs: `next-workspace` (⌃⌘↓) and `prev-workspace` (⌃⌘↑), category `workspace`.

**2. Command catalog and context type: `src/lib/menu-commands.ts`.** DOM-free. `MenuCommandId` (keybinding ids plus the menu-only ids listed in the spec), `SHARED_WINDOW_COMMANDS` (the ids `createSharedKeybindingHandlers` implements, so a detached window can service them), `MenuCommandPayload { commandId, args? }`, and `MenuContext`:

```ts
interface MenuContext {
  activeWorkspacePath: string | null;
  isHome: boolean;
  workspace: { projectId: string; name: string; branch: string; isMain: boolean; folderId: string | null } | null;
  project: { id: string; name: string; hasSetupScript: boolean; folders: { id: string; name: string }[] } | null;
  projects: { id: string; name: string; workspaces: { path: string; label: string }[] }[]; // visible, sidebar order
  agents: { id: string; name: string; workspaceLabel: string | null }[];                    // active only
  focusedPane: { id: string; contentType: "terminal" | "browser" | "diff" | "agent" } | null;
  activeTab: { id: string; pinned: boolean } | null;
  panelCount: number;
  editorName: string | null;
}
```

**3. Pure template builder: `electron/app-menu-template.ts`.** `buildMenuTemplate({ context, bindings, isPackaged, platform }, actions)` returns `MenuItemConstructorOptions[]`. `actions` is an object of callbacks (`send(commandId, args)`, `zoom(delta | "reset")`, `checkForUpdates`, `openExternal(url)`, `revealDataFolder`) so the builder has no Electron imports beyond types and is unit-testable. All enabled/checked/label logic lives here.

**4. Controller: `electron/app-menu.ts`.** `installAppMenu(deps)` builds and sets the menu, then rebuilds (debounced 50 ms) on: keybinding overrides change, context push from the primary renderer, and `browser-window-focus`. Routing: `send(commandId, args)` picks `BrowserWindow.getFocusedWindow()` when it is a tracked renderer window other than the primary **and** `SHARED_WINDOW_COMMANDS` has the id; otherwise the primary. Sends on a new `"menu-command"` channel. `KeybindingsManager.onChange` becomes multi-listener (a `Set`, returns an unsubscribe) so `misc.ts` and the menu coexist.

**5. IPC: `electron/ipc/menu.ts`, preload `menu` namespace.** `menu:setContext` (renderer → main, accepted from the primary window only; validated as an object), `menu-command` (main → renderer, `onMenuCommand(cb)` in preload), and `shell:showItemInFolder` in `misc.ts` for Reveal in Finder.

**6. Renderer dispatch: `src/lib/menu-handlers.ts` + `App.tsx`.** `createMenuHandlers(chrome)` returns `Record<MenuCommandId, (args?) => void>` = shared keybinding handlers + primary-only handlers + menu-only handlers, where `chrome` is the set of `App`-owned callbacks (open settings/page, open palette view, add project, open feedback, open agents modal, resume agent, open project settings, new workspace dialog). `App` subscribes once via `onMenuCommand`; `DetachedApp` subscribes with `createSharedKeybindingHandlers` only.

**7. Context sync: `src/hooks/useMenuContextSync.ts`.** Subscribes to the app, project, agent and preferences stores, derives a `MenuContext`, and pushes it when its JSON changes (trailing debounce, 100 ms). Mounted in `App` only.

**8. UI request bus: `src/utils/ui-request.ts`.** Generalises `palette-request.ts`: `requestUi(event)` / `onUiRequest(listener)` with a discriminated `UiRequest` union (`rename-workspace`, `merge-worktree`, `delete-worktree`, `remove-project`, `open-notifications`, `pane-search`, `ghosts`). Owning components subscribe: `ProjectItem` (rename, merge, delete, remove), `NotificationsPopover` (open), `TerminalPane`/`BrowserPane`/`DiffPane` (search, only when they hold the focused pane), and the ghosts overlay moves from `CommandPalette` to `App` so it works with the palette closed.

**9. Tab detach from the menu.** The drag-detach sequence in `TabBar.tsx` (payload + spawn bounds + `window.detachTab`) is extracted into `detachTabToNewWindow(tabId)` in `src/lib/window-handoff.ts`, next to `movePaneToNewWindow`, and both the drag path and the menu use it.

### Non-goals

- No Windows/Linux menu design. The template is built for macOS; other platforms get the same tree with `Ctrl` accelerators and no app menu, which is acceptable for now.
- No dynamic relabelling of the zoom items when a browser pane is focused.
- No "New Folder…" menu item (needs the sidebar dialog; Move to Folder covers the common case).
- No per-window menu for detached windows; primary-only items simply act on the primary.

## Consequences

**Better**
- Every Manor action is discoverable from the menu bar and searchable via Help › Search, with shortcuts shown next to it and grey-out explaining when it applies.
- One registry drives keybinding dispatch, the Settings › Keybindings page, the command palette hints, and the menu. A rebinding shows up everywhere.
- Renderer keeps owning key dispatch; the menu never steals a key from the terminal or a browser pane.
- The Reload/Force Reload foot-guns leave packaged builds. Zoom applies to the focused window.

**Harder / risks**
- Two processes share `src/lib/keybinding-defs.ts` and `src/lib/menu-commands.ts`. They must stay DOM-free; a stray `window` reference breaks main at startup. Mitigated by the leaf-module convention already used for `home-path.ts` and by importing them from a `.test.ts` that runs in node.
- Menu rebuilds on context change. Rebuilding a template of ~120 items is sub-millisecond, but a rebuild while a menu is open closes it on macOS. The 100 ms renderer debounce plus 50 ms main debounce keeps that rare; context changes driven by typing (none today) would need throttling.
- `registerAccelerator: false` means a menu shortcut only works while a Manor renderer window has key focus, which is always the case for these commands. Roles (copy, paste, minimize, quit) stay registered.
- The `MenuContext` payload is a new coupling point between renderer state and main. It is derived, never authoritative; main only uses it for labels and enabled state.
- Component-local flows now have an external entry point (`ui-request.ts`). If the owning component is unmounted (e.g. sidebar hidden and `ProjectItem` not rendered) the request is dropped silently. Rename/merge/delete from the menu therefore require the sidebar to be visible; the handlers un-hide the sidebar first.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
