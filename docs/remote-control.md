# Remote control

Manor can let you check on your agents from a phone. It is off by default, and
turning it on is three separate, deliberate steps — enabling remote control,
starting the Manor relay, and pairing a device — because each one widens what is
exposed by a different amount.

There is one way in: the Manor relay. Nothing on the machine listens for remote
control, and no tunnel or third-party network is involved.

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

Everything the desktop app can. A paired device reaches the whole bridge
(ADR-178, ADR-207): it can type into a live shell, answer an agent's prompt,
stop an agent, create and remove projects and workspaces, launch agents, and
make every pane and tab change. There are no read-only devices and no tiers.
Say it plainly: a leaked token is a leaked machine.

Authentication is the only boundary. Every mutating call a device makes still
gets a line in the audit log (`remote-audit.jsonl` in Manor's data directory,
mode 0600): timestamp, which device, the method and what it targeted, never a
body. Where a call carries text, only its **length and SHA-256** are recorded.
The text itself is never recorded — an audit log that accumulated the things
you typed would be a worse leak than the thing it audits.

A short list of methods refuses every device — `LOCAL_ONLY` in the handler
table (ADR-180 D4) — and it is worth naming rather than leaving as an absence:
the keybinding writes (`set`, `reset`, `resetAll`, and running a bound command
in the main window), the methods that change what is exposed
(`remoteControl.setEnabled`, `startRelay`, `stopRelay`, `resetRelayAddress`,
`pair` and `revoke`), `linear.connect`, and `appCommands.result`, the reply half
of a round trip addressed to the primary window only. A stolen token that could
pair more devices would survive its own revocation — a different, worse class
of loss than "can remove a workspace," which a device is trusted with knowingly
— and that is the whole reason the pairing methods sit on this list.
`linear.connect`'s argument is an API key, not a route a device merely
shouldn't drive. Two more are here for a narrower reason than trust: the
viewport pair (`viewport.load`/`save`) names the desk's own viewport file,
which a device asking about would get the wrong screen's answer for, and the
prewarm pair (`pty.consumePrewarmed`/`updatePrewarmCwd`) names a prewarmed
shell that belongs to the window that asked for one — a browser never even
sends this pair, since it is answered inside the tab itself, the same as
`viewport.*`. A device calling any other `LOCAL_ONLY` method gets
`unavailable:web`, exactly what it would get for a method that does not
exist — and the refusal itself is not silent: it is written to the audit log
as a `rejected` call, with a null target recorded in place of an argument that
would otherwise be a secret.

## The trust model

**Nothing listens.** Remote control opens no socket on the machine: no HTTP
listener, no static files, no route table, no `/ws`. Manor's own local HTTP
surface (used by the CLI and the `manor` MCP server) binds loopback and is not
part of remote control. The desktop dials _out_ to the relay, and the only way
in is a Noise handshake through it, followed by the bridge. An earlier version
had a remote-control listener on loopback, reachable through a Tailscale tunnel.
Both are gone, and so is the lightweight phone page that used them.

**A token per device.** Pairing generates a 32-byte random token. Manor stores
only its SHA-256, encrypted with your OS keychain (`safeStorage`) at mode 0600.
The raw token is shown once, at pairing, and cannot be retrieved afterwards. If
a machine cannot encrypt, Manor refuses to store tokens rather than writing one
to disk in plaintext — remote control simply will not turn on.

**The token is the only factor.** There is no network in front of the relay, so
a device is admitted on its token alone. That is accepted because the relay only
ever sees ciphertext, the token never leaves the encrypted channel (it is in no
header a proxy can log), and a bad token is met with a failed-auth backoff
rather than an answer. The device check and the backoff live in
`electron/remote-control/relay-gate.ts`. A valid token is verified before the
backoff is consulted, so a knock someone else earned cannot lock out a good
device.

**Nothing starts itself.** Manor never starts the relay on its own: not at
launch, not on restore, not as a side effect of anything. Remote control is also
off again after every restart, deliberately — a setting that silently makes the
machine reachable again after an update is exactly the surprise this feature
cannot afford.

Manor used to offer a public cloudflared quick tunnel too, and a Tailscale
tunnel after it. Neither exists now.

## The Manor relay

The relay is a small hosted service (a Cloudflare Worker, `relay/` in this
repo) that both your desktop and your phone dial _out_ to, so there is nothing
to install on either end and no NAT to get through
([ADR-206](decisions/adr-206-relay-transport/index.md)). Your desktop has a
**room** on it, addressed by a hash of a key Manor generates on first use. The
phone opens a **channel** into that room and the relay pipes bytes between the
two. Between them is a Noise `NK` handshake: the phone learns the desktop's
public key from the QR, so it knows it is talking to your desktop and not to the
relay, and every message after that is encrypted end to end.

**To use it.** Settings → Remote control, turn it on, then **Start relay** on the
**Manor relay** card. Turning remote control on only loads what it needs — the
relay's keys, the device check and the bridge. It opens nothing. Starting the
relay is its own action: Manor names what becomes reachable and asks you to
confirm first. Then pair a device and scan the QR; the link looks like
`https://<relay>/app/<version>/#relay=<room>.<key>&t=<token>`, and everything
after the `#` goes to no server. Starting the relay requires remote control to
be on, it is off again after a restart, and it stops when Manor quits.
_Reset relay address_ on the same card generates a new room and new keys: every
link for the old one is dead at once, and every device is revoked. Each
connected browser is closed as revoked _before_ the relay stops, so it shows the
re-pair prompt rather than "not reachable".

If the card says **Can't reach the Manor relay**, the desktop is retrying in the
background and shows why (DNS failure, connection lost); devices cannot connect
until it succeeds. If the stored relay identity ever cannot be read (a restored
backup, a new keychain), Manor makes a new one — a new address — and says so on
the card; every device paired to the old address is revoked, since its link can
no longer find this machine.

**Folder suggestions also go through the relay.** Besides rooms, the relay
serves `POST /jev/folder` ([ADR-211](decisions/adr-211-hosted-jev-proxy/index.md)):
the New Workspace dialog asks it which sidebar folder a new workspace belongs
in, and it asks TypeSafe's Jev with Manor's key. Unlike everything else here,
that route is not blind: it sees your folder and workspace names, the new
workspace's name and branch, and the agent prompt in cleartext, forwards them to
TypeSafe, and doesn't log or store them. Requests are signed with the same relay
key, which is created on first use if remote control never was; that opens no
room. Turn it off with **Suggest folders for new workspaces** in Settings →
General.

**Old devices are dropped.** Devices paired over Tailscale, or at the Watch or
Reply tier, cannot work any more. They are deleted from the devices file the
first time it loads, and must be paired again through the relay.

**Notifications work over the relay.** The phone registers its Web Push
subscription over the bridge (`remoteControl.subscribePush`), and the desktop
sends pushes straight to the browser's push service — the relay is not
involved. See [Notifications](#notifications).

**Version skew.** The relay serves the web app from the origin, one build per
Manor release (`/app/<version>/`). If a link was made by an older Manor, the
page redirects to the build matching your desktop once connected. A version
with no uploaded build (a development build) shows a stated screen telling you
to update Manor, rather than a blank page.

### What the relay can and cannot see

It **can** see: that a room exists and when its desktop is online, which IP
addresses connect to it and when, how many channels are open, the size and
timing of the encrypted messages, and roughly how much traffic a room moves.
It enforces limits from that: 1 MiB per message, 8 channels per room, a daily
byte budget per room, and a join rate limit per IP.

It **cannot** see: your session list, scrollback, keystrokes, layout, the
device token, or anything else inside a channel. It cannot join a room it does
not hold the key for, and it cannot impersonate your desktop to your phone —
the handshake fails.

It does **not** protect against: **whoever serves the page.** The relay's origin
serves the web app's JavaScript, and malicious JavaScript could read the token
or your sessions after they are decrypted. End-to-end encryption protects
against the relay's logs, Cloudflare, and a compromised relay _process_; it
does not protect against a malicious deploy of the page. Anyone who runs their
own relay is trusting themselves; everyone else is trusting whoever deploys
Manor's. The relay and page are deployed only from the release workflow.

If the relay is down, no device can connect. There is no other road.

## Pairing a device

1. **Settings → Remote control**, and turn on the toggle. This loads the runtime;
   nothing is reachable yet.
2. **Start the relay** — the main button on the relay card. Manor names what
   becomes reachable before it starts anything.
3. **Pair a device.** Give it a name. Manor shows a QR code and the link once —
   scan it with the phone, or copy the link. The dialog warns that the device
   can do anything the desktop app can, including removing workspaces, from
   anywhere.
4. On the phone, the page stores the token and immediately strips it out of the
   address bar, so it does not linger in history or in a screenshot of the URL.

The QR code is generated locally. No token is ever handed to a third-party
image service.

## The web app

`/app` is the desktop app itself, served to a browser (ADR-178) — not a
smaller mobile client, the same renderer that runs in the Electron window. It
is served only by the relay's origin, and it reaches Manor over the encrypted
relay channel, authenticated by the device token in the first frame.

You can watch and drive any session from a browser exactly as you would at the
desk, and arrange it too: a split, a new tab, a pin, a close, or a move from
the browser is the same **layout command** the desktop sends, so it is applied
by Manor itself and shows up on the desk a frame later — layout belongs to the
Manor server, not to whichever window changed it
([ADR-179](decisions/adr-179-server-owned-layout/index.md)). A browser sees
every tab in a workspace, including ones popped out into their own window on
the desk — a detached window is just a desktop window's claim on a tab, not a
place the tab moves to. What each window is _looking at_ stays its own:
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
  needs one of those keys.** For that, use the desktop app.

## Knowing whether you are exposed

While the relay is live, a **REMOTE** badge sits in Manor's status bar, visible
from anywhere in the app — not only inside settings. Its tooltip says whether
the relay is reachable and how many devices are connected. Clicking it stops the
relay. If the relay dies on its own, the badge turns red and reads **RELAY
FAILED** rather than continuing to claim you are reachable; while the relay
cannot be reached and Manor is retrying, it turns amber and reads **RETRYING**.

The relay also stops when Manor quits, and when you turn remote control off.

## Notifications

A paired device can subscribe to Web Push, and gets a notification when a
session goes to `requires_input` or `error`. This is the same signal that
drives Manor's dock badge and desktop notifications, so muting _Agent needs
input_ in **Settings → Notifications** mutes the pushes too.

**On an iPhone or iPad, add the page to your Home Screen first.** iOS gives
notifications only to an installed web app — in a Safari tab there is no way to
grant permission at all. Open the paired link, tap Share, then _Add to Home
Screen_, and open Manor from the icon; the pairing dialog says so. On Android and
desktop the page can subscribe from a tab. Either way the page asks with a
button rather than a prompt on load, because Safari only honours the permission
request inside a tap.

Push payloads carry the session name and project only. Scrollback never goes
into a push — a notification reaches your lock screen and is retained by the OS.

## If a token leaks

Revoke that device: **Settings → Remote control → Paired devices → trash icon**.
Revocation takes effect on the next request; nothing caches the device list.
It also cuts that device's **live** connections at once — every open relay
channel — rather than waiting for it to reconnect. Its push subscription goes
with it.

Tokens are per device for exactly this reason — revoking one does not disturb
the others. If you are unsure which device is affected, revoke all of them and
re-pair; pairing takes a few seconds.

If you suspect the machine itself was reached, stop the relay first,
then revoke.

## Deliberately not supported

**Telegram, or any third-party bot channel.** It is the most-demoed feature of
comparable tools, and it means handing a third party a channel that can type
into your shell. Web Push covers the actual need — being told, rather than
checking — without introducing another party to the trust model.

## What is knowingly not protected

- **The app shell is served without authentication.** The pairing token arrives
  in the URL _fragment_, which browsers never send to a server, so the page has
  to load before it can authenticate. Anyone who finds a relay web address gets
  the HTML, CSS, and JavaScript — and nothing else. Reaching a machine takes a
  room key and a token. The `/app` bundle is the whole desktop renderer, so an
  unauthenticated visitor gets a map of what the machine can do, though still no
  data.
- **Scrollback is as sensitive as the sessions themselves.** See the top of
  this document.
## Where things live

| File                        | What                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote-devices.enc`        | Paired devices: label, token hash, relay room, push subscription. Encrypted, 0600.                                                                                |
| `remote-audit.jsonl`        | One line per remote write. No plaintext. 0600, size-rotated.                                                                                                         |
| `remote-vapid.enc`          | Web Push signing key pair. Encrypted, 0600.                                                                                                                         |
| `remote-relay-identity.enc` | The relay identity: an Ed25519 key (proves the room is yours) and an X25519 key (the Noise static key in the QR). Encrypted, 0600. Reset relay address replaces it. |

All four are in Manor's application data directory
(`~/Library/Application Support/Manor` on macOS).

---

The design and its reasoning are in
[ADR-161](decisions/adr-161-remote-control-relay/index.md), the relay in
[ADR-206](decisions/adr-206-relay-transport/index.md), and the removal of
Tailscale, the tiers and the loopback listener in
[ADR-207](decisions/adr-207-remove-tailscale/index.md).
