---
title: Docs — the full tier, the web app, and CONTEXT.md is now real
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Docs — the full tier, the web app, and CONTEXT.md is now real

## `docs/remote-control.md`

- "What a paired device can do" — a third paragraph for **full**: everything
  the desktop app can, including creating and removing projects and
  workspaces, launching agents, and every pane and tab mutation; the allowlist
  and the "absent, not blocked" guarantee apply to `read` and `send` only;
  every mutating request is audited (route and target, no bodies) and none
  needs a per-request confirmation because the desktop UI's own dialogs are in
  front of it. Say plainly that a leaked `full` token is a leaked machine.
- "Pairing a device" — the three-way choice; `read` is the default; the copy
  the `full` option shows.
- A new short section **"The web app"**: `/app` is the desktop app served to
  a browser (ADR-178); it needs a `full` device; between ADR-178 slices 1 and 2
  it is read-and-type (watch and drive sessions; not split, open tabs or
  create workspaces) — link the ADR so that state is documented rather than
  reported.
- "What is knowingly not protected" — the served `/app` bundle is a much
  larger unauthenticated map of what the machine can do than the remote
  client's 16 KB, though still no data.
- "Where things live" — no change unless ticket 1 changed a file name.

## `docs/agents/domain.md` and `CLAUDE.md`

- Both say `CONTEXT.md` is "not yet authored". It is now. Update the sentence
  in each to point at it and drop the "proceed silently if absent" caveat for
  it (keep the caveat for the general case).

## `docs/decisions/adr-161-remote-control-relay/index.md`

- Do **not** edit the decision. Add a one-line "Amended by ADR-178 (capability
  tiers, web app)" note at the top under status, in whatever form earlier
  amendments in this repo use (see ADR-177's amendment note for the style).

## Files to touch
- `docs/remote-control.md` — full tier, pairing copy, web app section, exposure note
- `docs/agents/domain.md`, `CLAUDE.md` — `CONTEXT.md` exists
- `docs/decisions/adr-161-remote-control-relay/index.md` — amendment pointer
