---
title: Agents follow the host their terminal actually runs on
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Agents follow the host their terminal actually runs on

GitHub issue #242. See ADR-191 §5.

- `electron/ipc/agents.ts` `isAgentHostConnected`: look up the host that owns
  the agent's pane (`SessionOwners.ownerOf`). Use the project's host only
  when the pane has no owner.
- `electron/agent-persistence.ts`: saved agents record `hostId`. On load, a
  record without one takes its project's host, or local.
- Tests: extend the agents tests. A remote agent is reported disconnected
  when its host drops, and a local agent in the same repo is not. An agent
  whose pane moved hosts follows the new owner.

## Files to touch
- `electron/ipc/agents.ts` and its tests.
- `electron/agent-persistence.ts` and its tests.
