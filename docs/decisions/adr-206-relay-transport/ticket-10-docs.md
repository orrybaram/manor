---
title: Docs and vocabulary
status: done
priority: medium
assignee: haiku
blocked_by: [9]
---

# Docs and vocabulary

ADR-206.

## What to build

- **`docs/remote-control.md`:** a "Manor relay" section: what it is, how to
  start and pair, `full`-only and why, push needing Add to Home Screen on
  iOS, and a plain "what the relay can and cannot see" list taken from ADR-206
  D8 — including that whoever serves the page could read sessions. Replace
  "Tailscale is the only tunnel" with "two ways to reach the machine", and
  keep the reasoning for why the cloudflared quick tunnel stays dropped while
  the relay is offered. Add `remote-relay-identity.enc` to the files table.
- **`CONTEXT.md`** under "Reaching the machine": **Relay** (the hosted blind
  pipe; avoid: server, proxy, tunnel), **Room** (one desktop's place on the
  relay, addressed by its key hash; avoid: session, channel), **Channel**
  (one viewer's encrypted stream inside a room).
- `relay/README.md`: deploy, secrets, limits, local dev.
- Link ADR-206 from ADR-161 and ADR-178's "Amended by" lines.

## Files to touch
- `docs/remote-control.md`, `CONTEXT.md`, `relay/README.md`
- `docs/decisions/adr-161-remote-control-relay/index.md`, `docs/decisions/adr-178-web-app-and-single-bridge/index.md`
