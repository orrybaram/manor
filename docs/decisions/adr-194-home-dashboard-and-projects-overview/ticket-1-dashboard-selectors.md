---
title: Pure dashboard selectors with tests
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Pure dashboard selectors with tests

ADR-194 §1–§2. Create `src/lib/home-dashboard.ts`: pure functions, no store or
React imports (types only). The UI tickets wire store state into these.

## Functions

- `needsYouItems(input): NeedsYouItem[]`
  - input: `{ projects: ProjectInfo[]; agents: AgentInfo[]; paneAgentStatus:
    Record<string, PaneAgentStatus>; unseenRespondedAgentIds: Set<string> }`
  - `NeedsYouItem` is a discriminated union:
    - `{ kind: "agent"; tier: "input" | "error" | "finished"; agent; project; workspace? }`
    - `{ kind: "pr"; tier: "blocked" | "ready"; pr; project; workspace; reason: string }`
  - Tier order and within-tier ordering exactly as ADR §1.
  - Agents come from `agents` with a `paneId` whose `paneAgentStatus` is
    `requires_input` / `error` / (`responded` and id ∈ unseen). Skip agents
    with no `projectId` (Home agents).
  - Resolve the project via `agentWorkspaceKey` + `projectForWorkspaceKey`,
    wrapped in try/catch because `workspaceKey` throws on bad input.
  - PR `reason` for blocked, taking the first that applies: "conflicts",
    "checks failing", "changes requested", "N unresolved threads". Read
    `src/lib/pr-readiness.ts` for the field names.
  - Only `pr.state === "open"`. Dedupe by `pr.url`.
- `runningAgentCount(agents, paneAgentStatus): number`: panes in `thinking` or
  `working` that belong to a live agent (`status === "active"`), counted once
  per pane.
- `openPrCount(projects): number`: open PRs deduped by url.
- `normalizeIssueRef(id | identifier | url)` and
  `isIssueLinked(issue: { url: string; number?: number }, projects): boolean`.
  Match by URL, or by number across `gh-12` / `12` / `#12` (see ADR §1).
- `rankUpNext(issues: UpNextIssue[], projectOrder: string[]): UpNextIssue[]`
  - `UpNextIssue = { source: "github" | "linear"; projectKey: string; number?:
    number; identifier: string; title: string; url: string; labels: string[];
    raw: unknown }`
  - Drop linked issues first (the caller passes them already filtered, or pass
    `projects` in; your choice, keep it pure).
  - Order: `ready-for-agent` label first, then `projectOrder` index, then lowest
    number / identifier.
- `projectCardSummary(entry: TopLevelEntry<ProjectInfo>, deps): ProjectCardSummary`
  - `deps` holds the same inputs as `needsYouItems`, plus
    `hostName(hostId) => string`.
  - Returns `{ key, name, color, hostLabel, path, needsYou, workspaceCount,
    runningAgents, openPrs, pending: { name: string; tier; label: string }[] }`.
  - `pending` is at most 3 items, ranked by the Needs-you tiers.
  - For a group: aggregate across `sections`. Path comes from the
    `group.lastUsedHostId` member, falling back to the first. `hostLabel` is the
    member host names joined with " + ".

Reuse `prReadiness`, `buildTopLevelEntries` types, `agentWorkspaceKey`,
`projectForWorkspaceKey` and `workspaceKey` rather than re-implementing them.

## Tests

`src/lib/__tests__/home-dashboard.test.ts` (Vitest, same style as
`pr-readiness.test.ts`, with `basePr` factories). Cover:

- tier order
- within-tier order
- Home agents excluded
- PR dedupe
- linked-issue matching across the three id forms
- `rankUpNext` ordering
- a group card aggregating two members
- a card with nothing pending

## Files to touch
- `src/lib/home-dashboard.ts` — new
- `src/lib/__tests__/home-dashboard.test.ts` — new

Run `pnpm test:unit` and `pnpm exec tsc --noEmit -p tsconfig.json` before
committing.
