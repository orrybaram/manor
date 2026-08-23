---
title: Security review pass and user documentation
status: todo
priority: critical
assignee: opus
blocked_by: [4, 5, 6, 7, 8]
---

# Security review pass and user documentation

This is the first Manor feature whose failure mode is someone else's shell. Before it
ships, review it as an adversary, then write down honestly what it exposes.

**Review.** Go through the implemented code specifically hunting for:

1. A route reachable remotely that is not in the allowlist — including anything added to
   `electron/routes/` while this ADR was in flight. Re-run the subset assertion and read
   the real table, do not trust the test alone.
2. Any path where the body is read, a handler runs, or state changes *before*
   authentication completes.
3. Token comparison that is not `timingSafeEqual` over equal-length buffers, or any error
   path that distinguishes "no such token" from "wrong token" by timing or message.
4. Tokens or scrollback appearing in logs, error responses, audit lines, or push payloads.
5. The listener binding anything other than `127.0.0.1`.
6. A tunnel that can outlive the app, start without explicit user action, or keep
   claiming "running" after its child died.
7. Revocation that is not immediate because something cached the device list.
8. Missing or permissive CSP on the served client; any external request from the page.
9. File modes on the device store, audit log, and VAPID key (all 0600).

Fix what you find. If something cannot be fixed in scope, write it into the ADR's Risks
section rather than leaving it undocumented.

Then run `/security-review` on the accumulated diff and address its findings.

**Docs.** Write `docs/remote-control.md`:

- What this exposes, stated plainly: your session list, your agent statuses, and the full
  scrollback of any session — which routinely contains API keys, tokens, and source code.
- What it can do: with a send-capable device, type arbitrary text into a live shell.
- The trust model: bearer token per device, tunnel required for outside access, Tailscale
  preferred over cloudflared and why.
- How to pair, how to revoke, how to tell whether you are currently exposed.
- What to do if a token leaks (revoke that device; the token is per-device for exactly
  this reason).
- What is deliberately not supported: Telegram or any third-party bot channel, and why.

Link it from `README.md`.

## Files to touch
- Any file the review turns up.
- `docs/decisions/adr-161-remote-control-relay/index.md` — update Risks with anything
  found and not fixed.
- `docs/remote-control.md` — new.
- `README.md` — link the doc.
