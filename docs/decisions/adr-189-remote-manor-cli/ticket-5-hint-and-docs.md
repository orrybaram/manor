---
title: Remote SessionStart hint and docs
status: in-progress
priority: low
assignee: haiku
blocked_by: [1, 2, 3, 4]
---

# Remote SessionStart hint and docs

See ADR-189 §5.

- `electron/scripts/agent-hook.js`: when `process.env.MANOR_CONTROL_PORT_FILE` is set, print a remote variant of `SESSION_START_HINT`:
  - Start with "This terminal runs on a remote host managed by Manor. The `manor` CLI is on PATH for managing projects, workspaces, folders, issues and agents: run `manor --help`."
  - Keep the batch-create-workspaces and list-agents guidance.
  - Add "Pane, browser and system commands aren't available from remote hosts."
  - Drop the mcp__manor__ sentence.
  - The local hint is unchanged. Update the hook-script tests if they assert the hint.
- `docs/remote-hosts.md`:
  - add `~/.manor/bin/manor` and `~/.manor/remote/control-port` to the file table;
  - add a short "The `manor` CLI" section: it relays through the daemon over the ssh connection, only works while the laptop is connected, lists the allowed command areas (see ADR-189's allowlist), and says other commands return "isn't available from remote hosts";
  - fix the "What isn't supported" line so it says Remote MCP isn't supported and the CLI is limited to the allowlist.

## Files to touch
- `electron/scripts/agent-hook.js` — remote hint variant
- `docs/remote-hosts.md` — CLI section, file table, unsupported list
- agent-hook script tests if they cover the hint
