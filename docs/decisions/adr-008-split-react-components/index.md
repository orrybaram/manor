---
type: adr
status: proposed
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

# ADR-008: Split Multi-Component React Files

## Context

Several React component files contain multiple component definitions in a single file, and two files exceed 500 lines. This makes navigation harder and violates the single-component-per-file convention the project should follow.

**Multi-component files:**
- `EmptyState.tsx` (276 lines) — 4 components: `WorkspaceEmptyState`, `WelcomeEmptyState`, `EmptyStateShell`, `ManorLogo`
- `SessionButton.tsx` (180 lines) — `SessionButton`, `TabAgentDot`, 2 hooks, utility function
- `ProjectSettingsPage.tsx` (259 lines) — `ProjectSettingsPage`, `LinearProjectSection`
- `IntegrationsPage.tsx` (129 lines) — `IntegrationsPage`, `LinearIntegrationSection`
- `PortsList.tsx` (108 lines) — `PortsList`, `PortGroup`, `PortBadge`
- `Toast.tsx` (59 lines) — `ToastItem`, `ToastContainer`

**Files over 500 LOC:**
- `ProjectItem.tsx` (537 lines) — single component with inline drag-and-drop logic and 2 confirmation dialogs
- `CommandPalette/CommandPalette.tsx` (510 lines) — single component with large command definition arrays

## Decision

Split each multi-component file so every component gets its own file. For the 500+ LOC files, extract logical subsections:

**Ticket 1 — EmptyState split:**
- `EmptyStateShell.tsx` — shell + `ManorLogo` (ManorLogo is tiny SVG, keep together)
- `WorkspaceEmptyState.tsx` — imports EmptyStateShell
- `WelcomeEmptyState.tsx` — imports EmptyStateShell
- Delete old `EmptyState.tsx`, update imports in consumers

**Ticket 2 — Small multi-component files split:**
- `SessionButton.tsx` → extract `TabAgentDot.tsx` and hooks into `useSessionTitle.ts`, `useSessionAgentStatus.ts`; keep `shortenTitle` in SessionButton (only consumer)
- `ProjectSettingsPage.tsx` → extract `LinearProjectSection.tsx`
- `IntegrationsPage.tsx` → extract `LinearIntegrationSection.tsx`
- `PortsList.tsx` → extract `PortGroup.tsx` and `PortBadge.tsx`
- `Toast.tsx` → extract `ToastItem.tsx`

**Ticket 3 — ProjectItem decomposition:**
- Extract `RemoveProjectDialog.tsx` and `DeleteWorktreeDialog.tsx` from inline Dialog usage
- Extract drag-and-drop logic into `useWorkspaceDrag.ts` hook
- Keep `ProjectItem.tsx` as the composition root

**Ticket 4 — CommandPalette decomposition:**
- Extract `useCommandPaletteCommands.ts` hook (command definitions array)
- Extract `useWorkspaceCommands.ts` hook (workspace command builder)
- Keep `CommandPalette.tsx` as the composition root with rendering logic

## Consequences

- **Better**: Each file has a single responsibility, easier to navigate and review
- **Better**: Smaller diffs when modifying individual components
- **Risk**: More files to manage, but they're all co-located and well-named
- **Risk**: Circular dependency if not careful with shared types (mitigated by keeping types in the files that define them)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
