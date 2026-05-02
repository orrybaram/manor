---
title: Integration tests for pushStream against a real bare repo
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Ticket 6: Integration tests for pushStream

Cover the streaming push end-to-end against a real local bare repo. Mirrors the existing `local-git.test.ts` setup pattern.

## Files to touch

- `electron/backend/__tests__/local-git-pushstream.integration.test.ts` (new) — separate file from the unit test in ticket 2 to keep mocked vs real-git suites isolated.

  Setup pattern (mirror the existing `local-git.test.ts`):
  - `beforeEach`: create a temp dir, `git init` a working repo, `git init --bare` a separate bare repo, configure the working repo's `origin` remote to point at the bare repo. Make a commit on the working repo so there's something to push.
  - `afterEach`: clean up the temp dir.

  Tests:
  1. **Happy path**: call `pushStream` with the existing committed branch (already set as upstream, or pre-run `git push -u origin main` in setup). Collect `onLine` calls and the `onDone` payload. Assert `exitCode === 0` and that `stderr` includes `"To "` (git's destination line).
  2. **No upstream**: create a fresh branch (`git checkout -b feature`) with a commit but no upstream set. Call `pushStream` without `setUpstream`. Assert `exitCode !== 0` and `stderr` matches the no-upstream signature (contains "set-upstream" or "no upstream branch"). Then call again with `setUpstream: true` and assert `exitCode === 0`.
  3. **Auth fail / unreachable remote**: configure a fake remote URL pointing to a nonexistent host (e.g. `git remote set-url origin https://nonexistent.invalid/repo.git`) on a fresh branch. Call `pushStream`. Assert `exitCode !== 0` and `stderr` is non-empty. Don't assert exact stderr wording — git's error text varies by version. Just assert it's non-empty so we know stderr capture works.
  4. **Cancel mid-push**: skip if hard to set up reliably. If you can construct a slow push (e.g. many large blobs and a slow remote), call `cancel()` immediately after start and assert `onDone` fires with non-zero exit. If you can't, omit this test rather than make it flaky — the unit test in ticket 2 already covers the cancel path.

## Notes

- These tests shell out to real `git`. If the CI environment doesn't have git or if these tests are slow, gate them behind a `describe.skipIf(...)` checking for git availability — match whatever pattern `local-git.test.ts` uses.
- Auth-fail test must not actually try to authenticate (no real network). Pointing at `https://nonexistent.invalid/...` ensures DNS fails fast without any credential prompt (also `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=/bin/true` from the impl prevent any prompt).
- Each test should be hermetic — no shared repo state between tests. The `beforeEach` setup handles this.
