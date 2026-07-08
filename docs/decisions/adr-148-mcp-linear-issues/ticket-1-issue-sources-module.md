---
title: Add issue-sources normalization module
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add issue-sources normalization module

Create a pure, Electron-free module that owns the cross-source issue shape and the
GitHub↔Linear state-vocabulary translation. No I/O, no `electron` imports — only
`import type` from `./github` and `./linear`.

## Contract

```ts
export type IssueSource = "github" | "linear";
export type IssueState = "open" | "closed" | "all";

export interface McpIssue {
  source: IssueSource;
  id: string;    // lookup key: "42" | "ENG-123"
  ref: string;   // display ref: "#42" | "ENG-123"
  title: string;
  url: string;
  state: string;
  labels: string[];
}

export interface McpIssueDetail extends McpIssue {
  body: string | null;
  assignees: string[];
}

export function isIssueSource(v: unknown): v is IssueSource;
export function parseIssueState(v: string | null): IssueState;  // default "open"
export function linearStateTypes(state: IssueState): string[];

export function normalizeGitHubIssue(i: GitHubIssue): McpIssue;
export function normalizeLinearIssue(i: LinearIssue): McpIssue;
export function normalizeGitHubIssueDetail(i: GitHubIssueDetail): McpIssueDetail;
export function normalizeLinearIssueDetail(i: LinearIssueDetail): McpIssueDetail;
```

Mapping rules:

- **GitHub** — `id: String(i.number)`, `ref: "#" + i.number`, `state: i.state`,
  `labels: i.labels.map(l => l.name)`. Detail adds `body: i.body`,
  `assignees: i.assignees.map(a => a.login)`.
- **Linear** — `id: i.identifier`, `ref: i.identifier`, `state: i.state.name`,
  `labels: i.labels.map(l => l.name)`. Detail adds `body: i.description`, and
  `assignees: i.assignee ? [i.assignee.displayName] : []` (Linear has at most one assignee).
- **`linearStateTypes`** —
  - `open` → `["triage", "backlog", "unstarted", "started"]`
  - `closed` → `["completed", "canceled"]`
  - `all` → all six of the above, in that order.

Guard against missing arrays: GitHub's `gh` output can omit `labels`/`assignees`. Coalesce
to `[]` rather than throwing.

Match the file-header comment style of `electron/control-server.ts` — a short block
explaining why the module exists and who consumes it.

## Files to touch

- `electron/issue-sources.ts` — new. The module above.
- `electron/issue-sources.test.ts` — new. Colocated Vitest unit tests (same convention as
  `electron/github.test.ts` and `electron/linear.test.ts`). Cover: both normalizers for
  list + detail, all three `linearStateTypes` branches, `parseIssueState` defaulting to
  `"open"` for `null` / garbage input, `isIssueSource` rejecting unknown strings, and the
  missing-`labels`/`assignees` coalescing. No `vi.mock("electron")` should be needed — if
  you reach for it, the module is not pure.
