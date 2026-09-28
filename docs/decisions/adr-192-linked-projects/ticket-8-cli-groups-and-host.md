---
title: "CLI: list groups and create a workspace on a chosen host"
status: todo
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
