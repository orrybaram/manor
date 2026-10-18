---
title: "Fix: paste toasts name a relayed server by its room id"
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Fix: paste toasts name a relayed server by its room id

Found in evidence capture. A paired browser pasting an unsupported image saw **"Couldn't paste image to eM9lxkUy7Y_-YKQvzyl-kW"**. That is the relay room id, not the machine's name ("Mac").

**Cause.** `hostLabel` in `src/lib/remote-image-paste.ts` (around line 29) names a host only from `useHostStore`. On the web, a server's own panes are stamped with the room id, which has no label in the store. Commit d078efb6 fixed the same naming in the sidebar and the host chip by preferring `serverHostName` from `src/bridge/server-set.ts`.

**Fix.** In `hostLabel`, return `serverHostName(hostId)` when it is non-null. Otherwise keep today's behaviour: the host store's `hostName`, else the id. `serverHostName` is a plain function, not a hook, so it is safe here. Check that importing `../bridge/server-set` from `src/lib` creates no cycle or layering problem; `src/lib/workspace-host-choices.ts` and similar files may already import it.

**Test.** In `src/lib/__tests__/remote-image-paste.test.ts`, mock `../../bridge/server-set`'s `serverHostName` to return "Mac" for the pane's host. Assert that the error toast reads "Couldn't paste image to Mac". The existing cases, where it returns null, must keep their current labels.

## Files to touch
- `src/lib/remote-image-paste.ts`
- `src/lib/__tests__/remote-image-paste.test.ts`
