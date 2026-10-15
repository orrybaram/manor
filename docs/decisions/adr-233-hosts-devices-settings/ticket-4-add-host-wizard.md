---
title: One "Add a host…" wizard
status: todo
priority: medium
assignee: opus
blocked_by: [1]
---

# One "Add a host…" wizard

ADR-233 D4. Replace `HostsPage`'s `AddHost` section (two buttons, two inline
forms) with one **Add a host…** button opening a three-step dialog.

## What to build

- Button: `data-testid="hosts-add"`, label "Add a host…", hidden in the web app
  as today.
- Dialog (use the same dialog primitive the other settings dialogs use, e.g.
  `RemoveHostDialog`/`RemoteControlDialogs`), with a small step indicator
  "Where · Connect · Device access":
  1. **Where**: two radio cards. "A machine I can SSH into" — "A server, VM or
     another computer. Manor installs itself over SSH and keeps running
     there." / "Start a new host" — "Manor starts it for you: a Docker
     container, a Kubernetes pod, or your own script. Sleeps when idle, wakes
     on demand." Continue / Cancel.
  2. **Connect** (SSH): `AddSshHostForm`'s body (target input, Connect). Or
     **Start**: `StartHostForm`'s body (template picker incl. Custom recipe,
     its fields, Start host). Back returns to step 1. Keep their existing test
     ids (`add-ssh-host-*`, `start-host-*`) and behaviour; refactor them only
     as far as fitting them in the dialog needs (e.g. hide their own Cancel
     row and let the dialog own Back/Cancel).
  3. **Device access**: once `onAdded`/`onStarted` gives a `hostId`, show
     "{name} is ready" (or its live status while connecting) and render the
     Device access and Integrations groups from ticket 1's `HostRow` for that
     host (extract them as components if ticket 1 did not). Done closes the
     dialog and expands that host's row (scroll to section `host-${hostId}`).
- Keep the old `hosts-add-ssh` / `hosts-add-start` test ids on the two radio
  cards so e2e can pick a path.

## Files to touch
- `src/components/settings/HostsPage/AddHostDialog.tsx` — new
- `src/components/settings/HostsPage/HostsPage.tsx` — replace `AddHost`
- `src/components/settings/HostsPage/AddSshHostForm.tsx` — fit in the dialog
- `src/components/settings/HostsPage/StartHostForm.tsx` — fit in the dialog
- `src/components/settings/HostsPage/HostRow.tsx` — export the group components if not already
