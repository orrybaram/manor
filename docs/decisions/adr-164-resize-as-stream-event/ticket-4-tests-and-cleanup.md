---
title: Re-point the regression tests and remove the instrumentation
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Re-point the regression tests and remove the instrumentation

## Files to touch

- `src/lib/__tests__/terminal-grid.test.ts` — rewrite as a stream-ordering
  test: drive a headless emulator with the recorded shape of a drag, applying
  each resize at its stream position, and assert the repainted frame is on
  screen exactly once at every region height. Keep the controls, re-pointed:
  applying the resize a few chunks *late* (the old renderer's behaviour) must
  strand copies, so a broken harness cannot pass for free. Rename the file to
  match what it now covers.
- `tests/e2e/output-duplication.spec.ts` — keep the drag tests; they exercise
  the real path and are unaffected by the policy change.
- `electron/terminal-host/resize-trace.ts`, `electron/ipc/misc.ts`,
  `electron/preload.ts`, `src/electron.d.ts`, `src/hooks/*` — remove the
  temporary `debug:log` / `debug:trace` channels, the `paneId` instrumentation
  parameter and every `dlog` / `dtrace` call.
- `electron/terminal-host/session.ts` — remove the `debugLog` / `traceEvent`
  calls added for the diagnosis.

## Notes

Do not remove `sentAt` from `pendingResizes` if the ack-timeout logging is
replaced by something permanent; otherwise take it out with the rest.
