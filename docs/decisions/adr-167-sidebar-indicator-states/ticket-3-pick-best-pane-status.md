---
title: Extract pickBestPaneStatus with unseen tie-break
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extract `pickBestPaneStatus` with unseen tie-break

Three hooks duplicate the same pane-scan loop:

- `src/hooks/useTabAgentStatus.ts` (lines ~30–62)
- `src/hooks/useWorkspaceAgentStatus.ts` (lines ~19–52)
- `src/hooks/useProjectAgentStatus.ts` (lines ~20–58)

Extract it into one exported helper in `src/hooks/useTabAgentStatus.ts`
(next to `STATUS_PRIORITY`, which stays exported):

```ts
export type PaneStatusDeps = {
  paneAgentStatus: Record<string, AgentState | null | undefined>;
  agents: AgentInfo[];
  unseenRespondedAgentIds: Set<string>;
  unseenInputAgentIds: Set<string>;
};

export function pickBestPaneStatus(
  paneIds: Iterable<string>,
  deps: PaneStatusDeps,
): { status: AgentStatus | null; pulse: boolean };
```

Behavior must match the current loop exactly, with one addition:

**Tie-break on unseen.** Today the scan uses `p > bestPriority`, so among
panes with equal priority the first one wins. Change it so that when
`p === bestPriority` and the current best is *not* unseen but the candidate
*is*, the candidate replaces it. "Unseen" for a candidate means: its agent id
is in `unseenRespondedAgentIds` when status is `responded`, or in
`unseenInputAgentIds` when status is `requires_input`. Keep the existing pulse
predicate (ADR-136 §"Change 3") computed from the final winner.

Return `{ status: null, pulse: true }` when no pane has a status (same as today).

Then make all three hooks call the helper:

- `useTabAgentStatus`: `pickBestPaneStatus(allPaneIds(tab.rootNode), deps)`
- `useWorkspaceAgentStatus`: collect pane ids across `layout.panels[*].tabs[*].rootNode`, then one call
- `useProjectAgentStatus`: collect pane ids across every workspace layout, then one call

Keep each hook's `useMemo` deps unchanged.

Add `src/hooks/__tests__/pickBestPaneStatus.test.ts` (vitest, no DOM, no
React). Build `AgentInfo` fixtures with the minimal fields the helper reads
(`id`, `paneId`, `status`, `lastAgentStatus`). Cases:

- empty → `{ status: null, pulse: true }`
- higher priority wins regardless of order
- two `responded` panes, first seen, second unseen → winner is the unseen one and `pulse === true`
- two `responded` panes, both seen → `pulse === false`
- two `requires_input` panes, second unseen → `pulse === true`
- live status with no agent record counts and yields `pulse === true`

Run `pnpm vitest run src/hooks src/store` and `pnpm typecheck` (or the
project's equivalent in `package.json`) and make them pass.

## Files to touch
- `src/hooks/useTabAgentStatus.ts` — add and export `pickBestPaneStatus`, use it
- `src/hooks/useWorkspaceAgentStatus.ts` — use the helper
- `src/hooks/useProjectAgentStatus.ts` — use the helper
- `src/hooks/__tests__/pickBestPaneStatus.test.ts` — new tests
