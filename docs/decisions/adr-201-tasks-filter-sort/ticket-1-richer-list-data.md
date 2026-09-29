---
title: Return every useful field from GitHub and Linear list calls
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Return every useful field from GitHub and Linear list calls

See ADR-201 §2 and §3.

## GitHub (`electron/github.ts`)
- Extract the `--json` field list used by `getMyIssues` and `getAllIssues`
  into one constant; add `createdAt,closedAt,milestone,comments,stateReason,projectItems`.
- After parsing, map each issue: replace `comments` (array) with
  `commentCount: comments.length`; normalise `projectItems` to
  `{ title: string; status?: string }[]` (gh returns `{title, status: {name}}`
  — check the real shape by running `gh issue list --json projectItems --limit 3`
  in this repo; be defensive about missing fields).
- If `gh` fails and stderr mentions a missing scope / `read:project` /
  `projectItems`, retry once without `projectItems`. Keep the "throws on
  failure" contract otherwise. Do not add retries for other errors.
- Update `electron/github.test.ts` for the new args, the mapping and the
  scope fallback.

## Linear (`electron/linear.ts`)
- Both list queries (`getMyIssues`, `getAllIssues`) add:
  `priority priorityLabel createdAt dueDate estimate state { name type color }
  project { name } cycle { number name } team { key name }
  creator { name displayName }`.
- Update `LinearIssue` there and in `electron/linear.test.ts` fixtures.

## Types (`src/electron.d.ts`)
- `GitHubIssue`: optional `createdAt?`, `closedAt?: string | null`,
  `milestone?: { title: string } | null`, `commentCount?: number`,
  `stateReason?: string | null`, `projectItems?: { title: string; status?: string }[]`.
  Keep `GitHubIssueDetail` compatible (it already has `milestone`).
- `LinearIssue` mirror of the new Linear fields, all optional / nullable.

## `src/lib/tasks.ts`
- `TaskRow` gains: `priority?: { value: number; label: string }`,
  `trackerProjects: string[]`, `milestone?: string`, `cycle?: string`
  (e.g. "Cycle 12" or the cycle name), `team?: string` (key),
  `estimate?: number`, `dueDate?: string`, `createdAt: string` (`""` if
  absent), `commentCount?: number`.
- `fromGitHub` / `fromLinear` fill them. Linear `author` = creator
  displayName || name. GitHub status: when closed with
  `stateReason === "NOT_PLANNED"` label it "Closed (not planned)", tone
  `canceled`.
- `LinkedTask` / `linkedTasks` copies the new fields from the fetched match
  (defaults: `trackerProjects: []`, `createdAt: ""`).
- Update `src/lib/tasks.test.ts` fixtures and add cases for the mapping.
- Grep for other `GitHubIssue` / `LinearIssue` literal fixtures (tests,
  mocks, remote-client) and fix type errors.

## Files to touch
- `electron/github.ts`, `electron/github.test.ts`
- `electron/linear.ts`, `electron/linear.test.ts`
- `src/electron.d.ts`
- `src/lib/tasks.ts`, `src/lib/tasks.test.ts`
