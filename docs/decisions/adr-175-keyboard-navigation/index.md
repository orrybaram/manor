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

# ADR-175: The whole app works from the keyboard

Extends ADR-172 (sidebar keyboard rename and focus) and ADR-074 (webview
shortcut forwarding).

## Context

An audit (a runtime Tab walk of the built app plus a code review) found that
Manor can't be used without a mouse. The main gaps:

1. **Once focus is in a terminal, you can't leave it.** xterm keeps Tab and
   Escape for the shell. No shortcut moves focus to the sidebar, the tab bar
   or the status bar, and there's no F6-style region cycling. Every dialog
   hands focus back to `.xterm-helper-textarea` when it closes. The only way
   into the sidebar is a click.
2. **Many things can't take focus.** This includes project headers
   (`ProjectItem.tsx:765`), the Home row (`Sidebar.tsx:286`), tabs and their
   close and mute controls (`TabButton.tsx:107/137/157`), the ports panel
   (`PortsList.tsx:62`, `PortGroup.tsx:32`, `PortBadge.tsx:51`), the PR badge
   trigger (`PrPopover.tsx:133`, which opens on hover only), and the
   Processes view buttons (`tabIndex={-1}`).
3. **A focused workspace row can't be opened.** Enter renames it
   (`sidebar-row.ts:59`).
4. **Right-click-only actions.** Tab close-others and duplicate, folder
   delete, unhide workspaces, kill port, and more live only in Radix
   `ContextMenu`s. Those open only on a `contextmenu` event, which macOS
   never produces from the keyboard.
5. **Shortcuts don't work everywhere.**
   - Inside a browser page only a hard-coded set of keys gets through
     (`electron/ipc/webview.ts:396`).
   - Popout windows ignore settings, the palette and workspace commands
     (`DetachedApp.tsx:139`).
   - An open inline rename input stops propagation of *every* key, so app
     shortcuts are blocked while renaming.
   - With a modal open, ⌘T and ⌘W still change the workspace behind it.
6. **You often can't see where focus is.** Sidebar rows have no focus ring
   (it was removed on purpose). There are 25 `outline: none` rules and only 3
   `:focus-visible` rules. Several icon-only buttons have no accessible name.

The e2e harness also had a machine-specific failure. `pathWithoutAgents`
dropped any PATH directory that contained `claude` or `codex`, and
`/opt/homebrew/bin` holds `codex`. The app then fell back to `/usr/bin/git`,
which fails on a machine that hasn't accepted the Xcode licence, so every
workspace-creating spec failed. This is fixed in `tests/e2e/fixtures.ts` by
linking the rest of a dropped directory's binaries into a shim directory
that takes its place in PATH.

## Decision

### Regions

`src/lib/focus-regions.ts` defines the regions `sidebar`, `tabbar`, `pane`
and `statusbar`. Each region's root element carries a
`data-focus-region="<name>"` attribute.

- **F6 / Shift+F6** cycle through the visible regions. The target inside each
  region is:
  - sidebar: the active row;
  - tab bar: the active tab;
  - pane: `refocusActivePane()`;
  - status bar: its first focusable element.
- **Two new bindable commands:**
  - `focus-sidebar`, default ⌘⇧E. It opens the sidebar if hidden and focuses
    the active row.
  - `focus-tabbar`, default ⌘⇧Y.

  Both are also in the command palette.
- **The dispatcher accepts function keys without a modifier.** Today
  `dispatchKeybinding` ignores any key pressed without one.
- **The terminal passes F6 through.** `useTerminalHotkeys` already does this
  for bound combos.
- **Generalised focus exemption.** `useTerminalLifecycle` keeps its "don't
  steal focus" check but widens it from `isSidebarRowFocused()` to
  `isNavRegionFocused()`: focus is inside any region other than `pane`.

### Sidebar

- **Every row takes focus:** the Home row, project headers, workspace rows
  and folder headers all carry `data-sidebar-row`.
- **Roving tabindex:** the sidebar is a single Tab stop. The active workspace
  row holds `tabIndex=0`.
- **Key map:**

  | Key | Action |
  |---|---|
  | Enter / Space | Open the workspace or Home. On a project header or folder header, toggle it. |
  | F2 | Rename |
  | ← / → | Collapse or expand a project header or folder header |
  | Home / End | First or last row |
  | ↑ / ↓ | Move between rows (unchanged) |
  | Escape | Return focus to the pane (unchanged) |

- **Rename inputs** stop propagation only for keys pressed without ⌘ or Ctrl,
  so app shortcuts still work while renaming.
- **Focus ring:** a `:focus-visible` ring comes back for keyboard focus only.
  A click doesn't show it, which keeps the ADR-172 follow-up intact.

### Tab bar

- The tab bar becomes `role="tablist"` and each tab `role="tab"`, with a
  roving tabindex.
- ← / → move focus between tabs, Home / End jump to the ends, and
  Enter / Space select the focused tab.
- The close control becomes a focusable `Button` with an `aria-label`.
- The "+" button gets `aria-label="New tab"`. Its Browser/Agent menu opens
  with Shift+F10.

### Context menus from the keyboard

`src/lib/keyboard-context-menu.ts` exports `openContextMenuFromKeyboard(el)`.
It dispatches a synthetic `contextmenu` MouseEvent at the element's
bottom-left corner. Radix then opens the menu, focuses it, and arrow keys
work inside it.

- **Trigger keys:** Shift+F10, the ContextMenu key and ⌘. open the menu. This
  applies to sidebar rows, tabs, sidebar agent rows and port badges.
- **Focus on close:** focus goes back to the trigger through
  `onCloseAutoFocus`.

### Dialogs and shortcut scope

- **Focus restore.** Dialogs (settings, palette, agents, new workspace)
  remember `document.activeElement` when they open and give focus back to it
  when they close. If that element has been removed from the page, they fall
  back to `refocusActivePane()`.
- **Shortcuts behind a modal.** While any modal Radix dialog is open, the
  dispatcher runs only the `command-palette` and `settings` toggles, and only
  when the open dialog is their own. Everything else is left to the dialog.
- **Focus styles.** `ui/Button` gets a `:focus-visible` style, plus a global
  `:focus-visible` fallback in `App.css`.
- **Labels.** Icon-only buttons get `aria-label`s.

### Shortcuts in every window and surface

- **Browser pages:** the webview `before-input-event` handler forwards any
  combo registered in the keybinding map, not just the fixed set, plus F6. It
  keeps the browser's own ⌘[ / ⌘] / ⌘L / ⌘R / ⌘F while a page has focus.
- **Popout windows:** commands only the main window can run (settings,
  palette, new/next/prev workspace, focus-sidebar) are forwarded there over
  IPC, and the main window is focused.

### Secondary surfaces

These gain focusable elements with Enter/Space handlers:

- the ports header, groups and badges;
- the PR badge trigger, which also opens on focus and on Enter;
- the Processes view buttons (drop `tabIndex={-1}`, and give `onSelect` a
  real action);
- the project theme picker rows;
- the welcome "Open Project" drop zone;
- toast expand.

The keybinding recorder:

- Escape cancels.
- Tab is not captured.
- A combo is saved on keyup of its non-modifier key.
- Focus comes back to the row's button when recording ends.

### Tests first

`tests/e2e/keyboard-navigation.spec.ts` is written before the fixes. Every
interaction in it uses `keyboard.press` only; `click()` is not allowed. It
also has a sweep that fails if the main window or Settings contains any
visible element with `cursor: pointer` that can't take focus and isn't
inside something that can. The suite is red until the tickets below land.

### Out of scope

Recorded here so nobody assumes they're covered:

- keyboard resizing of splits and the sidebar;
- keyboard reordering of projects, workspaces and tabs;
- file-row selection in the diff pane;
- ARIA tree semantics for the sidebar. It uses a roving tabindex without
  `role="tree"`, since Radix context menus and inline inputs complicate
  tree semantics.

## Consequences

**Gains**
- Every region, and every action that was right-click-only, can be reached
  without a pointer.
- The e2e suite guards against regressions, and the pointer-only sweep
  catches new clickable `div`s automatically.

**Costs and risks**
- **Enter no longer renames a workspace row; F2 does.** This changes ADR-172,
  and `workspace-rename.spec.ts` must be updated.
- **Blocking shortcuts behind modals** changes behaviour for anyone who used
  ⌘T with Settings open.
- **Synthetic `contextmenu` events** depend on Radix reading `clientX` and
  `clientY` from the event. A Radix upgrade that changes this breaks keyboard
  menus, and the e2e suite will catch it.
- **Forwarding every bound combo out of webviews** means a page can no longer
  use a combo that Manor has bound. That's the same trade-off terminals
  already make.
- **⌘⇧E and ⌘⇧Y are now taken** by default. Both can be rebound.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
