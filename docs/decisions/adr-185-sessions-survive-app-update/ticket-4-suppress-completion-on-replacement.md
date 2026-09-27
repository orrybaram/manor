---
title: Don't complete Agents killed by a daemon replacement
status: done
priority: critical
assignee: opus
blocked_by: [3]
---

# Don't complete Agents killed by a daemon replacement

Read ADR-185 `index.md` §A and the reconciler header in
`electron/agent-status/reconciler.ts` (rules H8, U1 etc.) and ADR-184.

1. `electron/agent-status/driver.ts`: add
   `expectPaneLoss(paneIds: readonly string[], ttlMs?: number): void` to the
   `AgentStatusDriver` interface + implementation (default 60_000 ms, use the
   driver's `monoClock`). Track a per-pane deadline. Clear a pane's entry when
   its TTL passes or when a `SessionStart` hook arrives for it.
2. Thread "expected loss" into the reconciler as data (keep it pure): e.g. the
   driver passes `expectedLoss: boolean` in the signal context, or strips the
   effect. Prefer a reconciler-level rule so it's tested with the other H-rules:
   for `SessionEnd` while expected-loss, still reset pane state (idle, root
   dropped, kind null) and still drain a held Stop to `responded`, but do NOT
   emit `PersistAgentStatus → completed`. Name/document it in the header
   (e.g. "H8a — SessionEnd during a daemon replacement").
3. Audit every other path that completes/abandons an Agent because its pty
   exited or its pane went away (grep `to: "completed"`, `to: "abandoned"`,
   `forgetPane`, pane `exit` handling in `app-lifecycle.ts` / `electron/ipc/agents.ts`
   / `electron/backend/*`). Apply the same suppression inside the window so the
   Agent stays `status: "active"` with its `paneId` — that is what
   `src/hooks/useTerminalLifecycle.ts` needs to auto-resume it on cold restore.
4. `electron/app-lifecycle.ts`: subscribe to the registry's
   `onDaemonReplacing` (ticket 3) and call `agentStatusDriver.expectPaneLoss(sessionIds)`.
   It must be wired before `backend.connect()` runs (the event fires during
   connect). Check where `agentStatusDriver` is created relative to connect and
   reorder the subscription if needed.
5. Tests in `electron/agent-status/__tests__/`: SessionEnd inside window → no
   completed effect, pane idle; SessionEnd after TTL → completed; SessionStart
   clears window so a later SessionEnd completes; held Stop still drains to
   responded inside window.

## Files to touch
- `electron/agent-status/driver.ts` — `expectPaneLoss`, window tracking
- `electron/agent-status/reconciler.ts` — suppression rule
- `electron/agent-status/types.ts` — any new context/type
- `electron/agent-status/__tests__/*` — tests
- `electron/app-lifecycle.ts` — wiring
- Any other completion-on-exit site found in step 3
