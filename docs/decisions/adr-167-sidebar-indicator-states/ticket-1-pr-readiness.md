---
title: Add prReadiness pure function with tests
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add `prReadiness` pure function with tests

Create `src/lib/pr-readiness.ts` exporting:

```ts
import type { PrInfo } from "./pr-info";

export type PrReadiness = "ready" | "blocked" | "pending" | "merged" | "closed";

export function prReadiness(pr: PrInfo): PrReadiness;
```

Evaluate in this exact order and return the first match:

1. `pr.state === "merged"` → `"merged"`
2. `pr.state === "closed"` → `"closed"`
3. Any of the following → `"blocked"`:
   - `pr.checks != null && pr.checks.failing > 0`
   - `pr.reviewDecision === "CHANGES_REQUESTED"`
   - `pr.unresolvedThreads != null && pr.unresolvedThreads > 0`
4. All of the following → `"ready"`:
   - `!pr.isDraft`
   - `pr.checks != null && pr.checks.failing === 0 && pr.checks.pending === 0`
   - `pr.reviewDecision === "APPROVED"`
   - no unresolved threads (`unresolvedThreads` null/undefined/0)
5. Otherwise → `"pending"`

`pr.state` arrives lowercased from `electron/github.ts:130`; treat any state
other than `"merged"`/`"closed"` as open (matches current `PrPopover` behavior).

Add `src/lib/__tests__/pr-readiness.test.ts` (vitest, no DOM) covering: merged,
closed, failing checks, changes requested, unresolved threads (open), draft +
otherwise-green → pending, approved + all checks pass → ready, approved with no
`checks` → pending, pending checks → pending, no reviewDecision → pending, and
that `blocked` wins over `ready` inputs when both apply. Also assert that
unresolved threads on a merged PR still returns `"merged"` (order matters).

Run `pnpm vitest run src/lib/__tests__/pr-readiness.test.ts` and make it pass.

## Files to touch
- `src/lib/pr-readiness.ts` — new pure function
- `src/lib/__tests__/pr-readiness.test.ts` — new tests
