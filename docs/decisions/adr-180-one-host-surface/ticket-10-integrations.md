---
title: git, github, linear and remoteControl cross
status: in-progress
priority: high
assignee: opus
blocked_by: [6]
---

# git, github, linear and remoteControl cross

ADR-180 D4/D8. The last group, and the one with the credentials in it:
`git` 6, `github` 10, `linear` 14, `remoteControl` 8 — 31 `ipcMain`
registrations across `ipc/integrations.ts` and `ipc/remote-control.ts`.

## What crosses

`git.*` (stage, unstage, commit, push, discard, stash, diff), `github.*`
(status, PR info, issues, the issue-to-workspace path) and `linear.*` (issue
list, start, close, link, unlink) are ordinary table entries. Every mutating
one goes in `MUTATING`; `git.commit` and `git.push` in particular are exactly
the "moves state the other viewers of this host will see" case that set names.

Credentials never cross. Anything that reads a token out of the keychain
returns the *result* of using it, never the token; check each lifted body for
a return value that carries one and truncate it at the handler, not in the
component.

## `remoteControl`, carefully

`remoteControl.getStatus` is on the table already. The rest —
`setEnabled`, `pair`, `revoke`, `startTunnel`, `stopTunnel` — go in
`LOCAL_ONLY`, keeping ADR-178 ticket 6's read-only-on-web page. The reason is
narrow and worth writing in the table's comment: a stolen `full` token that
can pair more devices is a token that survives its own revocation. That is a
different class of loss from "can remove a workspace", which D3 accepted
knowingly.

Any keychain-backed method stays native in the preload instead of crossing —
ADR-178's "what can never mirror" table names the keychain, and `manorHost`'s
`native` object is where it lives.

## Files to touch
- `electron/bridge/handlers.ts` — ~31 new entries, five `LOCAL_ONLY`, `MUTATING` additions
- `electron/bridge/handlers/integrations.ts` — new, if `handlers.ts` needs splitting
- `electron/ipc/integrations.ts` — lift, delete `register()`
- `electron/ipc/remote-control.ts` — lift, delete `register()`; the pairing path stays reachable from the desktop only
- `electron/preload.ts` — remove the `git`, `github`, `linear` and `remoteControl` namespaces
- `electron/remote-control/__tests__/allowlist.test.ts` — the `LOCAL_ONLY` list now includes pairing

## Folded in from ticket 4

Ticket 6's rule applies: this ticket owns `remoteControl:status`
(`ipc/remote-control.ts`) — delete the legacy send and the matching preload
`on*` in the same commit as the crossing.

## Correction from ticket 8

**`git.*` does not live in `electron/ipc/integrations.ts`.** The seven `git:*`
handlers — `stage`, `unstage`, `discard`, `stash`, `commit`, `push:start`,
`push:cancel` — are in `electron/ipc/branches-diffs.ts`, whose `register()`
ticket 8 thinned down to exactly them. Lift them from there, and delete that
`register()` entirely when you do; `branches-diffs.ts` has no other reason to
exist afterwards.
