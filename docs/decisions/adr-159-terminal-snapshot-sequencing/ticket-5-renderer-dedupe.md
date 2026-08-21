---
title: Renderer — drop queued output the snapshot already covers
status: done
priority: critical
assignee: opus
blocked_by: [4]
---

# Renderer — drop queued output the snapshot already covers

`useTerminalStream` already holds live output in a queue until the snapshot has
been written. Make the queue carry each chunk's seq, and drop the chunks the
snapshot accounts for instead of writing them a second time.

Extract the rule as a pure function — something like
`outputAfterSnapshot(queued, snapshotSeq)` — so it can be tested without a
terminal or an IPC bridge. Rules:

- `snapshotSeq` is `null`/`undefined` (cold session, or an older daemon) → keep
  everything.
- chunk seq `<=` snapshotSeq → drop; the snapshot already shows it.
- chunk seq `>` snapshotSeq, or the chunk has no seq → keep, in arrival order.

`openOutput` takes the snapshot seq and applies this before flushing.
`useTerminalLifecycle` passes `result.snapshotSeq` through from `pty:create`.

## Files to touch
- `src/hooks/useTerminalStream.ts` — queue `{ seq, data }`; `openOutput(term,
  snapshotSeq)`; keep the kitty-keyboard interception ahead of queueing, as now.
- `src/hooks/useTerminalLifecycle.ts` — pass the snapshot seq at the `openOutput`
  call in the create chain's `.finally`.
- `src/hooks/__tests__/` — new test file for the pure function: covers dropping,
  keeping, ordering, absent seq, and an empty queue.

## Notes
- Preserve arrival order among kept chunks; do not sort by seq.
- The kitty protocol filter must still run on every chunk, dropped or not, since
  it answers queries on the shell's behalf.
