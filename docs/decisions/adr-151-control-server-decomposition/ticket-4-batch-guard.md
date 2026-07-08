---
title: Make the batch route's Linear guard reachable
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Make the batch route's Linear guard reachable

## The problem

`control-server.ts:659-667` — `POST /projects/:id/workspaces/batch` rejects `source=linear` by
reading `parseSource(url)`, i.e. off the **query string**. Every other parameter on that route
(`issues`, `baseBranch`, `assign`, `startAgent`, `promptTemplate`) comes from the JSON body.

`batch_create_workspaces` in `electron/mcp/tools-agents.ts` has **no** `source` property in its
schema and never sets that query param — verified: only `list_issues` and `get_issue_detail` do.

So the guard is reachable by exactly one caller: a hand-crafted URL. Which is what its test in
`electron/__tests__/mcp-webview-server.test.ts` does. The test is green while exercising a path
no client can take.

## The fix

Read `source` from the body, consistent with the rest of the route.

```ts
const body = await readBody();
const source = body.source ?? "github";
if (!isIssueSource(source)) {
  json(400, { error: `Unknown source '${String(source)}'. Use 'github' or 'linear'.` });
  return true;
}
if (source === "linear") {
  json(400, { error: "batch_create_workspaces supports GitHub issues only." });
  return true;
}
```

Note the route currently calls `parseSource(url)` **before** `readBody()`. Moving the check
after `readBody()` is required. Confirm nothing between them depends on the ordering — the
`githubManager` null-check (503) currently sits between the two. Decide the order deliberately
and state your choice: I suggest **read body → validate source → 503 on missing githubManager**,
so a Linear caller gets the accurate "GitHub only" 400 rather than a misleading 503 on a machine
where `gh` happens to be unavailable.

Keep the two message strings byte-identical to today's, including the trailing period on
`"batch_create_workspaces supports GitHub issues only."`.

`isIssueSource` is already exported from `electron/issue-sources.ts` and already imported by
`control-server.ts`.

## Also update the test

`electron/__tests__/mcp-webview-server.test.ts` — the existing batch-guard test posts
`?source=linear` on the URL. Change it to post `{ source: "linear", issues: [1] }` in the body.
Keep both assertions: **400**, exact error message, and `createWorkspacesFromIssues` never
called.

Add one case: `{ source: "bogus", issues: [1] }` → 400 with the unknown-source message.

## Optional, if it is genuinely a two-line change

Consider adding `source` to `batch_create_workspaces`'s MCP input schema so the tool can *say*
`github` explicitly and so the rejection is discoverable from the tool description rather than
by trial. If it is not clean, skip it and note why — the guard being reachable is the point of
this ticket.

## Files to touch

- `electron/control-server.ts` — batch route: source from body.
- `electron/__tests__/mcp-webview-server.test.ts` — the batch-guard test; plus the bogus-source case.
- (optionally) `electron/mcp/tools-agents.ts` — `source` on the batch schema.

## Checks

- `pnpm exec vitest run electron/` — all pass except the 2 known pre-existing failures in
  `tasks-unseen-source-of-truth.test.ts`.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — exactly **31** pre-existing errors.
- `pnpm exec eslint` on each file you touched.

## Commit

Stage your files by name. Never `git add -A`.

  git commit -m "fix(adr-151): Make the batch route's Linear guard reachable"

No `Co-Authored-By` trailer.
