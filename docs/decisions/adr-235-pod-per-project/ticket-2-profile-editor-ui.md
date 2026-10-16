---
title: Profiles section and profile editor on the Hosts page
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Profiles section and profile editor on the Hosts page

ADR-235 D2. **Prerequisite outside this ADR:** ADR-234 ticket 7 (the
Connect checklist UI in `StartHostForm`).

- `HostsPage.tsx`: add a "Profiles" section, listing each profile (name,
  template, namespace/context summary) with Edit and Remove, and a "New
  profile…" `Button`.
- `StartHostForm.tsx`: add `mode: "host" | "profile"` (default "host"). In
  profile mode:
  - hide the `perHost` fields;
  - add a profile Name field (`EmojiInput`, it is a user-authored name) and
    "Stop when idle for" (Off / 30 / 60 / 120 min, default 60);
  - replace Start with "Save profile", disabled until every check is `ok`;
  - call `hostProfiles.save`.
  Editing pre-fills from the profile.
- Remove confirms with: "Its hosts keep running. They'll no longer be grouped."
- Expose an `openProfileEditor({ onSaved })` entry (a small store or a
  dialog host) so ticket 4 can open it from Add Project and get the new
  profile id back.
- Follow `.claude/rules/ui-components.md`: `Button`, `Tooltip`, `EmojiInput`.
- Component tests in `HostsPage/__tests__`.

## Files to touch
- `src/components/settings/HostsPage/HostsPage.tsx`
- `src/components/settings/HostsPage/StartHostForm.tsx`
- `src/components/settings/HostsPage/ProfileEditorDialog.tsx` (new)
- `src/components/settings/HostsPage/host-settings-text.ts` — copy
- `src/store/host-profile-store.ts` (new) — list/save/remove + editor open state
