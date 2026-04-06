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

# ADR-112: Open Diff Keyboard Shortcut with New Panel Option

## Context

There is no keyboard shortcut for opening the diff view. Users must use the command palette to access it. Additionally, the current `openOrFocusDiff` action always opens a diff as a new tab in the active panel. Users want the option to open the diff in a **new panel** (editor group split) instead, making it easier to view changes side-by-side with a terminal.

## Decision

1. **Add keybinding `Cmd+Shift+G`** (id: `"open-diff"`) to `DEFAULT_KEYBINDINGS` in `src/lib/keybindings.ts`. This mirrors VS Code's source control shortcut.

2. **Add a preference `diffOpensInNewPanel: boolean`** (default: `true`) to `AppPreferences`. When enabled, the shortcut and command palette action will open the diff in a new panel via `splitPanel` logic rather than a new tab.

3. **Add a new store action `openDiff`** that checks the preference and either:
   - Calls existing `openOrFocusDiff` behavior (new tab in active panel) when `false`
   - Creates a diff tab in a new panel split when `true`

   In both cases, if an existing diff pane is found, it focuses that pane (no duplicate diffs).

4. **Wire the keybinding** in `App.tsx` handler map and show the shortcut in the command palette command.

5. **Add a toggle** in `GeneralSettingsPage.tsx` under a new "Diff" section.

## Consequences

- Users get fast keyboard access to the diff view.
- The new-panel behavior is the default; users can opt out via settings if they prefer tabs.
- The preference is simple and persisted through the existing preferences system.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
