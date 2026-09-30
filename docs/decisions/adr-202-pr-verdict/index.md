---
type: adr
status: proposed
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

# ADR-202: One PR verdict — readiness, stage and blocker from one call

Builds on ADR-167 (sidebar indicator states: the readiness order),
ADR-194 §1 (Needs you tiers) and ADR-198 §2 (Studio: PR stages, card context).
Candidate 4 of the 2026-09-30 architecture review.

## Context

The order in which a PR's blockers are checked (conflicts → failing checks →
changes requested → unresolved threads) is written four times. Only comments
keep the copies in step:

| Copy | Where | What it does with the order |
| --- | --- | --- |
| `isBlocked` | `src/lib/pr-readiness.ts` `prReadiness` | Decides whether the PR is blocked at all |
| `blockedReason` | `src/lib/home-dashboard.ts:96` | Returns the first cause as a string ("conflicts", "3 unresolved threads") |
| `blockedContext` | `src/lib/home-dashboard-studio.ts:225` | Returns the first cause as a Needs you card context ("in `blockedReason`'s order") |
| `badgeIcon` | `src/components/sidebar/PrPopover.tsx:324` | Picks the icon and tone ("Mirrors the order `prReadiness` blocks on") |

Two more functions depend on readiness without holding the order themselves.
`prStage` (studio) turns readiness into a pipeline column. `badgeIcon`'s
default branch repeats `prStage`'s "checks still pending" test to show the
clock icon. No test checks that the four copies agree. For example, if
`blockedReason` and `blockedContext` disagree about a PR with both conflicts
and failing checks, its Needs you card shows one blocker in its header and
another in its body.

The colours disagree as well. A blocked PR is red in `PR_STAGE` (pipeline
column, Open PRs stat bar) and yellow in `TIER_COLOR` (Needs you card accent).
The sidebar badge background is yellow, and its icon tone depends on the
blocker: red for conflicts and failing checks, yellow for changes requested
and threads. The user chose to make that per-blocker tone the rule everywhere
(see Decision §4).

## Decision

### 1. `prVerdict(pr)` is the only place the order lives

`src/lib/pr-readiness.ts` gains the verdict and becomes the owner of the PR
stage vocabulary:

```ts
export type PrStage = "checks" | "review" | "blocked" | "ready";
export const PR_STAGES: readonly PrStage[] = ["checks", "review", "blocked", "ready"];

export type PrBlocker =
  | { kind: "conflicts" }
  | {
      kind: "checks";
      failing: { name: string; url: string | null }[]; // named failing runs; may be fewer than failingCount
      failingCount: number;
      passing: number;
      total: number;
    }
  | { kind: "changes-requested" }
  | { kind: "threads"; count: number };

export type PrVerdict =
  | { readiness: "blocked"; stage: "blocked"; blocker: PrBlocker }
  | { readiness: "merged" | "closed"; stage: null; blocker: null }
  | { readiness: "ready" | "queued" | "review" | "pending"; stage: Exclude<PrStage, "blocked">; blocker: null };

export function prVerdict(pr: PrInfo): PrVerdict;
```

- The body walks the ADR-167 order once: merged → closed → blocker
  (conflicts → checks → changes-requested → threads; the first match *is* the
  blocker) → queued → review → ready → pending. Readiness results are
  unchanged.
- `stage` is ADR-198 §2 unchanged. blocked → `blocked`; ready and queued →
  `ready`; review → `review`; pending with `checks.pending > 0` → `checks`;
  any other pending → `review`. Merged and closed PRs get `null`.
- `prReadiness(pr)` stays as `prVerdict(pr).readiness`, because `openPrRows`
  (owned by the Task-list workspace, which is deleting it) still calls it.
  No new code should call it.

### 2. Blocker metadata is chosen once

In the same module, one record keyed by blocker kind:

```ts
export const PR_BLOCKER: Record<PrBlocker["kind"], { title: string; tone: "bad" | "warn" }> = {
  conflicts:           { title: "Conflicts",          tone: "bad"  },
  checks:              { title: "Checks failing",     tone: "bad"  },
  "changes-requested": { title: "Changes requested",  tone: "warn" },
  threads:             { title: "Unresolved threads", tone: "warn" },
};
export function blockerLabel(b: PrBlocker): string; // "conflicts" | "checks failing" | "changes requested" | "N unresolved thread(s)"
```

`title` is the Needs you card header. `blockerLabel` is the inline reason
used by rows, `NeedsYouItem.reason` and the workspace popover. Because the
record is keyed by `PrBlocker["kind"]`, adding a blocker kind is a type error
until every surface handles it.

### 3. Surfaces read the verdict

- **home-dashboard.ts**: `needsYouItems` calls `prVerdict` once per PR and
  takes its tier and reason from the verdict. `blockedReason(pr)` stays a
  one-line delegate (`blocker ? blockerLabel(blocker) : "blocked"`) only
  because `openPrLabel` calls it. `openPrRows`, `openPrLabel` and the Up next
  functions are not touched.
- **home-dashboard-studio.ts**: `prStage` and `blockedContext` are deleted.
  `PrStage` and `PR_STAGES` move to `pr-readiness.ts`, and their importers
  (`pr-stage.ts`, `StatTiles.tsx`, `WorkspacePopover.tsx`, `PipelineStage.tsx`)
  import from there. `NeedsYouCardContext` embeds `PrBlocker` directly
  (`{kind:"input"} | {kind:"error"…} | PrBlocker | {kind:"finished"…} | {kind:"ready"…}`),
  so a blocked card's context is `verdict.blocker`. `prPipeline`,
  `pipelineLabel` and `projectTiles` use `verdict.stage` and
  `verdict.blocker`.
- **PrPopover.tsx**: `badgeIcon(verdict, pr)` switches on `verdict.readiness`.
  Blocked PRs use a `Record<PrBlocker["kind"], Icon>`, with the tone from
  `PR_BLOCKER[kind].tone` (`bad` → `prIconBad`, `warn` → `prIconWarn`). The
  pending clock comes from `verdict.stage === "checks"`. The badge gets a
  `data-blocker` attribute. `SummaryRows` lists every fact rather than the
  first blocker, so it has no order to share and stays as it is.
- **needs-you-labels.ts**: `KIND_LABEL`'s four blocker entries come from
  `PR_BLOCKER[kind].title`. A new `cardColor(card)` replaces direct
  `TIER_COLOR` use in `NeedsYouCard.tsx`. A blocked PR card takes
  `TONE_COLOR[PR_BLOCKER[context.kind].tone]` (`bad` → `var(--red)`,
  `warn` → `var(--yellow)`); every other tier keeps its ADR-194 colour.
- **pr-stage.ts**: unchanged apart from the import. The blocked column and
  stat bar stay red, because yellow already means "checks running" there.
- **WorkspacePopover.tsx**: `prVerdict(pr)` replaces
  `prStage` + `blockedReason`.

### 4. Colour rule (user decision, 2026-09-30)

Each blocker kind has one tone, set in `PR_BLOCKER`: conflicts and failing
checks are **bad** (red); changes requested and unresolved threads are
**warn** (yellow). The badge icon and the Needs you card accent both follow
it. Stage colours in `PR_STAGE` still colour the pipeline column and stat
bar, where blocked stays red. The sidebar badge background stays ADR-167
yellow for every blocked PR.

Visible change: a Needs you card for a PR with conflicts or failing checks
turns from yellow to red. Cards for changes requested or threads stay yellow.

### 5. Tests: replace, don't layer

- New `src/lib/__tests__/pr-verdict.test.ts`: one `it.each` table from a
  `PrInfo` fixture to the whole `PrVerdict` (readiness, stage, blocker with
  details), with every current `pr-readiness.test.ts` case, the `prStage`
  cases and the blocker precedence pairs (conflicts + checks,
  checks + changes, changes + threads, queued + failing), plus
  `blockerLabel` singular/plural.
- Delete `src/lib/__tests__/pr-readiness.test.ts` and the `prStage` describe
  block in `home-dashboard-studio.test.ts`. Remove the conflicts-over-threads
  precedence assertion in `home-dashboard.test.ts` (around line 257).
  Surface tests keep only what they add: grouping, dedupe, ranking and
  wiring.
- Surfaces: the repo has no component-render tests, so rendering is covered
  by typecheck (exhaustive `Record`s) and one small pure test for
  `cardColor` in `needs-you-labels`.

## Consequences

**Better**
- The blocker order is written once, and one table-driven test covers it. The
  surfaces can't drift apart: the header, body, icon and label all come from
  the same `blocker`.
- Colour follows a single rule set in one module. A new blocker kind won't
  compile until it has a title, tone, icon and label.
- `pr-readiness.ts` becomes a deep module: one call returns everything the
  four surfaces need.

**Worse / risks**
- `NeedsYouCardContext` changes shape slightly: blocked kinds now come from
  `PrBlocker`, with the same field names as today's `checks`, `threads` and
  the rest. `CardContext.tsx` and `fix-pr-prompt.ts` should compile
  unchanged; any that don't are updated.
- `blockedReason` and `prReadiness` live on as thin delegates until the
  Task-list workspace deletes `openPrRows`. After that merge, remove
  `blockedReason` if it has no callers left.
- A merge conflict is expected in `home-dashboard.ts` with the Task-list
  workspace (imports and the `needsYouItems` body next to its deletions).
- The ADR number may collide with sibling workspaces' ADRs written today. Renumber at merge if so.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
