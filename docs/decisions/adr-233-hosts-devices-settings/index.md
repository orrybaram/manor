---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-233: Hosts own their device access; Remote control becomes Devices

## Context

Settings → Hosts and Settings → Remote control describe the same things twice,
on two pages, under different names:

- **Two device lists.** Remote control lists the desktop's paired devices, then
  a section per remote host (`HostPhoneAccess`) with that host's own device
  list. A phone paired with the desktop shows up again in every host's list as
  "via This Mac".
- **Same action, two names.** "Add device" and "Pair a phone" both pair; "Reset
  relay address" and "Reset pairing keys" both reset a room's keys.
- **A host's settings are split.** Its connection status, Stop, Remove and
  "Keep Manor running when X restarts" live on Hosts; its device reach, Linear
  copy, version, relay status and pairing-key warnings live on Remote control.
  The two are joined only by a "Phone access for X" link, and the supervision
  hint ("phones can't reach it…") talks about the other page.
- **Relay status twice.** The desktop status card, and each host's summary line.
- **Host-only pairing.** "Pair a phone" on a host makes a device that reaches
  only that host. Since ADR-228 D9 one pairing with the desktop already reaches
  every host, so this is a second, rarely wanted model the UI has to explain.
- **Add host** is two buttons ("An SSH box", "Start a host") that open two
  different inline forms.

The design exploration (canvas "Hosts & Remote Settings", direction A) settled
on: each host owns everything about itself, including whether devices can
reach it; the remote control page shrinks to the one list of devices.

## Decision

### D1. A host row owns all of the host's settings

`HostsPage` renders one collapsible row per host (this computer first). The
collapsed row shows the icon, name and one plain-text status line, never
badges: connection state, kind, and device reach in words ("devices reach it
anytime", "devices reach it while Manor is open", "devices off"), plus any
pairing-key warning as yellow text ("pairing keys unencrypted"). Expanding
shows, in this order:

- **Device access**
  - Remote host: **Devices can reach \<host\>**: the existing `linkPhones`
    switch (`hostStore.setLinkPhones`), hint "Your N devices reach \<host\>
    directly, so they keep working while this Mac sleeps."
  - **Keep running when \<host\> restarts**: the existing supervision switch
    and its hint text (`host-settings-text.ts`), unchanged in behaviour. Its
    "off" hint now says *devices* instead of *phones*.
  - Warnings from today's `HostSummary`: plaintext keys, key on volume,
    identity reset (cloned). Same docs link.
  - The idle-stop note, the server-view muted line ("Updating…", "Needs the
    host to reconnect") when the server view is not ready.
- **Integrations**: one row per integration; today only **Linear** (the
  existing `setLinearOnHost` switch, shown under the same condition as now:
  this desktop has Linear, or the host already holds a copy).
- **Footer**: Copy ssh command, Stop, Start it again, Wake/Retry (from
  `HostCard`), **Reset pairing keys…** (`hosts.resetPairingKeys`), Remove….

### D2. This Mac is a host row too

This computer's row holds what was Remote control's status card:

- **Devices can reach This Mac**: the remote-control switch (turn on goes
  through `RelayConfirmDialog`, off is immediate), with the status text from
  today's `describe()` (on / turning on / can't reach the relay + Try again),
  `relayNotice`, and the "cannot encrypt stored secrets" warning.
- **Reset pairing keys…** is today's "Reset relay address…"
  (`resetRelayAddress`, `ResetRelayDialog`), renamed so both kinds of host use
  one word.

The main switch therefore only ever governs This Mac; each remote host has its
own switch, which answers the "does the main switch turn off every host?"
question by construction.

### D3. Remote control becomes Devices

The nav item, page title and settings-search entry become **Devices**. The page
type `"remote"` is renamed `"devices"`, nav test id `settings-nav-devices`. The
page holds:

- **Paired devices**: the desktop's devices only (`remote-control-store`), with
  **Add device** and remove (which already revokes on every host, ADR-228 D9).
  `AddDeviceDialog` copy says the device reaches every host that allows
  devices and names them. "Pair and turn on" stays.
- **Open on a paired phone**: the re-entry QR, as today, when live.
- **Hosts your devices can reach** (bottom): one compact row per host (status
  dot, name, kind, reach in words) linking to its row on Hosts via
  `useSettingsNav`, with a count ("2 of 3"). Scrolls inside its card when long.

Removed from the UI: `HostPhoneAccess`, per-host device lists, the "via This
Mac" badge, **Pair a phone** for a single host, and the status card's switch
(moved to D2). The backend for host-only pairing (`hosts.pairDevice`,
`hosts.revokeDevice`) stays; nothing calls it from Settings any more.

### D4. One "Add a host…" wizard

The two buttons become one **Add a host…** button opening a three-step dialog:

1. **Where**: "A machine I can SSH into" or "Start a new host" (Docker,
   Kubernetes or your own script).
2. **Connect** / **Start**: the existing `AddSshHostForm` and `StartHostForm`
   bodies, unchanged in behaviour, laid out for the dialog.
3. **Device access**: the new host's Device access and Integrations groups
   from D1 (same components), shown as the host connects; Done closes the
   dialog and expands the new host's row.

### D5. Unchanged

Behaviour, IPC and stores are untouched: this is a renderer restructure. The
web app stays read-only exactly where it is today (no switches, no add, no
pairing; Wake allowed). `HostCard` keeps serving project settings.

## Consequences

- One place per host, one list of devices, one word per action. The Remote
  control page loses most of its content and its name.
- Devices paired directly with a single host before this change still work but
  are no longer listed anywhere; **Reset pairing keys…** on that host removes
  them. Acceptable: the feature is rarely used and the backend stays, so a list
  can come back if needed.
- The Hosts page grows: an expanded remote host is the longest section in
  Settings. Rows start collapsed, except one reached by a link or just added.
- e2e specs that read the per-host section on Remote control
  (`phone-linked-hosts`, `lid-closed`) move to the Hosts page; test ids are kept
  where the meaning is unchanged so the move is mostly a navigation change.
- Docs (`docs/remote-control.md`, `docs/remote-hosts.md`) need their
  "Settings → Remote control" paths and button names updated.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
