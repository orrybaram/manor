---
title: agents crosses
status: in-progress
priority: high
assignee: sonnet
blocked_by: [6]
---

# agents crosses

ADR-180 D8. 15 methods, 14 `ipcMain` registrations in `ipc/agents.ts`. Seven
are already on the table (`getAll`, `get`, `getActive`, `getRecent`,
`getUnseen`, `buildResumeCommand`, `setPaneContext`).

## What crosses

The rest: the seen/unseen writes (`markSeen`, `markAllSeen`), `delete`,
`rename`, `endSession`, `interrupt`, `sendToSession`, `readSession` and
whatever else `electron/ipc/agents.ts` registers. Lift each body to a function
over `IpcDeps`, add the entry, delete the handler, drop the namespace from
`manorHost.native`.

`interrupt` and `sendToSession` drive a live agent, so they go in `MUTATING` —
and note that ADR-161 already chose to audit *sends* (a whole prompt handed to
an agent) while not auditing keystrokes, so `sendToSession` is precisely the
kind of call that trail is for.

None of these is `LOCAL_ONLY`. "Check on my agents from anywhere" is the
sentence ADR-178 started from; a browser that can watch an agent and cannot
mark it seen is the read-and-type state this slice exists to end.

## Events

`agents/updated` is already a broadcast (`agent-updated` in
`electron/notifications.ts`), and the client's `SUBSCRIPTION_EVENTS` already
maps `agents.onUpdate` → `updated`. The desktop stops listening on the
`agent-updated` channel and subscribes; delete the `webContents.send`.

## Watch for

`unseenRespondedAgents` / `unseenInputAgents` are `Set`s on `IpcDeps`, shared
mutable state that both callers now write. They are already shared with the
route table, so this is not new — but a browser marking an agent seen must
produce the same `agents/updated` broadcast a desktop window does, or the
badge clears on one screen and not the other. ADR-179 ticket 4 fixed exactly
this for the viewport path; do not reintroduce it.

## Files to touch
- `electron/bridge/handlers.ts` — ~8 new entries, `MUTATING` additions
- `electron/ipc/agents.ts` — lift the remaining bodies, delete `register()`
- `electron/notifications.ts` — `agent-updated` publishes only
- `electron/preload.ts` — remove the `agents` namespace
- `electron/__tests__/agents-unseen-source-of-truth.test.ts` — extend to the bridge caller

## Folded in from ticket 4

Ticket 6's rule applies: delete the legacy `webContents.send` and the matching
preload `on*` in the same commit as the crossing. **`agent-updated` has three
send-sites, not one** — `electron/notifications.ts`, `electron/routes/agents.ts`
and `electron/routes/panes.ts`. Miss one and the badge updates from some paths
and not others, which is worse than it not working at all.

## Folded in from ticket 5

`handleStreamEvent` is still called once per window, purely because
`sendAgentUpdate` writes to the addressed legacy `agent-updated` channel. The
bookkeeping is idempotent so it is effectively one send to the first live
window, but the loop is vestigial and it goes here, with the crossing. Ticket
5 left a comment in place marking it.
