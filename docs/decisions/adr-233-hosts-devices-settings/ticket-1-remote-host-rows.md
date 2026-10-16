---
title: Collapsible remote host rows that own device access and integrations
status: done
priority: high
assignee: opus
blocked_by: []
---

# Collapsible remote host rows that own device access and integrations

ADR-233 D1. Replace `HostEntry` + the "Phone access for X" link with a
collapsible host row on Settings → Hosts that holds every setting of a remote
host, including what lives in `HostPhoneAccess` today.

## What to build

- A `HostRow` (in `src/components/settings/HostsPage/`) for a remote host:
  - **Header** (button toggling expansion, `aria-expanded`): icon, name, one
    plain-text status line built from the host's `useHostDisplay` status plus
    device reach in words ("devices reach it anytime" when `view.linkPhones`
    and supervised, "devices reach it" when linked but not supervised,
    "devices off" when not linked) and any key warning in yellow text
    ("pairing keys unencrypted", "pairing key stored on its disk"). No pills
    or badges. Keep Wake/Retry visible in the header when they apply.
  - **Body** (use `ui/Collapse` if it fits; check its API):
    - Group "Device access":
      - "Devices can reach {name}" switch: today's `host-link-phones-toggle`
        (keep the test id), `hostStore.setLinkPhones`. Hint: "Your N devices
        reach {name} directly, so they keep working while this Mac sleeps."
        N = this desktop's device count (`useRemoteControlStore`).
      - "Keep running when {name} restarts": move the supervision `SettingRow`
        from `HostEntry` verbatim (test ids `host-supervise-toggle`,
        `host-supervisor-status`). In `host-settings-text.ts` change the off
        hint wording from phones to devices.
      - Warnings from `HostPhoneAccess`'s `HostSummary` (plaintext keys, key on
        volume, identity reset), keeping their test ids and docs link.
        Drop the "Manor {version} · N phones · relay…" summary line but keep a
        `host-phone-summary` element holding "Manor {version} · relay
        connected/not connected (error)" in muted text so e2e can still read it.
      - The idle-stop note, and `mutedLine()`'s text when the server status is
        null (test id `host-phone-access-state`).
    - Group "Integrations": the Linear switch from `HostPhoneAccess`
      (`host-linear-toggle`), same visibility rule (`linear.isConnected()` or
      `status.linear`), label "Linear", hint "Copies this Mac's Linear key to
      {name}, so devices can browse and start issues there while this Mac
      sleeps."
    - Footer: Copy ssh command, Stop, Start it again, **Reset pairing keys…**
      (`host-reset-keys`, `ResetRelayDialog` with `hostName`,
      `hosts.resetPairingKeys`), Remove… (`RemoveHostDialog`). Error row as
      today.
  - Keep `data-testid="host-entry"` + `data-host-id` on the row root and give
    the section-like body `data-testid="host-phone-access"` so existing e2e
    locators survive.
  - Refresh the server view on mount (as `HostEntry` and `HostPhoneAccess` both
    do today) and subscribe to Linear connection changes as `HostPhoneAccess`
    does.
- Expansion: collapsed by default. Support opening a given host from a
  section id (`SettingsModal`'s goTo section scroll): a row whose
  `host-${hostId}` section is targeted starts expanded. Look at how
  `useSettingsNav`/section scrolling works in `SettingsModal.tsx` and use the
  section id `host-${hostId}` on the row.
- Read-only web app: same rule as today (status + Wake only; no switches,
  footer actions hidden).
- Delete `HostEntry.tsx` once `HostRow` replaces it. Leave `HostPhoneAccess.tsx`
  in place for now (ticket 3 removes it), but the Hosts page must no longer
  link to it.

Follow `.claude/rules/ui-components.md` (Button, Switch, Link, Tooltip from
`ui/`) and the `react` skill conventions. Use `SettingRow` for switch rows.
Styles go in `HostsPage.module.css`; match the existing settings look.

## Files to touch
- `src/components/settings/HostsPage/HostRow.tsx` — new
- `src/components/settings/HostsPage/HostsPage.tsx` — render `HostRow` per remote host
- `src/components/settings/HostsPage/HostEntry.tsx` — delete
- `src/components/settings/HostsPage/host-settings-text.ts` — phones → devices
- `src/components/settings/HostsPage/HostsPage.module.css` — row styles
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts` — point at `HostRow`, expand before asserting body contents
