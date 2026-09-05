---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-167: Simplify sidebar workspace indicator states

## Context

Each workspace row in the sidebar (`src/components/sidebar/ProjectItem.tsx`)
carries two indicators:

1. **Agent dot** (left, replaces the branch/folder icon) — `AgentDot` fed by
   `useWorkspaceAgentStatus`. Renders 7 `AgentStatus` values as 8 distinct
   visuals: red spinner (working), yellow breathing spinner (thinking), 👋
   (requires_input), pulsing green dot (responded + unseen), static green dot
   (responded + seen), green checkmark (complete), red dot (error), icon (idle).
2. **PR badge** (right of the branch name) — `PrPopover`. Three colors by
   `pr.state` (open/merged/closed) plus a 6px corner dot that is yellow when
   `unresolvedThreads > 0` and green when open + checks pass + approved + no
   unresolved threads.

Problems observed (ADR-007, 009, 015, 027, 044, 136, 147 each added a state
without revisiting the whole):

- **Agent dot never goes quiet.** `responded` + seen renders a static green dot
  and `complete` renders a checkmark, so rows accumulate green forever with no
  remaining information.
- **Two greens in one row.** Agent "responded" and PR "all green" are the same
  color in different slots with unrelated meanings.
- **Ties hide unread work.** The status hooks pick the first pane at a given
  priority (`p > bestPriority`), so a seen `responded` pane can win over an
  unseen one and suppress the pulse.
- **PR badge is silent on the things that block shipping.** Failing CI,
  "changes requested", and draft status only appear in the hover popover. The
  only badge-level signal is "has unresolved threads", which also fires on
  merged and closed PRs where it is stale.
- **Off-palette glyphs.** 👋 and the checkmark break the dot vocabulary and
  need `width: auto` overrides.

## Decision

Each slot answers exactly one question. **Agent dot: does this workspace need
me?** **PR badge: can this PR ship?** Everything else stays in the popover.

Scope is the sidebar only: the workspace row and the collapsed project header.
Tab bar, pane header, agents list, command palette and the remote client keep
the existing `AgentDot`. Rolling the collapsed vocabulary out to those surfaces
is a follow-up ADR once the sidebar version has lived for a while.

### 1. Agent indicator: 5 states, derived by a pure function

New `src/lib/workspace-indicator.ts`:

```ts
export type WorkspaceIndicatorKind = "thinking" | "working" | "needs_you" | "done_unread";
export type WorkspaceIndicator = { kind: WorkspaceIndicatorKind; pulse: boolean } | null;
export function toWorkspaceIndicator(status: AgentStatus | null, pulse: boolean): WorkspaceIndicator;
```

| Indicator | From `AgentStatus` | Pulse | Visual |
|---|---|---|---|
| `thinking` | `thinking` | never | existing yellow breathing spinner (`SpinnerLoader` variant `thinking`) |
| `working` | `working` | never | existing red spinner (`SpinnerLoader` variant `working`) |
| `needs_you` | `requires_input`, `error` | while unseen (`requires_input` only) | yellow 8px dot |
| `done_unread` | `responded` **and** unseen | always | green 8px dot with ping ring |
| `null` (quiet) | `idle`, `complete`, `responded` + seen, no agent | — | branch / folder icon |

Rules:

- Pulse means exactly one thing: **unread**. A `needs_you` dot stays yellow
  after you have seen it (the agent is still waiting) but stops pulsing.
- `complete` (session ended, `MarkCompleted` in `hook-relay-effects.ts`) has no
  unseen axis in main and clears both unseen sets, so it maps to quiet. The
  "agent finished its turn" signal is `responded`, which is preserved.
- `error` folds into `needs_you`. It has no unseen axis, so it renders as a
  static yellow dot until the agent is closed. The pane/tab still show the red
  error dot via the unchanged `AgentDot`.
- Priority order is inherited from `STATUS_PRIORITY`: needs_you > working >
  thinking > done_unread. That ordering already holds (requires_input 5 >
  working 4 > thinking 3 > error 2 > responded 1).
- The thinking/working distinction is kept on purpose (user decision during
  review): the two spinners tell you whether the agent is reasoning or running
  tools, which is useful at a glance. Because both spinners remain, the
  thinking↔working debounce from ADR-015 stays: `WorkspaceIndicatorDot` wraps
  its input in `useDebouncedAgentStatus`-equivalent logic on the indicator
  kind (500ms, only between `thinking` and `working`).

### 2. Tie-break on unseen in the status hooks

Extract the duplicated pane-scan loop from `useTabAgentStatus`,
`useWorkspaceAgentStatus` and `useProjectAgentStatus` into one exported helper
in `src/hooks/useTabAgentStatus.ts`:

```ts
export function pickBestPaneStatus(
  paneIds: Iterable<string>,
  deps: { paneAgentStatus; agents; unseenRespondedAgentIds; unseenInputAgentIds },
): { status: AgentStatus | null; pulse: boolean }
```

Same priority scan, with one addition: when two panes tie on priority, the one
whose agent is in the matching unseen set wins. This makes the pulse predicate
(ADR-136 §"Change 3") reliable when a workspace has several `responded` panes.
All three hooks call the helper; behavior for tabs changes only in the tie case.

### 3. New `WorkspaceIndicatorDot` component

`src/components/sidebar/WorkspaceIndicatorDot.tsx` + `.module.css`. Takes a
`WorkspaceIndicator` and renders the visual from the table above. Reuses
`SpinnerLoader` unchanged for `thinking` and `working`. Emits `data-testid="workspace-indicator"`,
`data-kind`, `data-pulse` like `AgentDot` does.

`ProjectItem.tsx` uses it in both places that currently render `AgentDot`
(workspace row icon slot at line 127, collapsed project header at line 314):

```tsx
const indicator = toWorkspaceIndicator(workspaceStatus, workspacePulse);
{indicator ? <WorkspaceIndicatorDot indicator={indicator} /> : ws.isMain ? <GitBranch/> : <FolderGit2/>}
```

### 4. PR badge: readiness color, no corner dot

New `src/lib/pr-readiness.ts`:

```ts
export type PrReadiness = "ready" | "blocked" | "pending" | "merged" | "closed";
export function prReadiness(pr: PrInfo): PrReadiness;
```

| Readiness | Condition (evaluated in this order) | Badge |
|---|---|---|
| `merged` | `state === "merged"` | magenta text, magenta-a20 bg, GitMerge icon |
| `closed` | `state === "closed"` | `--text-dim` text, no bg, GitPullRequestClosed icon |
| `blocked` | open and any of: `checks.failing > 0`, `reviewDecision === "CHANGES_REQUESTED"`, `unresolvedThreads > 0` | red text, red-a20 bg |
| `ready` | open, not draft, `checks` non-null with `failing === 0 && pending === 0`, `reviewDecision === "APPROVED"`, no unresolved | green text, green-a20 bg |
| `pending` | every other open PR: draft, checks pending, review required, no data yet | `--text-dim` text, `--hover` bg |

Plus: `isDraft` adds a 1px dashed `currentColor` border to the badge in any
open readiness. The corner dot (`.prBadgeDotWarning` / `.prBadgeDotSuccess`)
is deleted. Popover content is unchanged.

Closed PRs stay visible rather than hidden: a closed-unmerged PR on a live
worktree is itself a prompt to delete the workspace, and hiding the badge would
also remove the only path to the popover.

### 5. Palette contract

Both slots share one meaning per color: **green = good / done**, **yellow =
needs you**, **red = blocked**, **dim = nothing to act on**. Green appears in
both slots only when the agent has replied *and* the PR is ready, which is the
one case where it is the same message.

## Consequences

Better:

- A quiet sidebar is now the normal state. Anything colored is actionable.
- Failing CI, changes requested and draft status become visible without
  hovering.
- One pure function per slot (`toWorkspaceIndicator`, `prReadiness`) with unit
  tests in plain vitest, no DOM. The rendering components are thin.
- Three status hooks share one scan loop; the tie-break bug is fixed in one
  place.
- `useDebouncedAgentStatus` keeps its role (ADR-015) for both `AgentDot` and
  the new sidebar dot, since both still switch between two spinners.

Worse / risks:

- The sidebar and tab bar temporarily speak two dialects: tab shows 👋 and a
  red error dot where the sidebar shows yellow. Deliberate; the follow-up ADR
  unifies them.
- `complete` no longer produces any sidebar signal. Users who relied on the
  checkmark to spot ended sessions lose that; the agents list still shows it.
- `error` renders yellow, not red, and has no unread axis so it never pulses.
  If errored agents turn out to be frequent, a follow-up can add an unseen set
  for errors in main.
- Ready-state depends on `checks` being non-null. Repos without CI never reach
  `ready` even when approved; they sit in `pending`. Acceptable: "ready" should
  mean GitHub will let you press merge.
- `remote-client/main.ts` has its own glyph mapping and is untouched.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
