---
title: Gate sessions/send behind capability, confirmation, and audit
status: todo
priority: high
assignee: opus
blocked_by: [3]
---

# Gate sessions/send behind capability, confirmation, and audit

`POST /sessions/send` types arbitrary text into a live shell. It is the only acting route
on the remote surface and needs three independent gates, not one.

1. **Capability** — the route is only present in the table when `device.canSend` is true
   (ticket 1's `remoteRouteTable(routes, allowWrites)`). Default false at pairing.
   Verify this is enforced by table construction per-request, not by a runtime `if` inside
   the handler.
2. **Confirmation** — client-side (ticket 6), but the server supports it: reject a send
   whose body lacks `confirmed: true`, so a bare `curl` with a stolen token still has to
   opt in deliberately and the audit log can distinguish it.
3. **Audit** — `electron/remote-control/audit.ts`: append-only JSONL in `manorDataDir()`,
   mode 0600, one line per remote write with timestamp, device id and label, target
   session, text **length and SHA-256 only** (never the text — it routinely contains
   secrets), and the outcome. Cap the file with simple size-based rotation so it cannot
   grow without bound.

Treat the `interrupt` override on the same route as a write — same three gates.

Do not modify the shared handler in `electron/routes/tasks.ts`; the `confirmed` check and
audit call belong in a remote-only wrapper so the local MCP path is unaffected.

Tests: `canSend: false` cannot reach the route at all; a send without `confirmed` is
rejected; a successful send writes exactly one audit line containing no plaintext; the
audit file is 0600; rotation triggers at the cap.

## Files to touch

- `electron/remote-control/audit.ts` — new.
- `electron/remote-control/server.ts` — remote-only wrapper around the send route.
- `electron/paths.ts` — `remoteAuditFile()`.
- `electron/remote-control/__tests__/audit.test.ts` — new.
