---
title: Detect default branch on project creation
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Detect default branch on project creation

Replace the hardcoded `"main"` default branch with detection of the repo's real
upstream default at project-add time.

## Behavior

Add a private async helper `detectDefaultBranch(repoPath: string): Promise<string | null>`
to `ProjectManager` in `electron/persistence.ts`. It uses the existing `this.git.exec(cwd, args[])`
backend (see `listLocalBranches`/`listRemoteBranches` for the pattern). Detection order:

1. `git symbolic-ref --short refs/remotes/origin/HEAD`
   - On success this returns `origin/<name>` (e.g. `origin/master`). **Strip the leading
     `origin/` prefix** and return the bare name (`master`). This is a local ref read —
     no network.
2. If step 1 fails/empty: `git remote set-head origin --auto` (best-effort, one cheap
   network round-trip), then retry step 1.
3. If everything fails, return `null`.

Trim stdout; treat empty string as failure. Wrap in try/catch and `console.error` on
failure following the existing logging style in this file. Never throw out of the helper.

Wire it into `addProject()`:
- Compute `const detected = await this.detectDefaultBranch(projectPath);`
- Use `detected ?? "main"` for the `defaultBranch` value in BOTH the persisted
  `PersistedProject` object (currently `defaultBranch: "main"` at ~line 180) and the
  returned `ProjectInfo` object (currently `defaultBranch: "main"` at ~line 233).
  Compute it once and reuse the same variable in both places.

Add a brief code comment at the `PersistedProject.defaultBranch` interface field (and/or
the `ProjectInfo.defaultBranch` field) documenting the storage invariant:
`// Bare local branch name (no "origin/" prefix). origin/ is prepended at use-sites — see ADR-081/144.`

## Files to touch
- `electron/persistence.ts` — add `detectDefaultBranch()` helper; call it in `addProject()`
  and replace both hardcoded `"main"` assignments; add the invariant comment on the
  `defaultBranch` field. Do not change unrelated logic.
