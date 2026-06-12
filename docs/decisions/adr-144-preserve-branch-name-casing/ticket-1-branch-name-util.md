---
title: Create canonical branch-name util with tests
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Create canonical branch-name util with tests

Create a single renderer-side utility that owns branch-name and directory-slug logic,
plus a case-insensitive comparison helper. No call sites change in this ticket — this is
the foundation ticket-2 builds on.

## Behavior

`sanitizeBranchName(input: string): string` — enforce `git check-ref-format` rules while
**preserving case**:
- trim surrounding whitespace
- convert internal whitespace runs to a single `-`
- strip git-forbidden ref characters: `~ ^ : ? * [ \ ` and ASCII control chars, plus the
  `@{` / `}` sequence characters and a bare `@`
- collapse `..` → `.`, `//` → `/`, and repeated `-` → `-`
- keep `/` so namespaced branches survive (`feature/foo`, `user/PROJ-123`)
- trim leading/trailing `-`, `.`, `/`
- drop a trailing `.lock` (case-insensitive)
- do NOT lowercase — `PROJ-123-MyFeature` must come back as `PROJ-123-MyFeature`

`toDirSlug(input: string): string` — the existing lowercase filesystem slug. Port the
exact current behavior from `NewWorkspaceDialog.tsx` / `persistence.ts`:
```
str.toLowerCase()
   .replace(/[^a-z0-9\s-]/g, "")
   .replace(/[\s_]+/g, "-")
   .replace(/-+/g, "-")
   .replace(/^-|-$/g, "");
```

`branchesEqual(a?: string | null, b?: string | null): boolean` — case-insensitive
equality used only for *matching* (never for passing to git). Return `false` if either is
null/undefined; otherwise compare `a.toLowerCase() === b.toLowerCase()`.

## Files to touch
- `src/utils/branch-name.ts` — new file exporting `sanitizeBranchName`, `toDirSlug`,
  `branchesEqual`.
- `src/utils/__tests__/branch-name.test.ts` — new test file. Cover, at minimum:
  - case preserved: `sanitizeBranchName("PROJ-123-MyFeature")` → `"PROJ-123-MyFeature"`
  - spaces → hyphens: `"My Feature"` → `"My-Feature"`
  - forbidden chars stripped: `"feat: do~thing?"` → no `: ~ ?` remain
  - namespaced branch keeps slash: `"feature/Foo Bar"` → `"feature/Foo-Bar"`
  - trailing `.lock` removed; leading/trailing separators trimmed; `..`/`//` collapsed
  - `toDirSlug("PROJ-123 My Feature")` → `"proj-123-my-feature"` (still lowercase)
  - `branchesEqual("MyBranch", "mybranch")` → `true`; `branchesEqual(null, "x")` → `false`

Match the existing test framework/style in `src/utils/__tests__/`.
