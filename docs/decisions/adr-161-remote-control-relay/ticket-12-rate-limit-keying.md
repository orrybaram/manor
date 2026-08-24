---
title: Rate limiting keys on the wrong thing behind a tunnel
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Rate limiting keys on the wrong thing behind a tunnel

`server.ts` derives the limiter key from `req.socket.remoteAddress`. Every request that
arrives through `tailscale serve` or `cloudflared` reaches a loopback-bound listener, so
that address is `127.0.0.1` for **all** remote devices, always.

The consequence is the opposite of the one the limiter was written for. It is not that an
attacker escapes the backoff — they do not, they share it. It is that they drag your own
phone into it: someone guessing tokens against a discovered tunnel hostname drives the
single bucket into exponential backoff, and the paired device that holds a perfectly good
token gets 429s. A control meant to slow down an intruder currently lets that intruder
lock the owner out.

`recordSuccess` clears the bucket, so this self-heals whenever a legitimate request lands
between failures — which is exactly the race you do not want to be relying on while you
are away from the machine.

**Resolved by neither of the two shapes below.** Both change the *key*; the actual defect
is the *order*. `devices.verify()` now runs before the backoff is consulted, so the
backoff can only ever delay a request that failed to authenticate, and a valid token is
served no matter what the shared bucket has accumulated. `X-Forwarded-For` stays untrusted
— see the ADR. The two candidates considered:

- **Trust a forwarded address, narrowly.** Read `X-Forwarded-For`'s leftmost entry, but
  only when the socket peer is loopback *and* a tunnel is currently running — that is the
  only configuration in which the header was written by a process we started. Anywhere
  else, ignore it. Note that a cloudflared quick tunnel can be reached by anyone, so this
  buys per-attacker granularity, not identity.
- **Key on the presented credential instead of the address.** Failures are only counted
  when a token was actually presented, so a hash prefix of the presented token is already
  available and is not attacker-controllable in a way that helps them: guessing a fresh
  token each time means never accumulating a count, but each of those guesses is a fresh
  bucket that cannot touch the real device's.

Whichever lands, the property to test is the one that is broken today: a device holding a
valid token must keep being served while another source is failing authentication through
the same tunnel.

Also worth resolving in the same pass: the limiter is in-memory and per-process, so it
resets whenever remote control is toggled. That is acceptable — enablement is not
persisted either — but say so in a comment rather than leaving it to be rediscovered.

Tests: failures attributed to one forwarded source do not delay a different forwarded
source; `X-Forwarded-For` is ignored when the socket peer is not loopback; a valid token
is served while a concurrent guesser is being backed off.

## Files to touch

- `electron/remote-control/server.ts` — key derivation.
- `electron/remote-control/rate-limit.ts` — if the key shape changes.
- `electron/remote-control/__tests__/server.test.ts` — the cases above.
- `docs/decisions/adr-161-remote-control-relay/index.md` — record the choice.
- `docs/remote-control.md` — if the trust model section needs a line.
