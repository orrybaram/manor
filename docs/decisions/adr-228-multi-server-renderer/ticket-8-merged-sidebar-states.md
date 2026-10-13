---
title: Merged sidebar labels and away states per source
status: todo
priority: medium
assignee: sonnet
blocked_by: [5, 7]
---

# Merged sidebar labels and away states per source

ADR-228 D3 (groups) and D8 (one sidebar).

## Do
- **Host label on the phone.**
  - Every remote project in the merged sidebar shows its host row
    (`ProjectItem.tsx:319-345`, `HostIndicator`).
  - On the phone, the desktop's own projects are labelled with the
    desktop's name, not "This Mac". The phone isn't that Mac.
  - Derive the name from the server set's hello facts.
- **Groups with the desktop away.** Members show as separate projects under
  their hosts, and nothing claims a group the page can't see. Check
  `buildTopLevelEntries` (`src/utils/sidebar-items.ts:873`) with projects
  that carry no `group`.
- **Away dimming per source.** `groupHostState` and `isHostOffline`
  (`src/lib/host-status.ts:202-224`) take reachability from the server set
  (ticket 5 added the accessor). A host that is reachable only through the
  desktop counts as connected.
- **Component tests** for the three cases:
  - desktop + host, both reachable;
  - host only;
  - desktop only, with the host forwarded through it.

## Files to touch
- `src/components/sidebar/ProjectItem.tsx`,
  `src/components/sidebar/ProjectGroupItem.tsx`,
  `src/components/hosts/HostIndicator.tsx`
- `src/utils/sidebar-items.ts`, `src/lib/host-status.ts`
- tests next to them
