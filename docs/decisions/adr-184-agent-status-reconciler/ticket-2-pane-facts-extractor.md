---
title: Daemon Pane facts extractor and paneFacts protocol
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Daemon Pane facts extractor and paneFacts protocol

Read `index.md` and `/CONTEXT.md`. This ticket is **additive**: keep the old `agentStatus`
event and `relayAgentHook` working for now. Ticket 3 switches main over and ticket 4 deletes
them.

1. Create `electron/terminal-host/pane-facts.ts`, a `PaneFactsExtractor` for one session.
   It turns bytes, OSC titles and the foreground process into a `PaneFacts` snapshot,
   using the type from ticket 1 (import it or share it).
   - Move the pure parsing out of `title-detector.ts` and `output-pattern-matcher.ts` into
     it: the OSC title parser and the output-pattern ring buffer.
   - Output hints are raw facts with a timestamp. Do not map them to a status here.
   - The foreground process comes from `pty-subprocess`'s existing polling. Map the name to
     an **Agent kind** using one table that includes `pi`. Today `AGENT_PATTERNS` lacks it.
   - It emits only when the snapshot actually changes.
2. `session.ts` feeds the extractor from `MSG.DATA` and from foreground-process updates. It
   emits a new stream event, `{ type: "paneFacts"; sessionId; facts }`. Add the event to
   `types.ts`, `ResponseFor`/`REPLY_TYPES` where relevant, and the client's stream dispatch.
3. Add a control request, `getPaneFacts { sessionId }`, that returns the current snapshot
   (or null). Add it to the daemon handler and client, then expose it through
   `PtyBackend` / `DaemonPtyBackend` / `RoutedBackend` / host-view gating.
4. Tests: the extractor gets unit tests (titles, patterns, foreground, change-only
   emission), a session emits `paneFacts`, and there is a `getPaneFacts` round trip.

Checks: tsc over the 3 configs (0/0/7), eslint, and the `electron/terminal-host` and
`electron/backend` tests.

## Files to touch
- `electron/terminal-host/pane-facts.ts` (new), `session.ts`, `types.ts`, `index.ts`, `client.ts` (plus `rpc-channel`/stream dispatch as needed), `pty-subprocess.ts`
- `electron/backend/types.ts`, `daemon-pty.ts`, `routed-backend.ts`, `host-view.ts`
- related tests
