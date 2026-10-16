---
title: Group profile hosts on the Hosts page and in the status bar
status: todo
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Group profile hosts on the Hosts page and in the status bar

ADR-235 D7.

- Expose `profileId` in host info, if ticket 5 hasn't already.
- `HostsPage.tsx`: hosts with a `profileId` render under a collapsible
  heading per profile, showing the profile name, "N of M running", and Edit /
  Remove (reuse ticket 2's actions). Remember the collapsed state per profile
  in localStorage (try/catch). Hosts with no profile or an unknown profile
  stay in the flat list.
- `HostStatusIndicator.tsx`: one entry per profile, "<profile>: N of M
  running", which expands to its hosts. A host in `error` is still listed on
  its own at the top level.
- A pure grouping helper in `src/lib/` with unit tests.

## Files to touch
- `src/components/settings/HostsPage/HostsPage.tsx`, `HostsPage.module.css`
- `src/components/statusbar/StatusBar/HostStatusIndicator.tsx`
- `src/lib/host-groups.ts` (new) + test
