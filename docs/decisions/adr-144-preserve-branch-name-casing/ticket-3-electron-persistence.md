---
title: Preserve branch casing in electron/persistence
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Preserve branch casing in electron/persistence

Apply the same policy on the main-process side: branches preserve case, directory slugs
stay lowercase. `electron/` is a separate TS compilation unit (`rootDir: electron`) and
cannot import `src/utils/branch-name.ts`, so mirror the two functions in a small electron
module. This ticket touches only `electron/` files, so it does not overlap with ticket-2
and may run in parallel.

## Files to touch

- `electron/branch-name.ts` — new file. Export `sanitizeBranchName` and `toDirSlug` with
  **identical behavior** to `src/utils/branch-name.ts` (see ticket-1 spec). Keep it small;
  add a one-line comment noting it intentionally mirrors the renderer util because the two
  compile units can't share a module.

- `electron/persistence.ts`
  - Delete the local `slugify` (lines 22–29). Import `sanitizeBranchName` and `toDirSlug`
    from `./branch-name`.
  - `createWorktree` (around lines 705–710):
    - branch: `const branchName = sanitizeBranchName(branch || name);` (was `branch || name`)
    - directory slug: `const slug = toDirSlug(name);` (was `slugify(name)`)
    - project base dir fallback (line 709): `toDirSlug(project.name)`
  - `convertMainToWorktree` (around lines 849–852): directory slug → `toDirSlug(name)`;
    project base dir fallback → `toDirSlug(project.name)`.
  - Do NOT change how `removeWorktree` detects the branch — it reads `git worktree list`,
    which is the source of truth and must stay exact-case. Leave the `git branch -D
    ${branchName}` path using that detected value.

## Notes
- Git remains the source of truth for a workspace's real branch; never compare a derived
  slug case-sensitively against `git worktree list` output.
- Existing lowercased workspaces are unaffected — this is forward-looking only.
