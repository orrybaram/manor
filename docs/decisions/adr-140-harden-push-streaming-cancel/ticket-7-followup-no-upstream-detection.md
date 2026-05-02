---
title: Reach the no-upstream auto-retry path (currently dead code)
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Ticket 7 (follow-up): Reach the no-upstream auto-retry path

Surfaced during ticket 6 integration testing. The `categorizePushError` `set-upstream` action and DiffPane's no-upstream auto-retry button are unreachable today because `LocalGitBackend.pushStream` always pre-resolves the current branch and runs `git push origin <branch>`, which silently creates the remote branch (no error) instead of producing git's "no upstream branch" error.

## Two viable fixes

**A. Drop the explicit branch arg.** Run `git push <remote>` without a branch when `setUpstream === false`. Git emits the no-upstream error → categorizer catches it → DiffPane shows the auto-retry button. Matches the original ADR design.

**B. Pre-detect missing upstream and auto-set silently.** Before spawning push, run `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (cheap). If it errors, set `setUpstream: true` automatically — user never sees an error, first push "just works." Trades discoverability of the action button for smoother UX.

Recommend **B** — silent first-push works is strictly better UX. The action button exists for users who hit the no-upstream case from a different code path; if first-push always succeeds, that path mostly disappears. Keep the categorizer entry for safety (still triggers if git emits the error from some unforeseen path).

## Files to touch (option B)

- `electron/backend/local-git.ts` — in `pushStream`, after resolving branch, run `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (sync, ignore errors). If it throws, set `effectiveSetUpstream = true` regardless of `opts.setUpstream`.
- `electron/backend/__tests__/local-git-pushstream.test.ts` — add a unit test mocking the upstream-check failing → assert `--set-upstream` flag added.
- `electron/backend/__tests__/local-git-pushstream.integration.test.ts` — add an integration test: fresh branch, no upstream, call `pushStream` without `setUpstream`, assert exit 0 AND that upstream is now configured.

## Notes

- Don't remove the categorizer's `no-upstream` kind or the DiffPane action wiring — both remain as safety nets.
- The upstream-check must use the same sync exec pattern (`execFileSync`) ticket 2 used for branch resolution — same sync-cancel-handle constraint.
