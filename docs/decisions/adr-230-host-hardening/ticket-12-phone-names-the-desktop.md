---
title: The phone names the desktop instead of "This machine"
status: todo
priority: low
assignee: sonnet
blocked_by: []
---

# The phone names the desktop instead of "This machine"

ADR-230 D12 (gap R8).

## What to build

- **`src/bridge/server-set.ts`**, beside `serverHostName` (:416-437):
  - `memberDisplayName(hostId, hosts)` returns
    `serverHostName(hostId) ?? memberHostName(hostId, hosts)`;
  - `hostSentenceName(hostId, hosts)` returns the lowercase sentence form:
    the `serverHostName` result, or `hostLabel` from `src/lib/hosts.ts:60`;
  - a `useMemberDisplayName(hostId)` hook on top of `useServerHostName`, so
    components update when pairings change.

  `src/lib/hosts.ts` must not import `bridge/server-set`; keep the
  layering.
- **Switch every site over:**
  - `src/store/auto-join.ts:40`
  - `src/store/project-store.ts:946`, `:1021`, `:1077`
  - `src/components/sidebar/ProjectItem.tsx:176`, `:518`. Leave `:451`,
    which is already correct; just use the new helper there if it's
    simpler.
  - `src/components/settings/ProjectSetUpOnSection.tsx:48`
  - `src/components/settings/ProjectSettingsPage.tsx:632`
  - `src/components/hosts/CloneToHostDialog.tsx:131`
  - `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx:289`
  - `src/components/tasks/TasksView.tsx:139`
  - Run `grep -rn "memberHostName\|hostLabel" src` for any other UI call
    site, and switch those too.
- On the desktop, `serverHostName` is null, so the strings stay "This
  machine" and "this machine". Existing desktop test expectations must not
  change.

## Tests (each must fail on the base commit)

Use the model in `src/lib/__tests__/transfer-targets.test.ts:64-84`:
`localStorage` stub, `upsertPairing`, `recordPairingHello`, `servers.add(…,
{home: true})`. With it:
- `src/store/__tests__/auto-join.test.ts`: on a phone, the label names the
  desktop.
- `src/store/__tests__/project-store-transfer.test.ts`: the transfer toast
  names the desktop.
- A unit test for `memberDisplayName` and `hostSentenceName` on the phone and
  on the desktop.

## Files to touch
- `src/bridge/server-set.ts`
- The files listed above
- Tests named above.
