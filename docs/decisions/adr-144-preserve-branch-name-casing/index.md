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

# ADR-144: Preserve user-intended casing in git branch names

## Context

When creating a workspace, Manor force-lowercases the git branch name. A user who
entered a name containing uppercase (e.g. an issue key like `PROJ-123`) got a branch
created as `proj-123`, while some references retained the original intent — leading to
mismatch errors during workspace management, restore, and cleanup.

Three problems combine to cause this:

1. **Force-lowercasing.** Three duplicate `slugify()` implementations call
   `.toLowerCase()` when deriving the branch name:
   - `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx:16` — auto-fills
     the branch preview from the Name field as you type (line 313) and on submit
     (line 211).
   - `src/components/command-palette/GitHubIssueDetailView.tsx:25` — builds
     `${number}-${slugify(title)}` as the branch (line 55).
   - `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx:15` — derives a
     **project directory** name (filesystem only, not a branch).
   - A fourth copy lives in `electron/persistence.ts:22`, used for the worktree
     **directory** slug.

2. **Directory/branch drift.** In `electron/persistence.ts:705-710`, the git branch is
   `branch || name` while the worktree directory is `slugify(name)` (always lowercased).
   If the branch retains case but the directory does not, the two drift apart. On
   case-insensitive filesystems (macOS/APFS, Windows/NTFS) this surfaces as ref/path
   collisions — `.git/refs/heads/MyFeature` vs a `myfeature` reference — producing
   "branch already exists" / "cannot find ref" errors during restore and `git branch -D`
   cleanup.

3. **Case-sensitive comparisons.** Branch lookups use strict `===`:
   - `src/components/command-palette/IssueDetailView.tsx:53` — `ws.branch === issue.branchName` (Linear API casing).
   - `src/components/command-palette/GitHubIssueDetailView.tsx:61` — `ws.branch === branchName`.
   - `src/hooks/usePrWatcher.ts:34` — `w.branch === branch` (GitHub API casing).
   - `src/store/project-store.ts:442,546,688` — post-create / convert lookups.
   When an external source disagrees on case, the lookup silently fails: a workspace
   looks unlinked, or a duplicate gets created.

**Why change?** Lowercasing is a URL-slug convention misapplied to git branches:
- No existing ADR mandates it (checked `docs/decisions/`).
- Git ref names are case-sensitive and fully support uppercase; only the
  `git check-ref-format` character rules are mandatory.
- GitHub branch names are case-sensitive (Linux servers).
- Jira issue keys are uppercase by convention (`PROJ-123`); Jira DVCS / Smart-Commit and
  GitHub–Jira branch linking key off that token, so lowercasing can break auto-linking —
  the user's exact concern.

User intent should win: preserve case, sanitize only what git actually forbids.

## Decision

**Preserve case in branch names; lowercase only filesystem directory slugs.**

1. **New canonical util** `src/utils/branch-name.ts` exporting:
   - `sanitizeBranchName(input)` — enforces `git check-ref-format` rules while
     **preserving case**: trims, converts whitespace to `-`, strips forbidden ref
     characters (`~ ^ : ? * [ \ @{ }` and control chars), collapses `..`, `//`, and
     repeated `-`, trims leading/trailing separators, drops a trailing `.lock`, and keeps
     `/` so namespaced branches (`feature/foo`, `user/PROJ-123`) still work.
   - `toDirSlug(input)` — the existing lowercase filesystem slug behavior (for worktree
     and project directory names, where lowercasing is harmless and desirable).
   - `branchesEqual(a, b)` — case-insensitive branch comparison for **matching only**.

2. **Renderer call sites** (`NewWorkspaceDialog`, `GitHubIssueDetailView`,
   `IssueDetailView`, `ProjectSetupWizard`, `project-store`) switch to the util:
   branch derivation → `sanitizeBranchName`; directory derivation → `toDirSlug`;
   branch lookups → `branchesEqual`. The three duplicate `slugify()` definitions are
   deleted.

3. **Electron side** (`electron/persistence.ts`): branches preserve case via a
   `sanitizeBranchName`; directory slugs stay lowercased via `toDirSlug`. Because
   `electron/` and `src/` are separate TypeScript compilation units (`rootDir: electron`
   vs `include: ["src"]`) they cannot import a shared module without a build restructure
   (out of scope), so a small `electron/branch-name.ts` mirrors the two functions. Git
   remains the source of truth for a workspace's real branch — `git worktree list` output
   is never compared case-sensitively against a derived string.

4. **Always pass exact git/GitHub casing to commands**; only *matching* is
   case-insensitive.

## Consequences

**Better:**
- Issue keys (`PROJ-123`) survive into the branch name, restoring Jira/GitHub
  auto-linking.
- Eliminates the ref/path casing-mismatch class on case-insensitive filesystems.
- Branch lookups stop silently failing on external-API casing differences.
- One canonical branch-name util in the renderer instead of three drifting copies.

**Harder / risks:**
- Two source-of-truth functions remain (renderer `src/utils/branch-name.ts` and
  `electron/branch-name.ts`) because of the compile-unit boundary. Mitigated by keeping
  them tiny and covered by tests; a future shared-dir restructure could merge them.
- **Case-only directory collision** edge case persists: two names differing only by case
  (`MyFeature` vs `myfeature`) both map to the same lowercase directory slug. This is
  pre-existing, rare, and out of scope here — noted for follow-up if it bites.
- Existing workspaces created under the old lowercased scheme are unaffected; the change
  is forward-looking. `branchesEqual` makes old/new comparisons robust regardless.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
