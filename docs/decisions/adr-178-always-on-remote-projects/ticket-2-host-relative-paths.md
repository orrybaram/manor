---
title: Host-relative paths in ProjectManager
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Host-relative paths in ProjectManager

**Prerequisite:** ADR-160 tickets 2 (injectable Exec) and 9 (registry, per-project hostId).

`ProjectManager` still resolves paths and runs scripts on the laptop. Route them through
the project's backend (ADR-178 §3).

1. Add `homeDir(): Promise<string>` to the shell backend interface in
   `electron/backend/types.ts`. Local: `os.homedir()`. Remote: `exec("sh", ["-c", "printf %s \"$HOME\""])`
   via the injected Exec. Cache per host.
2. `worktreePathFor` (`persistence.ts:1128`) becomes async. Default root is
   `<hostHome>/.manor/worktrees/<slug>`; expand `~` in `project.worktreePath` against
   `hostHome`. For local projects the result must equal today's (`worktreesDir()` is
   `~/.manor/worktrees` — confirm in `electron/paths.ts` and keep using it for local).
   Update the three callers (L1167, L1195, L1334).
3. `addProject` (L394–L421): read `package.json` and lockfile presence through the
   backend's `Exec.readFile` / a stat equivalent instead of `fs`.
4. `removeWorktree` (L863): run `worktreeTeardownScript` through the backend exec
   (`sh -c <script>`, `cwd` = worktree path), not local `execAsync`.

Local-only behavior must be byte-identical; existing `persistence.test.ts` must pass.
Add tests with a fake remote backend asserting remote home is used and teardown goes
through the backend.

## Files to touch
- `electron/backend/types.ts` — `homeDir` on the shell surface.
- `electron/backend/local-shell.ts` — local `homeDir`.
- `electron/persistence.ts` — async `worktreePathFor`, `addProject` reads, teardown exec.
- `electron/persistence.test.ts` — remote-path tests.
