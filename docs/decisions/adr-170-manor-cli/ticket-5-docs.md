---
title: Document the manor CLI in AGENT-SYSTEM.md and README
status: in-progress
priority: medium
assignee: haiku
blocked_by: [4]
---

# Document the `manor` CLI in AGENT-SYSTEM.md and README

## Implementation

1. `docs/AGENT-SYSTEM.md` §10.4 "MCP server": rename the heading to
   "MCP server and `manor` CLI". Add a paragraph:
   - `~/.manor/bin/manor` is installed on startup by `ensureManorCli`
     (`electron/manor-cli-install.ts`) and `~/.manor/bin` is prepended to `PATH` in every
     Manor terminal (`electron/terminal-host/session.ts`).
   - Subcommands are generated from the same `ToolModule` definitions the MCP server
     serves (`electron/mcp/cli.ts`): `list_projects` → `manor list-projects`,
     `projectId` → `--project-id`. `manor --help` lists them; `manor <cmd> --help` shows flags.
   - `manor api <METHOD> <path> [--body json]` hits the control server directly.
   - Agents running inside a Manor terminal should prefer the CLI over the MCP tools to
     avoid loading the tool roster into context; the MCP tools remain for inline
     screenshots and typed multi-line arguments.
   - Note `manor-webview` (ADR-053) was removed and is deleted from disk on startup.
2. `README.md`: add a short "Agent CLI" subsection with three example invocations
   (`manor --help`, `manor list-projects`, `manor screenshot-webview`) and the one-line
   generation rule. Keep it under 15 lines.
3. Link ADR-170 from both places.

## Files to touch
- `docs/AGENT-SYSTEM.md` — §10.4
- `README.md` — new subsection
