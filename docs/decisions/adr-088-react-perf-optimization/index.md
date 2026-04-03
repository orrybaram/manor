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

# ADR-088: React Performance Optimization (Vercel Best Practices Audit)

## Context

An audit of the codebase against Vercel's React Best Practices identified 6 categories of performance issues:

1. **Barrel imports** — 31 files import from `lucide-react` barrel, bundling the entire icon library (~1500 exports) for ~50 icons used
2. **Eager modal imports** — App.tsx eagerly imports SettingsModal, CommandPalette, ProjectSetupWizard, TasksModal, and other dialogs that are only conditionally rendered
3. **O(n*m) pane lookups** — `allPaneIds(s.rootNode).includes(paneId)` inside `.find()` loops across app-store.ts (7 occurrences), task-store.ts, and task-navigation.ts. Each call rebuilds the full pane ID array then does a linear scan
4. **Broken memo on TaskRow** — TaskRow is wrapped in `React.memo` but receives inline arrow function props, defeating the shallow equality check
5. **Unprotected localStorage** — GitHubNudge.tsx and DeleteWorktreeDialog.tsx access localStorage without try-catch
6. **Heavy xterm.js import in GitHubNudge** — Non-essential nudge component eagerly imports Terminal + FitAddon + CSS

## Decision

### Ticket 1: Fix lucide-react barrel imports
Replace all `import { Icon } from "lucide-react"` with direct path imports `import Icon from "lucide-react/dist/esm/icons/icon-name"` across all 31 files. This avoids loading the full barrel and reduces module count.

### Ticket 2: Lazy-load modals and dialogs in App.tsx
Convert SettingsModal, CommandPalette, ProjectSetupWizard, TasksModal, and NewWorkspaceDialog to `React.lazy()` imports with `Suspense` fallbacks. These components are only shown conditionally.

### Ticket 3: Add `findSessionByPaneId` helper using Set lookups
Create a helper `findSessionByPaneId(sessions, paneId)` in `pane-tree.ts` that iterates sessions once, calling `allPaneIds()` on each but using `.includes()` only once per session (not nested). Also add a `hasPaneId(node, paneId)` function that short-circuits as soon as the ID is found (avoids building the full array). Replace all 9 occurrences across app-store.ts, task-store.ts, App.tsx, and task-navigation.ts.

### Ticket 4: Fix TaskRow memo effectiveness
The inline `onClick={() => onResumeTask(task)}` and `onClick={(e) => { onRemoveTask(task.id) }}` on TaskRow create new function instances every render, defeating `React.memo`. Refactor TaskRow to accept `taskId` instead and use `useCallback` or move the handler wrapping inside TaskRow itself.

### Ticket 5: Wrap localStorage in try-catch
Add try-catch around localStorage access in GitHubNudge.tsx (lines 47, 65) and DeleteWorktreeDialog.tsx (lines 19, 47-50).

### Ticket 6: Lazy-load xterm.js in GitHubNudge
Dynamic-import `@xterm/xterm` and `@xterm/addon-fit` inside the `startInstall` callback (they're only needed when the user clicks Install). Remove the top-level imports.

## Consequences

- **Bundle size**: Reduced initial JS bundle — icons loaded individually, modals code-split, xterm deferred
- **Runtime perf**: Pane lookups go from O(sessions * panes) to O(panes) with early exit; TaskRow memo actually works
- **Robustness**: localStorage access won't throw in restricted environments
- **Tradeoff**: Direct lucide imports are more verbose but eliminate barrel overhead
- **Tradeoff**: Lazy modals add a brief Suspense flash on first open (mitigated by empty fallback since modals animate in anyway)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
