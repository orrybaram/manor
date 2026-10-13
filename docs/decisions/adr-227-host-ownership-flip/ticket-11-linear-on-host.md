---
title: "\"Use Linear on <host>\" opt-in"
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [5, 7]
---

# "Use Linear on \<host\>" opt-in

ADR-227 D7 (Linear).

## Do
- **Token path.** `LinearManager` (`electron/linear.ts:65-79`) takes its
  token path as a constructor parameter. The desktop passes
  `linearTokenFile()`; the host passes `hostServerPaths().linearToken` (new
  in `electron/paths.ts`).
- **Owner method.** Add `hostServer.setLinearToken(token: string | null)`,
  with `localOnly` and `secretFirstArg` (mirror `setVapidKeys`,
  `electron/host-server/handlers.ts:370-373`). Behavior:
  - a token calls `linearManager.saveToken`;
  - `null` calls `clearToken`.
  
  `hostServer.status()` gains `linear: boolean`.
- **Reset deletes the copy.** `hostServer.resetIdentity` also clears the
  Linear token (see the comment at `handlers.ts:342-348`).
- **`HOST_TABLE` allows `linear.*`** (read, `startIssue`, `closeIssue`,
  `proxyImage`, `autoMatch`), minus `connect` and `disconnect`. While no
  token is stored, every `linear.*` call answers
  `unavailable:host` with the message "Linear isn't turned on for \<host\>".
- **Desktop method.** Add `hosts.setLinearOnHost(hostId, on)` (localOnly) in
  `electron/bridge/handlers/hosts.ts`. It reads the desktop's Linear token
  and calls `hostServer.setLinearToken` through the host's client.
- **Settings toggle.** Add a **"Use Linear on \<host\>"** toggle to
  `src/components/settings/HostPhoneAccess.tsx`. Show it only when the
  desktop is connected to Linear. Explain in one line that the token is
  copied to the host.
- **Desktop calls stay on the desktop.** Linear calls for remote projects on
  the desktop don't route.
- **Docs.** Document the Linear MCP alternative in `docs/` (the remote-hosts
  doc) as the no-token-on-box option.
- **Tests:**
  - set, clear, and reset clears
  - unavailable until set (host-server harness)
  - the `hosts.setLinearOnHost` handler

## Files to touch
- `electron/linear.ts`
- `electron/paths.ts`
- `electron/host-server/handlers.ts`
- `electron/server/create-manor-server.ts`
- `electron/bridge/handlers/hosts.ts`
- `electron/bridge/local-only.ts`: add `hosts.setLinearOnHost`.
- `src/components/settings/HostPhoneAccess.tsx`
- `electron/host-server/__tests__/relay-room.test.ts`, or a new
  `linear-on-host.test.ts`
- `docs/` (the remote hosts page)
