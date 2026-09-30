---
title: Dashboard selectors read the verdict
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Dashboard selectors read the verdict

Implement ADR-202 §3 for the lib layer.

- `src/lib/home-dashboard.ts`
  - `needsYouItems`: call `prVerdict(pr)` once. Tier = readiness if blocked or ready. `reason` = `blockerLabel(verdict.blocker)` for blocked, otherwise "ready to merge".
  - `blockedReason(pr)`: reduce it to a delegate (`const { blocker } = prVerdict(pr); return blocker ? blockerLabel(blocker) : "blocked";`), with a comment that it exists only for `openPrLabel`.
  - Do NOT touch `openPrRows`, `openPrLabel`, `OpenPrReadiness`, `OPEN_PR_RANK` or any Up next function. Leave the `prReadiness` import if `openPrRows` still needs it.
- `src/lib/home-dashboard-studio.ts`
  - Delete `PrStage`, `PR_STAGES`, `prStage` and `blockedContext`. Import `PrStage` and `PR_STAGES` from `./pr-readiness`, and re-export neither.
  - `NeedsYouCardContext`: replace the four blocker variants with `PrBlocker`.
  - `cardContext`: blocked PR → `prVerdict(item.pr).blocker!` (or narrow via the union).
  - `prPipeline`: `const verdict = prVerdict(pr); const stage = verdict.stage!` (open PRs always have a stage). `pipelineLabel` takes the verdict and uses `blockerLabel(verdict.blocker)` for blocked.
  - `projectTiles`: `prVerdict(pr).stage === "ready"`.
- Update importers of the moved names: `src/components/sidebar/HomeDashboard/pr-stage.ts`, `StatTiles.tsx` (`PR_STAGES`) and `WorkspacePopover.tsx` (swap `prStage` + `blockedReason` for `prVerdict` + `blockerLabel`). Check `PipelineStage.tsx`, `CardContext.tsx` and `fix-pr-prompt.ts` still compile.
- Tests: delete the `describe("prStage")` block in `src/lib/__tests__/home-dashboard-studio.test.ts` and fix its imports. In `src/lib/__tests__/home-dashboard.test.ts`, remove the conflicts-over-threads precedence assertion (~line 257–263), which `pr-verdict.test.ts` now covers, but keep a test showing `needsYouItems` attaches a reason. Keep the `openPrRows` tests untouched.

## Files to touch
- `src/lib/home-dashboard.ts`: `needsYouItems`, `blockedReason` only
- `src/lib/home-dashboard-studio.ts`: remove duplicates, read the verdict
- `src/components/sidebar/HomeDashboard/pr-stage.ts`, `StatTiles.tsx`, `WorkspacePopover.tsx`: imports and verdict use
- `src/lib/__tests__/home-dashboard-studio.test.ts`, `src/lib/__tests__/home-dashboard.test.ts`: remove redundant order tests

Run the typecheck and `pnpm exec vitest run src/lib`.
