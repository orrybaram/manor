---
title: Plain-sentence summaries for common recipe failures
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [8]
---

# Plain-sentence summaries for common recipe failures

ADR-234 D10 (slice 3).

- New pure `src/lib/recipe-failures.ts`:
  `classifyRecipeFailure(output: string, host) → { summary, action? } | null`,
  matching the last ~4 KB of output against the ADR's pattern list (Docker,
  remote Docker, Kubernetes tables in the proposal pages). `action` is one of
  `{ kind: "url", label, href }`, `{ kind: "retry" }`,
  `{ kind: "show-recipe" }`. Copy names the host/daemon ("Docker isn't
  running", "A container called manor-50b660 already exists").
- `host-status.ts`: for `failure.reason === "recipe"`, use the classifier's
  summary when it matches; fall back to today's copy. Surface the action
  where the summary renders (host row + wizard step 3) using `Link` /
  `Button`. Raw output stays below, expanded.
- Table-driven unit tests: one real-world output sample per pattern, plus a
  non-match.

## Files to touch
- `src/lib/recipe-failures.ts` (new) + test
- `src/lib/host-status.ts`
- where the recipe failure summary renders (`HostStatusDetails`, `AddHostDialog`)
