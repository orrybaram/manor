---
title: Issue refs round-trip; one issue shape on the wire
status: todo
priority: critical
assignee: opus
blocked_by: [6]
---

# Issue refs round-trip; one issue shape on the wire

Fixes correctness bug #5.

## The bug

Traced end to end:

1. `normalizeGitHubIssue` sets `ref = "#42"` (`electron/issue-sources.ts:63`).
2. `list_issues` prints `issue.ref` (`electron/mcp/tools-agents.ts:159`).
3. The model passes `"#42"` to `get_issue_detail`.
4. `GET /projects/x/issues/%2342` → `matchPath` decodes to `"#42"`.
5. `githubBackend.detail` does `Number.parseInt("#42", 10)` → `NaN` →
   `InvalidIssueRef` → **400**.

ADR-148 promises *"the ref is opaque and feeds straight back into
get_issue_detail."* Only the tool's prose description saves this, and only if the
model trusts prose over the data it was just handed.

Meanwhile `McpIssue.id` (`issue-sources.ts:20`, *"Lookup key for
get_issue_detail"*) is **dead**: written by all four normalizers, serialized by
`routes/issues.ts:54`, asserted in tests, read by nobody. And
`/usr/bin/grep -rn "issue-sources" electron/mcp/` returns **nothing** —
`tools-agents.ts:143-149` and `:176-184` re-declare the wire shape as anonymous
inline casts. ADR-148's "exactly one issue shape on the wire instead of two" is
false; there are two, and the compiler cannot see them drift.

## What to do

### 1. Delete `McpIssue.id`

Remove from the interface and from all four normalizers. `ref` is the lookup key.

### 2. Make the GitHub ref round-trip

`electron/issue-backends.ts:101-109`:

```ts
async detail(ref) {
  const bare = ref.startsWith("#") ? ref.slice(1) : ref;
  if (!/^\d+$/.test(bare)) {
    throw new InvalidIssueRef("GitHub issue refs must be numeric.");
  }
  return normalizeGitHubIssueDetail(await github.getIssueDetail(project.path, Number(bare)));
}
```

Note `/^\d+$/` also fixes a real hole: `Number.parseInt("42abc", 10)` currently
returns `42` and happily fetches issue 42. (`Number.isFinite` was also the wrong
predicate — `parseInt` returns `NaN` or a finite number, never `±Infinity`.)

### 3. `InvalidIssueRef` becomes a contract of `IssueBackend.detail`

Today `githubBackend.detail` validates and throws `InvalidIssueRef` → 400, while
`linearBackend.detail` validates nothing and lets the SDK throw → 502. Same
caller mistake, two statuses, chosen by source — the exact fork ADR-151 claimed
"stops being expressible."

Add to `linearBackend.detail`: reject a ref matching neither a UUID nor
`/^[A-Z][A-Z0-9]*-\d+$/` with `InvalidIssueRef`. Document the throw on the
`IssueBackend.detail` signature.

### 4. One shape, imported not re-declared

In `electron/mcp/tools-agents.ts`:

```ts
import type { McpIssue, McpIssueDetail } from "../issue-sources";
```

Type-only, so the MCP process stays Electron-free (`issue-sources.ts` is pure and
itself only `import type`s from `./github` / `./linear`). Delete both inline cast
shapes and use these. The `issue.labels && …` guards at lines 156, 186, 189 then
become provably dead — `labels: string[]` is total — so delete them too.

### 5. Fix the stale docstring

`issue-sources.ts:7-9` claims the module is *"consumed … transitively, by the
Electron-free MCP server."* After step 4 that becomes true. Leave the sentence;
verify it.

### 6. Add the missing enum to the tool schemas

`list_issues` and `get_issue_detail` declare `source` as a bare `{type: "string"}`
(`tools-agents.ts`), while every other constrained field carries an `enum`. The
server validates it and 400s; the model is never told. Add
`enum: ["github", "linear"]`.

## Files to touch
- `electron/issue-sources.ts` — delete `id` from `McpIssue` and the four normalizers
- `electron/issue-backends.ts` — `#`-stripping + `/^\d+$/`; `InvalidIssueRef` in `linearBackend.detail`; document the throw
- `electron/mcp/tools-agents.ts` — import the shared types; delete both inline shapes and the dead `labels &&` guards; add the `source` enum
- `electron/issue-sources.test.ts`, `electron/issue-backends.test.ts` — drop `id` assertions; add `"#42"`, `"42abc"`, and a malformed Linear ref

## Verify
`pnpm typecheck` clean. New tests: `detail("#42")` and `detail("42")` both resolve
to issue 42; `detail("42abc")` throws `InvalidIssueRef`; `linearBackend.detail("nonsense")`
throws `InvalidIssueRef` (400), not an SDK error (502). Round-trip test: the `ref`
from `list()` is accepted by `detail()` for both sources.
