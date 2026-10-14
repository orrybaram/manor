---
title: A watch start after its connection dropped leaves no stale set
status: in-progress
priority: low
assignee: sonnet
blocked_by: [6]
---

# A watch start after its connection dropped leaves no stale set

Found during ticket 6. `BranchWatcher` and `DiffWatcher` keep one watched
set per connection and drop it from `createManorServer`'s
`bridge.onDisconnect` sink.

**The race.** A `branches.start` or `diffs.start` can be handled after its
connection has already dropped. `BridgeServer.receive` then re-releases
viewers for the dead connection, but tells no disconnect sinks. So the start
re-adds a set for a connection id that will never disconnect again, and the
server polls those workspaces forever.

## What to build

- In `electron/bridge/server.ts`, wherever `receive` (or the handler path)
  finds that the connection is already gone after a handler ran, also notify
  the disconnect sinks for that connection id, as it already re-releases
  viewers. Make the notification idempotent: a sink seeing the same id twice
  must be harmless. Check that `WatchedSets.stop` is.
- Keep the change small.

## Tests (each must fail on the base commit)

- A `BridgeServer` test: a handler that resolves after its connection
  dropped causes the disconnect sinks to be told about that id.
- A watcher-level test, or a `createManorServer`-level one if it's reachable:
  after the race, the dead connection's set is gone.

## Files to touch
- `electron/bridge/server.ts`
- `electron/bridge/__tests__/*.test.ts` (the closest existing server test)
- `electron/branch-watcher.test.ts` or `electron/__tests__/diff-watcher.test.ts`, if needed
