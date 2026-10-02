---
title: Docs — one road
status: todo
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Docs — one road

ADR-207 D6. Do not edit historical ADRs. Match the existing docs' voice: plain
and declarative.

- `docs/remote-control.md`: rewrite for relay only.
  - Remove the Watch/Reply tier section, the tunnel/Tailscale trust model, the
    install flow and the relay vs Tailscale gate.
  - Remove the "orphaned `tailscale serve`" known gap and the "stops both"
    badge copy.
  - Keep and update: enabling remote control, the slim loopback listener
    (`/app` and `/ws`, this machine only), relay pairing, reset, push, the
    exposure badge, token leak, and where things live.
- `CONTEXT.md`:
  - Delete the **Remote client**, **Capability** and **Remote surface** terms
    and their relationships.
  - Fix the relay `_Avoid_`, Caller class, Viewer, Follower and "served by the
    desktop's listener (over Tailscale)" lines, and the example dialogue.
- `docs/AGENT-SYSTEM.md:776-779`: drop `start-tunnel`/`stop-tunnel`. Fix the
  status wording.
- `relay/src/index.ts:51` `UNPUBLISHED_PAGE`: change "Update Manor, or use
  Tailscale." to "Update Manor." Update `relay/test/web.test.ts:77`.
- Comment drift that mentions the tunnel, tailnet or remote client. Grep
  `-i 'tailscale|tunnel|tailnet|remote client'` outside `docs/decisions/` and
  `CHANGELOG.md`, and fix what remains. Leave the rest of `CHANGELOG.md` alone.
  Known spots:
  - `electron/bridge/handlers/pty.ts:241`
  - `electron/bridge/transports/ws.ts`
  - `src/bridge/client.ts:136`
  - `src/bridge/transports/ws.ts:421`
- `CHANGELOG.md`: add a `## [Unreleased]` section at the top. It should say
  that:
  - Tailscale tunnel support, the Watch/Reply tiers and the lightweight phone
    client are removed;
  - the relay is the only way to reach the machine;
  - devices paired over Tailscale or at Watch/Reply are deleted on upgrade and
    must be re-paired.
- `docs/decisions/index.md`: leave it alone. It is a database view.

## Files to touch
- `docs/remote-control.md`, `CONTEXT.md`, `docs/AGENT-SYSTEM.md`, `CHANGELOG.md`
- `relay/src/index.ts`, `relay/test/web.test.ts`
- stray comments found by grep
