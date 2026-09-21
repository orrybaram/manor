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
session output _is_ the feature. It is the reason the authentication story
below has to be right rather than convenient.

## What a paired device can do

Nothing, at the `read` tier (**Watch** in the pairing dialog) — the default.
Pairing a device at `send` (**Reply**) grants three things, all of them
writes:

- **Type arbitrary text into a live shell**, which also interrupts whatever the
  agent was doing.
- **Answer a prompt with one tap.** When a session is waiting, the client offers
  `1` `2` `3` `y` `n` as buttons. They are fixed keys — Manor never reads the
  prompt to work out which option means "allow", because guessing that wrong is
  a security bug rather than a papercut. You read the transcript above them and
  choose.
- **Stop an agent** without saying anything to it, which ends the current turn
  and discards whatever was in flight.

The tier is chosen per device at pairing, so the phone you use to glance at
statuses need not be the one that can act. Each of the three above asks for a
confirmation naming the session before anything happens.

Every remote send and every remote stop is written to an append-only audit log
in Manor's data directory (`remote-audit.jsonl`, mode 0600): timestamp, which
device, which session, which of the two actions, and the **length and SHA-256**
of the text. The text itself is never recorded — an audit log that accumulated
the things you typed would be a worse leak than the thing it audits.

What is **not** on `read`, `send`, or `full`'s surface over this listener:
creating or deleting projects and workspaces, launching agents, splitting or
closing panes, opening tabs, and anything to do with issues. Those routes are
not "blocked" — they are absent from the table the remote listener dispatches
against, so no mistake in an authentication check can reach them. That
guarantee, and the allowlist it rests on, is what all three tiers get over
HTTP.

A device paired at `full` (**Everything**) is not distinguished from a `send`
device here. Its wider reach — everything the desktop app can do, including
creating and removing projects and workspaces, launching agents, and every
pane and tab mutation — exists only on `/ws`, the WebSocket bridge described
below, where authentication is the only boundary. Every mutating call a
`full` device makes there still gets a line in the audit log — the method and
what it targeted, never a body — but none of them waits on a `confirmed: true`
the way a `send` device's HTTP writes do, because the desktop UI's own
confirmation dialogs are already standing in front of every one of these
actions. Say it plainly: a leaked `full` token is a leaked machine.

Not quite none of that filtering, though. A short list of methods refuses
every device regardless of tier — `LOCAL_ONLY` in the handler table
(ADR-180 D4) — and it is worth naming rather than leaving as an absence: the
keybinding writes (`set`, `reset`, `resetAll`, and running a bound command in
the main window), the five `remoteControl` methods that change what is
exposed (`setEnabled`, `pair`, `revoke`, `startTunnel`, `stopTunnel`),
`linear.connect`, and `appCommands.result`, the reply half of a round trip
addressed to the primary window only. A stolen `full` token that could pair
more devices would survive its own revocation — a different, worse class of
loss than "can remove a workspace," which a `full` device is trusted with
knowingly — and that is the whole reason the pairing methods sit on this
list. `linear.connect`'s argument is an API key, not a route a device merely
shouldn't drive. Two more are here for a narrower reason than trust: the
viewport pair (`viewport.load`/`save`) names the desk's own viewport file,
which a device asking about would get the wrong screen's answer for, and the
prewarm pair (`pty.consumePrewarmed`/`updatePrewarmCwd`) names a prewarmed
shell that belongs to the window that asked for one — a browser never even
sends this pair, since it is answered inside the tab itself, the same as
`viewport.*`. A device calling any other `LOCAL_ONLY` method gets
`unavailable:web`, exactly what it would get for a method that does not
exist — and the refusal itself is not silent: it is written to the audit log
as a `rejected` call, the same as the HTTP transport already audits its own
refusals, with a null target recorded in place of an argument that would
otherwise be a secret.

## The trust model

**A separate listener.** Manor's existing local HTTP surface (used by the CLI
and the `manor` MCP server) has no authentication and does not need any: it
binds loopback, and loopback is its boundary. Remote control is a _second_
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

**Tailscale is the only tunnel.** With `tailscale serve`, only devices on your
tailnet can reach the address at all, so the pairing token is a _second_
factor. Manor used to offer a public cloudflared quick tunnel as well, but there
the token was the only thing between the internet and your session output, so
it was dropped. Manor finds `tailscale` on `PATH` or inside the Tailscale app
bundle. If neither is there, the settings card offers **Install**, which runs
`brew install --cask tailscale-app` in a small terminal you can watch and type
into, then opens the app so you can sign in.

## Pairing a device

1. **Settings → Remote control**, and turn on the toggle. The listener starts,
   still loopback-only.
2. **Start the tunnel** — the main button on the card at the top of the page.
   Manor names what becomes reachable before it starts anything.
3. **Pair a device.** Give it a name and a tier — **Watch** (`read`), **Reply**
   (`send`), or **Everything** (`full`). Watch is the default and the one
   pre-selected; picking Everything shows its own warning in place of the usual
   hint: "This device can do anything the desktop app can, including removing
   workspaces." Manor shows a QR code and the link once — scan it with the
   phone, or copy the link.
4. On the phone, the page stores the token and immediately strips it out of the
   address bar, so it does not linger in history or in a screenshot of the URL.

The QR code is generated locally. No token is ever handed to a third-party
image service.

## The web app

`/app` is the desktop app itself, served to a browser (ADR-178) — not a
smaller mobile client, the same renderer that runs in the Electron window.
Opening it needs a device paired at `full`; a `read` or `send` link opens only
the lightweight page at `/` described above, no matter what URL you type.

It reaches Manor over a WebSocket at `/ws`, authenticated by the same token in
the same first frame the HTTP paths check, and closed on any device below
`full` — a `read` or `send` token gets refused there, not handed a smaller
version of the bridge.

You can watch and drive any session from a browser exactly as you would at the
desk, and arrange it too: a split, a new tab, a pin, a close, or a move from
the browser is the same **layout command** the desktop sends, so it is applied
by Manor itself and shows up on the desk a frame later — layout belongs to the
Manor server, not to whichever window changed it
([ADR-179](decisions/adr-179-server-owned-layout/index.md)). A browser sees
every tab in a workspace, including ones popped out into their own window on
the desk — a detached window is just a desktop window's claim on a tab, not a
place the tab moves to. What each window is *looking at* stays its own:
flipping tabs on a phone does not flip the desk, and that selection is per
device, never shared.

Creating a workspace is still desktop-only, and the handful of features with no
browser equivalent (embedded browser panes, detaching a tab or pane into its
own window, the native app menu, opening a file in an editor, revealing a file
in Finder) show a stated empty state instead of failing silently — see
[ADR-178](decisions/adr-178-web-app-and-single-bridge/index.md).

One more thing worth knowing about a browser tab open next to the desktop app:
it shows the desktop's grid at the desktop's size and never resizes it.

### On a phone

Below roughly 768 px the web app lays out differently — the same state, walked
one pane at a time instead of the desk's grid shrunk to fit
([ADR-181](decisions/adr-181-phone-layout/index.md)). What you get:

- **One pane, full screen**, under a top bar: a drawer toggle, the workspace
  name, a pane-switcher button, and a button for the command palette. No
  sidebar, no status bar, no resize dividers.
- **The tab strip** — the active panel's tabs, one row, scrolling
  horizontally — and the **pane switcher**, a sheet listing every panel, tab
  and pane of the current workspace, are how you move between panes. There is
  no swipe between panes; the pan gesture is already spoken for by a follower
  wider than the phone.
- **The drawer** is the sidebar, opened from the top bar; picking a workspace
  in it closes the drawer and shows that workspace.
- **The command palette** opens full screen and is the phone's command
  surface: split, close, move and every other pane action with no touch idiom
  is a palette search away, the same as at a keyboard. Dragging (a tab, a
  split, a detach) is off on a phone rather than half-working under a thumb.
- **Typing is the native keyboard, straight into the terminal.** Tapping a
  pane focuses it and raises your phone's own keyboard; there is no composer
  and no extra row of special keys. That has a real limit, stated plainly
  because it is a decision and not a bug: **a phone keyboard has no Esc, Tab
  or Ctrl, so a phone cannot interrupt an agent or answer a TUI prompt that
  needs one of those keys.** For that, use the desktop app or the remote
  client's fixed `1` `2` `3` `y` `n` buttons, which do not need a keyboard at
  all.

## Knowing whether you are exposed

While a tunnel is live, a **REMOTE** badge sits in Manor's status bar, visible
from anywhere in the app — not only inside settings. Tap it to stop the tunnel.
If the tunnel dies on its own, the badge turns red and says so rather than
continuing to claim you are reachable.

The tunnel also stops when Manor quits.

## Notifications

A paired device can subscribe to Web Push, and gets a notification when a
session goes to `requires_input` or `error`. This is the same signal that
drives Manor's dock badge and desktop notifications, so muting _Agent needs
input_ in **Settings → Notifications** mutes the pushes too.

**On an iPhone or iPad, add the page to your Home Screen first.** iOS gives
notifications only to an installed web app — in a Safari tab there is no way to
grant permission at all. Open the paired link, tap Share, then _Add to Home
Screen_, and open Manor from the icon; the client says as much the first time it
sees a phone that has not done it. On Android and desktop the page can subscribe
from a tab. Either way the client asks with a button rather than a prompt on
load, because Safari only honours the permission request inside a tap.

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
  in the URL _fragment_, which browsers never send to a server, so the page has
  to load before it can authenticate. Anyone who finds your tunnel address gets
  the HTML, CSS, and JavaScript — and nothing else. Every route that reads or
  changes anything requires the token. The `/app` bundle is the whole desktop
  renderer, not the remote client's 16 KB — an unauthenticated visitor who
  finds it gets a much larger map of what the machine can do than before,
  though still no data.
- **Scrollback is as sensitive as the sessions themselves.** See the top of
  this document.
- **A hard crash could orphan the tunnel process.** Manor stops it on quit and
  again on process exit, but a `SIGKILL` to Manor leaves nothing to run. If
  Manor was killed outright, check for a stray `tailscale serve`
  process.

## Where things live

| File                 | What                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `remote-devices.enc` | Paired devices: label, token hash, capability, push subscription. Encrypted, 0600. |
| `remote-audit.jsonl` | One line per remote send. No plaintext. 0600, size-rotated.                        |
| `remote-vapid.enc`   | Web Push signing key pair. Encrypted, 0600.                                        |

All three are in Manor's application data directory
(`~/Library/Application Support/Manor` on macOS).

---

The design and its reasoning are in
[ADR-161](decisions/adr-161-remote-control-relay/index.md).
