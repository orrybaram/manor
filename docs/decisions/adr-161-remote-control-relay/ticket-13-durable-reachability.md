---
title: Surviving a restart and a rotating hostname
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Surviving a restart and a rotating hostname

This ticket is a decision before it is code, and the decision belongs in the ADR.

ADR-161 says enablement is deliberately not persisted: remote control is off at every
launch, because a setting that silently reopens a listener after an update is the wrong
kind of surprise. That reasoning is sound and should not be discarded. But paired with
the second fact below it produces a feature that cannot survive the situation it exists
for.

**The restart.** The machine reboots, or Manor updates, while you are away. The listener
does not come back. There is no way to turn it back on except by walking to the machine —
which is the exact thing the feature was built to avoid.

**The hostname.** A cloudflared quick tunnel is assigned a fresh hostname every start. A
new hostname is a new origin, and a new origin means the phone's `localStorage` token is
gone, its push subscription is gone, and — once ticket 10 lands — its Home Screen install
points at nothing. So even after re-enabling by hand you must re-pair every device.
Tailscale does not have this problem, which is one more reason it is preferred, but it is
not universal.

Two threads, both needed:

**A stable address.** Support a *named* cloudflared tunnel — a user-configured hostname
they already own — alongside the quick tunnel. Detect which is configured; keep the quick
tunnel as the zero-setup path and be explicit in the UI that its address is both public
and temporary. Tailscale stays the recommended default.

**A bounded exception to the no-persist rule.** Not a plain "remember this setting"
checkbox. Something whose failure mode is visible and finite — the shapes worth weighing:
an explicit "keep remote control on across restarts" that expires after a stated window;
restoring the listener but never the tunnel; or restoring both but requiring the exposure
badge to be acknowledged on next launch. Whatever is chosen, the ADR's §"Enablement is
not persisted" must be amended rather than contradicted, and `docs/remote-control.md`
must say plainly what now survives a restart.

Do not implement the persistence half until the shape is agreed. The named-tunnel half is
independent and can land first.

Tests: a named tunnel is preferred over a quick tunnel when configured; the quick tunnel's
temporary-address warning is present in the confirmation; whatever persistence lands is
covered by a test that a fresh launch does **not** start a tunnel.

## Files to touch

- `electron/remote-control/tunnel.ts` — named tunnel support and detection.
- `electron/remote-control/controller.ts` — restore policy, if any.
- `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx` — the
  configuration and the confirmation copy.
- `docs/decisions/adr-161-remote-control-relay/index.md` — amend the persistence section.
- `docs/remote-control.md` — what survives a restart.
