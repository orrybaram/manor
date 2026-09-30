---
title: prVerdict core module and table-driven test
status: done
priority: high
assignee: opus
blocked_by: []
---

# prVerdict core module and table-driven test

Implement ADR-202 §1, §2 and the core half of §5 in `src/lib/pr-readiness.ts`.

- Add `PrStage`, `PR_STAGES`, `PrBlocker`, `PrVerdict`, `prVerdict`, `PR_BLOCKER`, `blockerLabel` exactly as the ADR specifies.
- `prVerdict` walks the order once: merged, closed, then the blocker (conflicts → `checks.failing > 0` → `CHANGES_REQUESTED` → `unresolvedThreads > 0`), then queued, review, ready, pending. Keep the existing explanatory comments (`checks == null`, `REVIEW_REQUIRED`, queued), moved to where they now apply.
- Build the `checks` blocker's `failing` list from `pr.checkRuns` filtered to `status === "failing"` and mapped to `{name, url: run.url ?? null}`, the way `blockedContext` in `home-dashboard-studio.ts` does today. Copy its field semantics exactly.
- `stage`: blocked → blocked; ready/queued → ready; review → review; pending → `checks` if `pr.checks?.pending > 0`, otherwise `review`; merged/closed → null.
- `prReadiness(pr)` becomes `return prVerdict(pr).readiness;`, with a doc note that new code should call `prVerdict`.
- `blockerLabel`: "conflicts", "checks failing", "changes requested", "N unresolved thread"/"threads".
- Tests: create `src/lib/__tests__/pr-verdict.test.ts` with one `it.each` table (PrInfo overrides → expected full `PrVerdict`). Port every case from `pr-readiness.test.ts` and the `prStage` cases from `home-dashboard-studio.test.ts` (lines ~100–127). Add blocker precedence pairs and blocker details (failing runs with and without url, thread count). Add a tiny `blockerLabel` table. Then delete `src/lib/__tests__/pr-readiness.test.ts`. Do NOT edit the studio test yet (ticket 2 does).
- Do not touch other files. Callers keep compiling because `prReadiness` is still exported.

## Files to touch
- `src/lib/pr-readiness.ts`: the verdict, stage vocabulary and blocker metadata
- `src/lib/__tests__/pr-verdict.test.ts`: new table-driven test
- `src/lib/__tests__/pr-readiness.test.ts`: delete

Run `pnpm exec tsc --noEmit -p .` (or the repo's typecheck script) and `pnpm exec vitest run src/lib/__tests__/pr-verdict.test.ts`.
