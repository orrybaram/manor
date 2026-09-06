---
title: Isolate $HOME for the vitest suite and make the processes kill test side-effect free
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Isolate $HOME for the vitest suite

Every vitest worker must see a throwaway `$HOME` before any test module is imported, so nothing under `paths.ts` can reach the developer's real `~/.manor` or `~/Library/Application Support/Manor`.

1. Create `electron/__tests__/setup-isolated-home.ts`:
   - Capture `process.env.HOME` as `REAL_HOME` (export it for the guard test).
   - `const home = fs.mkdtempSync(path.join(os.tmpdir(), "manor-vitest-home-"))`; set `process.env.HOME = home`; create `path.join(home, ".manor")`.
   - Remove the directory in `process.on("exit")` (best effort, `rmSync` with `force: true, recursive: true`).
   - No vitest imports needed; keep it dependency-free so it also works if setupFiles ordering changes.
2. Register it first in `vitest.config.ts` `setupFiles` (before `src/store/__tests__/setup.ts`).
3. Add `electron/__tests__/home-isolation.test.ts` asserting `manorHomeDir()` and `manorDataDir()` start with `os.tmpdir()`-resolved temp home and do not start with `REAL_HOME`, and that `daemonPidFile()` does not exist.
4. In `electron/__tests__/processes-kill-stats.test.ts`:
   - Stub `process.kill` in `beforeEach` (`vi.spyOn(process, "kill").mockImplementation(() => true)`) and restore in `afterEach`.
   - Add a test: with no pid file present, `processes:killAll` does not call `process.kill`.
   - Add a test: write `String(424242)` to `daemonPidFile()` (import from `../paths`, mkdir the parent), run `processes:killDaemon`, assert `process.kill` was called with `(424242, "SIGTERM")` and that the pid file is gone afterwards.
5. Run `npx vitest run` and confirm all files pass. Then run the repro loop in the ADR context (daemon under a temp HOME + full suite) and confirm the daemon survives.

## Files to touch
- `vitest.config.ts` — add the setup file first in `setupFiles`
- `electron/__tests__/setup-isolated-home.ts` — new
- `electron/__tests__/home-isolation.test.ts` — new guard test
- `electron/__tests__/processes-kill-stats.test.ts` — stub `process.kill`, add the two tests
