---
title: Mirror main-process console output to a rotating log file
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Mirror main-process console output to a rotating log file

See ADR-188 §4. Main currently logs only to stdout, which is lost when the app
is launched from Finder, so incidents like the sleep/wake stall cannot be
diagnosed afterwards.

## Steps

1. New module `electron/main-log.ts`:
   - `installMainLog(opts?: { dir?: string; maxBytes?: number })`. `dir`
     defaults to `app.getPath("logs")` and `maxBytes` to `5 * 1024 * 1024`.
     Idempotent: a second call is a no-op.
   - Wrap `console.log/info/warn/error/debug`. Call the original, then append
     `${new Date().toISOString()} ${LEVEL} ${util.format(...args)}\n` to
     `<dir>/main.log` through an append-mode `fs.createWriteStream`.
   - Rotation: at install, and whenever bytes written push the file past
     `maxBytes`, close the stream, rename `main.log` → `main.log.1`
     (overwriting), and reopen. Track size yourself (initial `statSync` size +
     bytes written); do not stat per line.
   - All fs errors are swallowed (stream `error` listener included). After a
     stream error, stop writing to the file but keep the console working.
   - Export a pure helper for the line format so it can be unit-tested.
2. `electron/main.ts`: call `installMainLog()` right after `app.setName`, or
   anything else that determines the app's logs path. Check what `main.ts` /
   `app-lifecycle.ts` does with the app name and user data path.
   `app.getPath("logs")` can be read before `ready`, but must come after any
   `app.setPath`/`setName` calls. Guard with try/catch so a failure never
   blocks startup.
3. Tests `electron/main-log.test.ts` (vitest, temp dir, pass `dir` explicitly
   so no electron import is needed at call time; mock `electron` if the module
   imports `app` at top level):
   - lines are appended with timestamp and level, and the original console
     still receives the call;
   - rotation happens past `maxBytes`, keeping exactly one `.1`;
   - an unwritable dir does not throw.

Run the new test file and the typecheck.

## Files to touch
- `electron/main-log.ts`: new
- `electron/main-log.test.ts`: new
- `electron/main.ts`: install early
