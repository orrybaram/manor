# Remote control

Manor can let you check on your agents from a phone. It is off by default, and
turning it on is three separate, deliberate steps — enabling the listener,
starting a tunnel, and pairing a device — because each one widens what is
exposed by a different amount.

This document is blunt about what that exposure is. Read it before you turn
this on.

## What a paired device can see

- **Your session list** — every active session Manor knows about, with its
  name, its project, and its agent status.
- **The full scrollback of any session.** This is the part to think about.
  Terminal scrollback routinely contains API keys, access tokens, environment
  variables, customer data, and your source code. Anything that has been
  printed in a session is readable by a paired device.

That is not an implementation shortcoming that can be tightened later — reading
session output *is* the feature. It is the reason the authentication story
below has to be right rather than convenient.

## What a paired device can do

Nothing, unless you check **Allow this device to send input** when you pair it.

A device with that capability can type arbitrary text into a live shell, which
also interrupts whatever the agent was doing. It is off by default and set per
device, so the phone you use to glance at statuses need not be the one that can
act.

Every remote send is written to an append-only audit log in Manor's data
directory (`remote-audit.jsonl`, mode 0600): timestamp, which device, which
session, and the **length and SHA-256** of the text. The text itself is never
recorded — an audit log that accumulated the things you typed would be a worse
leak than the thing it audits.

What is **not** on the remote surface at all: creating or deleting projects and
workspaces, launching agents, splitting or closing panes, opening tabs, and
anything to do with issues. Those routes are not "blocked" — they are absent
from the table the remote listener dispatches against, so no mistake in an
authentication check can reach them.

## The trust model

**A separate listener.** Manor's existing local HTTP surface (used by the CLI
and the `manor` MCP server) has no authentication and does not need any: it
binds loopback, and loopback is its boundary. Remote control is a *second*
listener with its own route table and its own authentication, rather than a
flag on the first one.

**A token per device.** Pairing generates a 32-byte random token. Manor stores
only its SHA-256, encrypted with your OS keychain (`safeStorage`) at mode 0600.
The raw token is shown once, at pairing, and cannot be retrieved afterwards. If
a machine cannot encrypt, Manor refuses to store tokens rather than writing one
to disk in plaintext — remote control simply will not turn on.

**Loopback plus a tunnel.** The listener always binds `127.0.0.1`, even when
enabled. Reaching it from outside is the tunnel's job, and Manor never starts a
tunnel on its own: not at launch, not on restore, not as a side effect of
anything. Remote control is also off again after every restart, deliberately —
a setting that silently reopens a listener after an update is exactly the
surprise this feature cannot afford.

**Tailscale is preferred over cloudflared**, and the difference is not
convenience. With `tailscale serve`, only devices on your tailnet can reach the
address at all, so the pairing token is a *second* factor. With a Cloudflare
quick tunnel the address is public and the token is the only thing between the
internet and your session output. Manor detects both and installs neither.

## Pairing a device

1. **Settings → Remote control**, and turn on the toggle. The listener starts,
   still loopback-only.
2. **Start a tunnel.** Manor names what becomes reachable, and which tool it
   will use, before it starts anything.
3. **Pair a device.** Give it a name; leave *Allow this device to send input*
   unchecked unless you need it. Manor shows a QR code and the link once —
   scan it with the phone, or copy the link.
4. On the phone, the page stores the token and immediately strips it out of the
   address bar, so it does not linger in history or in a screenshot of the URL.

The QR code is generated locally. No token is ever handed to a third-party
image service.

## Knowing whether you are exposed

While a tunnel is live, a **REMOTE** badge sits in Manor's status bar, visible
from anywhere in the app — not only inside settings. Tap it to stop the tunnel.
If the tunnel dies on its own, the badge turns red and says so rather than
continuing to claim you are reachable.

The tunnel also stops when Manor quits.

## Notifications

A paired device can subscribe to Web Push, and gets a notification when a
session goes to `requires_input` or `error`. This is the same signal that
drives Manor's dock badge and desktop notifications, so muting *Agent needs
input* in **Settings → Notifications** mutes the pushes too.

Push payloads carry the session name and project only. Scrollback never goes
into a push — a notification reaches your lock screen and is retained by the OS.

## If a token leaks

Revoke that device: **Settings → Remote control → Paired devices → trash icon**.
Revocation takes effect on the next request; nothing caches the device list.
Its push subscription goes with it.

Tokens are per device for exactly this reason — revoking one does not disturb
the others. If you are unsure which device is affected, revoke all of them and
re-pair; pairing takes a few seconds.

If you suspect the machine itself was reached, stop the tunnel first, then
revoke.

## Deliberately not supported

**Telegram, or any third-party bot channel.** It is the most-demoed feature of
comparable tools, and it means handing a third party a channel that can type
into your shell. Web Push covers the actual need — being told, rather than
checking — without introducing another party to the trust model.

## What is knowingly not protected

- **The app shell is served without authentication.** The pairing token arrives
  in the URL *fragment*, which browsers never send to a server, so the page has
  to load before it can authenticate. Anyone who finds your tunnel address gets
  the HTML, CSS, and JavaScript — and nothing else. Every route that reads or
  changes anything requires the token.
- **Scrollback is as sensitive as the sessions themselves.** See the top of
  this document.
- **A hard crash could orphan the tunnel process.** Manor stops it on quit and
  again on process exit, but a `SIGKILL` to Manor leaves nothing to run. If
  Manor was killed outright, check for a stray `cloudflared` or `tailscale`
  process.

## Where things live

| File | What |
| --- | --- |
| `remote-devices.enc` | Paired devices: label, token hash, capability, push subscription. Encrypted, 0600. |
| `remote-audit.jsonl` | One line per remote send. No plaintext. 0600, size-rotated. |
| `remote-vapid.enc` | Web Push signing key pair. Encrypted, 0600. |

All three are in Manor's application data directory
(`~/Library/Application Support/Manor` on macOS).

---

The design and its reasoning are in
[ADR-161](decisions/adr-161-remote-control-relay/index.md).
