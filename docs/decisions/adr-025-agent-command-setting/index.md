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

# ADR-025: Agent Command Setting & New Task Command

## Context

Manor currently hardcodes `claude --resume` when resuming tasks (in `App.tsx:handleResumeTask`). Users need the ability to configure which agent CLI command to use (e.g., `claude`, `claude --dangerously-skip-permissions`, or a custom wrapper). Additionally, there's no way to start a fresh agent task from the command palette — users must manually type the CLI command in a terminal.

## Decision

1. **Add `agentCommand` to `ProjectInfo`** — a per-project setting stored alongside other project fields like `defaultRunCommand`. Defaults to `"claude --dangerously-skip-permissions"`. This is stored in persistence and exposed through the existing `updateProject` flow.

2. **Add "Agent Command" field to `ProjectSettingsPage`** — a text input in the project settings, under the existing "Scripts" section, allowing users to customize the agent command per project.

3. **Add "New Task" command to command palette** — in the Tasks group of the command palette. When selected, it creates a new session (tab) in the current workspace and writes the agent command into the terminal after a short delay for shell initialization.

### Files to change:
- `electron/persistence.ts` — add `agentCommand` to `PersistedProject` and `ProjectInfo`, include in `buildProjectInfo`
- `src/store/project-store.ts` — add `agentCommand` to `ProjectInfo` and `ProjectUpdatableFields`
- `src/electron.d.ts` — no changes needed (types are imported from store)
- `src/components/ProjectSettingsPage.tsx` — add "Agent Command" input field
- `src/components/CommandPalette/useTaskCommands.tsx` — add "New Task" command
- `src/components/CommandPalette/types.ts` — add `onNewTask` to `CommandPaletteProps`
- `src/components/CommandPalette/CommandPalette.tsx` — pass `onNewTask` to `useTaskCommands`
- `src/App.tsx` — implement `handleNewTask` and pass to `CommandPalette`

## Consequences

- Users can configure per-project agent commands, supporting different CLI tools or permission flags
- The default `claude --dangerously-skip-permissions` provides the most common use case out of the box
- "New Task" in the palette provides a quick way to start agent sessions without typing
- The `handleResumeTask` in App.tsx should also use the project's `agentCommand` for consistency
