---
title: Stop swallowing assignIssue and closeIssue failures
status: todo
priority: critical
assignee: sonnet
blocked_by: [8]
---

# Stop swallowing assignIssue and closeIssue failures

Fixes correctness bug #7. Commit `40ecb20` unswallowed `getMyIssues`/`getAllIssues`
and argued, correctly:

> *swallowing the error and returning `[]` makes a broken `gh`, an unauthenticated
> user, and a genuinely empty backlog indistinguishable*

The same argument applies to the two methods it did not touch.

## The bugs

### `github.ts:241-255` — `assignIssue` cannot throw

```ts
try { await execFileAsync("gh", ["issue","edit",...]) } catch { /* fire-and-forget */ }
```

So the `try/catch` at `electron/routes/projects.ts:237-243` wraps a method that
cannot throw — a dead handler over a swallow. The failure is discarded **twice**.
An agent that requests `assign: true` for 10 issues, gets 10 unassigned issues,
and is told `started: true` for each. `BatchResultEntry.error` exists and is
rendered by `tools-agents.ts:238`; it never learns.

### `github.ts:257-271` — `closeIssue` is not fire-and-forget

`src/components/.../LinkedIssuesPopover.tsx:286-293` optimistically removes the
row (`setRemovedIds`) **before** awaiting, then reloads projects.
`src/components/.../GitHubIssueDetailView.tsx:131-138` closes the dialog first.
When `gh issue close` fails — unauthenticated, offline, wrong repo — the UI
states the issue is closed and it is not.

## What to do

### 1. Delete both `try/catch` blocks

`electron/github.ts`. Both methods now reject. Mirror `getMyIssues`'s docstring
convention: one sentence saying they throw and why.

### 2. `LinkedIssuesPopover` — revert the optimistic removal on failure

Wrap the `await closeIssue(...)` in `try/catch`; on rejection, remove the id from
`removedIds` so the row reappears, and surface the error via the component's
existing error/toast path. The optimistic update stays — it just becomes
reversible.

### 3. `GitHubIssueDetailView` — do not close the dialog on failure

Await `closeIssue` first; close the dialog only on success. On rejection, keep
the dialog open and show the error.

### 4. `BatchResultEntry` gains `assignError`, and assigns run in parallel

`electron/routes/projects.ts`:

- Add `assignError?: string` to `BatchResultEntry`. A workspace that was created
  but whose assignment failed must not be reported as an unqualified success, and
  must **not** be conflated with `entry.error` (which means "no workspace").
- The assign calls are independent network writes serialized in a `for` loop
  (step 3). Worktree creation — the only genuinely sequential part — already
  happened in step 2. Hoist the assigns into a `Promise.all` alongside, or into
  the existing `Promise.all` at line ~181.
- The existing `catch` at line 240 becomes live: record `assignError`, keep going.

Update `electron/mcp/tools-agents.ts:238`'s rendering to surface `assignError`
distinctly from `error`.

### 5. Note, do not fix

`electron/linear.ts:293-330`'s `closeIssue` swallows symmetrically. Leave it —
widening this ADR to the Linear client is out of scope. Add a one-line `TODO`
referencing ADR-152 so the asymmetry is recorded rather than forgotten.

## Files to touch
- `electron/github.ts` — delete both `try/catch`; docstrings
- `src/components/.../LinkedIssuesPopover.tsx` — revert optimistic removal on rejection
- `src/components/.../GitHubIssueDetailView.tsx` — close the dialog only on success
- `electron/routes/projects.ts` — `assignError`; parallelize the assigns; the `catch` becomes live
- `electron/mcp/tools-agents.ts` — render `assignError`
- `electron/linear.ts` — TODO only
- `electron/github.test.ts` — assert both methods now reject

## Verify
`pnpm typecheck` clean. New tests: `assignIssue` rejects when `gh` fails;
`closeIssue` rejects when `gh` fails; the batch route reports `assignError` on a
created workspace and still reports `started: true`. Manually confirm
`LinkedIssuesPopover` restores the row when `closeIssue` rejects.
