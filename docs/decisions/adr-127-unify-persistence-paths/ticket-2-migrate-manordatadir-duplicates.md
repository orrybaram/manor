---
title: Migrate 7 files that duplicate manorDataDir() to use paths.ts
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Migrate `manorDataDir()` duplicates

Seven files each define a private `manorDataDir()`. Delete every copy and import from `paths.ts` (created in ticket 1). Where the file also calls `path.join(manorDataDir(), "something.json")`, replace with the matching named getter.

## Mechanical replacements

For each file below:
1. Delete the local `function manorDataDir()` definition (and the `import os from "node:os"` line if `os` is no longer referenced elsewhere in the file).
2. Replace every `path.join(manorDataDir(), "foo")` expression with the matching getter from `paths.ts`.
3. If the class accepts an injectable `dataDir` for tests (e.g. `constructor(dataDir?: string)`), keep that constructor parameter — call sites pass a tmpdir in tests. Inside, default to `manorDataDir()` imported from `paths.ts` instead of the local copy.

### `electron/persistence.ts`
- Remove local `manorDataDir()` at line 30
- Constructor at line 125 uses `dataDir ?? manorDataDir()` — change to `dataDir ?? manorDataDir()` from `paths.ts`
- Also: the projects file inside this class should use `projectsFile()` if it reads/writes `projects.json`. Check how the persisted file is named and whether it can use the getter.

### `electron/task-persistence.ts`
- Remove local `manorDataDir()` at line 6
- Constructor at line 44 and the `tasksFilePath()` method at line 48-50 — replace `path.join(this.dataDir, "tasks.json")` with `tasksFile()` when `dataDir` is the default; keep the `this.dataDir` path when a custom dir is passed (tests). Simplest: keep `this.dataDir` and `tasksFilePath()` as-is, just change the default source from the local `manorDataDir()` to the imported one.

### `electron/preferences.ts`
- Remove local `manorDataDir()` at line 5
- Constructor at line 37 — swap to imported `manorDataDir()`
- `prefsFilePath()` uses `path.join(this.dataDir, "preferences.json")` — keep as is (custom dir support), just change the default source.

### `electron/keybindings.ts`
- Remove local `manorDataDir()` at line 5
- Constructor at line 20 — swap to imported

### `electron/window.ts`
- Remove local `manorDataDir()` at line 14 (currently exported; check if anything imports it)
- Replace `windowBoundsPath()` and `zoomLevelPath()` calls with `windowBoundsFile()` and `zoomLevelFile()` from `paths.ts`
- If the local exported `manorDataDir` is imported elsewhere, update those imports to come from `paths.ts`. Grep confirms no external importers; this should be safe to delete.

### `electron/linear.ts`
- Remove local `manorDataDir()` at line 52
- Constructor at line 62-64 — replace `path.join(manorDataDir(), "linear-token.enc")` with `linearTokenFile()`

### `electron/shell.ts`
- Remove local `manorDataDir()` at line 5
- `sessionsDir()` at line 13 — replace with `shellSessionsDir()` from paths (rename the static if it aids clarity, but preserve external call sites — grep `ShellManager.sessionsDir` before renaming)
- `zdotdirPath()` at line 17 — replace with `shellZdotdir()`

## Sanity check

After all edits, run these greps and confirm zero hits in `electron/` (excluding `paths.ts` itself and its tests):

```
rg "function manorDataDir" electron/
rg "Library/Application Support/Manor" electron/
rg "\.local/share/Manor" electron/
```

Run the existing test suites for touched files:
```
pnpm vitest run persistence task-persistence preferences keybindings window linear shell
```

All should pass unchanged — this is a pure refactor.

## Files to touch
- `electron/persistence.ts`
- `electron/task-persistence.ts`
- `electron/preferences.ts`
- `electron/keybindings.ts`
- `electron/window.ts`
- `electron/linear.ts`
- `electron/shell.ts`

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-127): Migrate 7 files that duplicate manorDataDir() to use paths.ts"

Do not push.
