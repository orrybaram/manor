---
title: Cached login PATH resolved asynchronously
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Cached login PATH resolved asynchronously

See ADR-205 §1.

- Create `electron/login-path.ts` with `readCachedLoginPath`, `withCommonPaths`,
  `resolveLoginPath`, `startLoginPathResolution`, `loginPathReady` as the ADR
  describes. Inject `execFile`/fs seams (or small parameters) so it is unit-testable.
- Add `loginPathFile()` to `electron/paths.ts` (`manorDataDir()/login-path.json`).
- In `electron/main.ts`, replace the `execFileSync` block with
  `if (app.isPackaged) startLoginPathResolution();` and drop the
  `execFileSync` import. Keep the comment explaining why (Finder/Dock PATH),
  updated.
- `loginPathReady()` must resolve immediately when not packaged / when
  `startLoginPathResolution` was never called.
- Cache write: create the dir if needed; swallow all fs errors (log with
  `console.warn`). Only write when the PATH changed.
- Tests in `electron/login-path.test.ts`: cache applied synchronously; no
  cache → common-paths fallback, then resolved PATH applied and cached;
  `loginPathReady` immediate with cache, waits without; shell mismatch
  ignores cache; resolve failure keeps the fallback and still settles.

Do not touch `app-lifecycle.ts` (ticket 4 wires `loginPathReady`).

## Files to touch
- `electron/login-path.ts` — new
- `electron/login-path.test.ts` — new
- `electron/paths.ts` — `loginPathFile()`
- `electron/main.ts` — call `startLoginPathResolution()`
