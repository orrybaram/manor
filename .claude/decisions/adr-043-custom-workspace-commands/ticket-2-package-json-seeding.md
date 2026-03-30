---
title: Seed commands from package.json on project creation
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Seed commands from package.json on project creation

When a project is added, check for `package.json` in the project root and seed initial custom commands from its `scripts` field.

## Files to touch

- `electron/persistence.ts` — In `addProject()`, after creating the project, check if `{projectPath}/package.json` exists. If it has `scripts`, detect the package manager by checking for `pnpm-lock.yaml` (→ `pnpm run`), `yarn.lock` (→ `yarn`), else `npm run`. Create a `CustomCommand` for each script: `{ id: crypto.randomUUID(), name: scriptName, command: "${runner} ${scriptName}" }`. Assign to `project.commands` and call `saveState()` again. Also return the commands in the returned `ProjectInfo`.
