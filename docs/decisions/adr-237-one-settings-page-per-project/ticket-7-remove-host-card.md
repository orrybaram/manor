---
title: Remove HostCard and dead settings CSS
status: todo
priority: medium
assignee: haiku
blocked_by: [5, 6]
---

# Remove HostCard and dead settings CSS

ADR-237 D3. After ticket 5 nothing renders `HostCard` or `HostCardRow`.
Only `CopySshCommand` from that file is still used, by
`src/components/settings/HostsPage/HostRow.tsx`.

1. Create `src/components/hosts/CopySshCommand.tsx` holding
   `CopySshCommand` and `COPIED_MS` exactly as they are in `HostCard.tsx`,
   importing `styles` from a new `CopySshCommand.module.css` that holds
   only `.buttonIcon`. Delete `HostCard.tsx` and `HostCard.module.css`.
   Update the import in `HostRow.tsx`.
2. `src/components/hosts/HostStatusDetails.tsx`: delete `LocalHostDetails`
   (its only user was `HostCard`). Check with `grep -rn LocalHostDetails src`
   first.
3. `src/components/settings/SettingsModal/SettingsModal.module.css`: delete
   the `.linkedMemberList`, `.linkedMemberRow`, `.linkedMemberRow:last-child`,
   `.linkedMemberIcon`, `.linkedMemberText`, `.linkedMemberHost`,
   `.linkedMemberPath`, `.memberHeading`, `.memberHeadingOn`,
   `.memberHeadingIcon` rules and their comments. Confirm each is unused
   with `grep -rn "<name>" src` before deleting.
4. `src/lib/hosts.ts`: a comment mentions `ProjectHostSection`; change it
   to `ProjectHostsSection`. `grep -rn "ProjectHostSection\|ProjectSetUpOnSection\|HostCard" src docs/agents` and fix any other stale
   reference outside `docs/decisions/`.

## Files to touch
- `src/components/hosts/CopySshCommand.tsx` — new (moved)
- `src/components/hosts/CopySshCommand.module.css` — new (moved)
- `src/components/hosts/HostCard.tsx` — delete
- `src/components/hosts/HostCard.module.css` — delete
- `src/components/hosts/HostStatusDetails.tsx` — drop `LocalHostDetails`
- `src/components/settings/HostsPage/HostRow.tsx` — import path
- `src/components/settings/SettingsModal/SettingsModal.module.css` — dead rules
- `src/lib/hosts.ts` — comment

## Acceptance
- `pnpm typecheck`, `pnpm test` (vitest + knip) pass.
- `grep -rn "HostCard\|linkedMember\|memberHeading\|navItemNested2\|LocalHostDetails" src` prints nothing.
