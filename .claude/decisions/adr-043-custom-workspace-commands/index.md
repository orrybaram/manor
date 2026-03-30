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

# ADR-043: Custom Workspace Commands

## Context

Users want to define per-project commands (name + shell command) that appear in the command palette for the active workspace. This lets users quickly run common project-specific operations (builds, deploys, test suites, linters) from the command palette instead of typing them out each time.

The project already has a `defaultRunCommand` field on `ProjectInfo`, but no general-purpose custom commands system. The command palette (`cmdk`) already supports grouped command items, so custom commands can be injected as another group.

As a convenience, initial commands can be seeded from the project's root `package.json` scripts when the project is added (for JS/TS projects).

## Decision

### Data model

Add a `commands` field to `ProjectInfo`:

```typescript
export interface CustomCommand {
  id: string;    // UUID
  name: string;  // Display name in palette
  command: string; // Shell command to execute
}
```

- `ProjectInfo.commands: CustomCommand[]` (default: `[]`)
- Add `commands` to `ProjectUpdatableFields` and `PersistedProject`
- Persisted in `projects.json` alongside other project fields

### Command palette integration

Create a `useCustomCommands` hook that:
1. Gets the active project (from `activeWorkspacePath` → matching project)
2. Returns `CommandItem[]` from `project.commands`
3. Each command's action writes the command string to the active terminal pane via `window.electronAPI.pty.write(activePaneId, command + "\n")`

Display custom commands in a "Run" group in the command palette, between Tasks and Workspaces groups.

### Settings UI

Add a "Commands" section to `ProjectSettingsPage`:
- List of existing commands with name/command fields and a delete button
- "Add Command" button at the bottom
- Each row: name input, command input, delete button
- Save on blur (consistent with existing settings pattern)

### Package.json seeding

When a project is first added, check if `{projectPath}/package.json` exists. If it does and has `scripts`, create initial custom commands from those scripts (e.g. script `"dev": "vite"` becomes `{name: "dev", command: "npm run dev"}`). Only done once at project creation time — not kept in sync.

Detect the package manager by checking for lock files (`pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn`, default `npm run`).

## Consequences

- Users get quick access to project-specific commands from the palette
- Commands are project-scoped, not workspace-scoped — all workspaces within a project share the same commands
- The data model is simple (array of {id, name, command}) and easy to extend later
- Package.json seeding provides immediate value for JS projects without manual setup
- No keybinding support for individual commands initially — users access them through the palette

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
