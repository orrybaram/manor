---
title: Agents drawer model with unit tests
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Agents drawer model with unit tests

Create the pure function described in ADR-219 Decision §1.

`buildAgentsDrawerModel(input: { agents: (AgentInfo & { projectName: string })[]; statusByPane: Record<string, AgentStatus | undefined>; projects: Pick<ProjectInfo, "id" | "name" | "color">[] })`
returns `{ needsYou: AgentInfo[]; groups: { projectId: string; projectName: string; color: string | null; agents: AgentInfo[] }[] }`.

Rules:
- An agent's status is `agent.paneId ? statusByPane[agent.paneId] : undefined`.
- `needsYou`: status `requires_input`, sorted by `updatedAt` desc.
- `groups`: the remaining agents grouped by `projectId` (fall back to `projectName` as the key when `projectId` is null). Order groups by the index of `projectId` in `projects`; unknown projects go last, alphabetically by name. Inside a group, rank `thinking`/`working` = 0, `error` = 1, everything else = 2, then by `updatedAt` desc. Leave out empty groups.
- `color` comes from the matching project (`ProjectInfo.color`, check the real field name in `src/electron.d.ts`), else null.

Check that the real `ProjectInfo` type exposes `color`. If it is named differently, adapt and mention it in the commit.

Add `agents-drawer-model.test.ts` next to it (vitest, matching other `*.test.ts` in `src/components/phone/__tests__` or colocated, whichever the repo uses). Cover: needs-you split and order, group order follows projects, in-group ranking, empty groups dropped, agent without paneId treated as no status.

## Files to touch
- `src/components/phone/AgentsDrawer/agents-drawer-model.ts` — new
- `src/components/phone/AgentsDrawer/agents-drawer-model.test.ts` — new
