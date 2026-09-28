---
title: "CLI: list groups and create a workspace on a chosen host"
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# CLI: list groups and create a workspace on a chosen host

GitHub issue #251. See ADR-192 §5.

- Project listing, in both the CLI and the control route, includes groups, their members, and each member's host.
- `POST /projects/:id/workspaces` accepts an optional `host`. For a grouped project it creates in that host's member.
- Without `--host`, use the caller's own host when it is known (the ADR-189 relay's `callerHostId`), then the group's last-used host.
- A `--host` with no member on that host returns a clear error.
- Add route tests for listing and host selection.

## Files to touch
- `electron/routes/projects.ts`, `electron/mcp/tools-projects.ts`
- The `manor` CLI project and workspace commands
- Route tests

## Notes

- `GET /projects` keeps its array shape; each project's `group` gains
  `members: [{ projectId, name, hostId, host }]`, where `host` is the ssh
  target (or `local`). `host` arguments accept either a host id or a target.
- A relayed remote caller (ADR-189) still only reaches its own host: its
  listing shows only its own host's members, and a `host` naming another
  host is refused with a 403.
- Recording the group's last-used host on a CLI create is left for a
  follow-up: `setGroupLastUsedHost` (#246) was not on main yet.
