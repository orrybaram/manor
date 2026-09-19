---
title: Put POST /agents on the remote surface, gated four ways
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Put POST /agents on the remote surface, gated four ways

This is the security-relevant ticket of ADR-177. Read the ADR's Context before
writing anything: the framing that justifies it is that a send-capable token is
*already* an arbitrary-execution capability (`POST /sessions/send` types into a
live shell), so launching into a workspace the machine already knows is a new
route rather than a new category of power. Everything below is what keeps it
that way.

## 1. Allowlist

`electron/remote-control/allowlist.ts`: add `"POST /agents"` to
`REMOTE_WRITE_ROUTES`. Extend that array's doc comment — it currently explains
why `POST /agents` is *not* a read despite sharing a path with `GET /agents`;
that sentence stays true and now needs its companion: why the write half is here,
and that the workspace check in `server.ts` is part of the deal.

## 2. Confirmation + audit

`electron/remote-control/server.ts`:

- add `"POST /agents"` to `GUARDED_WRITE_ROUTES` (name the constant
  `LAUNCH_ROUTE` alongside `SEND_ROUTE`/`INTERRUPT_ROUTE`);
- generalize `guardedWrite`'s body reading so a launch audits meaningfully:
  `target` is `body.target ?? body.workspacePath`, `text` is
  `body.text ?? body.prompt`. The prompt is hashed via `hashText` exactly as a
  send's text is — the audit log records length and hash, never the text;
- `interrupt` stays false for a launch (a new pane interrupts nothing). Confirm
  the existing expression yields false rather than adding a special case.

The `confirmed: true` gate then applies with no extra work, which is the point of
routing it through the same wrapper.

## 3. The new gate: the workspace must be one the machine knows

`POST /agents` (`electron/routes/agents.ts`) accepts any `workspacePath` string
and lets the renderer resolve it. That is correct for loopback callers (MCP, CLI)
and must not change — a remote launch into an arbitrary directory is not.

In `server.ts`, before dispatching to the real handler for `LAUNCH_ROUTE`:

- collect the known workspace paths from `this.getDeps().projectManager` —
  `getProjects()` is async, so the check is awaited inside the guard;
- compare the requested `workspacePath` for exact equality against those paths.
  Exact, not prefix: a prefix test is a path-traversal bug waiting to happen, and
  every legitimate launch target is a path the phone read from `GET /workspaces`
  verbatim (ticket 1);
- a mismatch, a missing `workspacePath`, or no `projectManager` is
  `403 { error: "Unknown workspace" }` with an audit line
  (`outcome: "rejected"`, reason naming the unknown workspace). It must not reach
  the handler, and it must not say which paths *would* have worked.

Keep the check in `server.ts`, not in the route: it is a remote-only concern, the
same reason the confirmation and the audit line live there.

## 4. Tests

`electron/remote-control/__tests__/allowlist.test.ts` — the deny-assertion
`it("agent launching")` loses its `POST /agents` expectation. That file's header
explains that widening the surface means deliberately deleting a test line; this
is that. **Keep** the `paths.filter((p) => p.startsWith("/agents/"))` line, so
rename/delete/read-of-one stay off the surface, and rename the test to say what
it now denies. Add to the same file: `POST /agents` is absent from
`remoteRouteTable(routes, false)` and present in `remoteRouteTable(routes, true)`.

`electron/remote-control/__tests__/server.test.ts` — follow the existing
send/interrupt guard tests:

- send-capable device + known workspace + `confirmed: true` → reaches the handler
  (assert via the stubbed renderer proxy / deps, as those tests already do);
- same, without `confirmed` → 400, handler never runs, audit line
  `outcome: "rejected"`;
- unknown `workspacePath` → 403, handler never runs, audit line;
- read-only device → 404 (absent from its table, not 403 — the point of the
  allowlist is that the row was never there);
- the audit entry for a successful launch records the workspace as `target`, the
  prompt's length and hash, and never the prompt itself.

## Files to touch
- `electron/remote-control/allowlist.ts` — `REMOTE_WRITE_ROUTES` + comment
- `electron/remote-control/server.ts` — `LAUNCH_ROUTE`, generalized audit fields, workspace gate
- `electron/remote-control/__tests__/allowlist.test.ts` — deny-line deletion, new presence/absence assertions
- `electron/remote-control/__tests__/server.test.ts` — the four gates, and the audit shape
