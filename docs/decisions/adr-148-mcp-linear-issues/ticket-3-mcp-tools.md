---
title: Add source param to list_issues and new get_issue_detail tool
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add `source` param to `list_issues` and new `get_issue_detail` tool

Surface the routes from ticket 2 as MCP tools. The MCP process is a standalone Node
process — it must not import from `electron/linear.ts`, `electron/github.ts`, or
`electron/issue-sources.ts` (that last one is pure, but keeping the MCP module free of
main-process imports preserves the existing boundary). Declare the response shape inline
with a local `interface`, the way the current `list_issues` handler does.

## `list_issues`

- Description → `"List a project's issues from GitHub (default) or Linear."`
- Add optional property:
  ```ts
  source: {
    type: "string",
    description: "Issue source: 'github' (default) or 'linear'.",
  }
  ```
- Handler: forward `source` in the querystring alongside `filter` / `state` / `limit`,
  following the existing `if (args.X !== undefined) params.set(...)` pattern.
- Response is now `McpIssue[]` — format each as `` `${ref} ${title}${labels}` `` where
  `labels` is `` ` [${labels.join(", ")}]` `` when non-empty, else `""`.

  Note `ref` already carries GitHub's `#`, so GitHub output is byte-for-byte identical to
  today (`#42 Title [bug]`). Linear renders `ENG-123 Title [bug]`. Do **not** re-add a `#`.
- Empty array → `text("No issues found.")`, unchanged.

## `get_issue_detail` — new tool

```ts
{
  name: "get_issue_detail",
  description:
    "Read a single issue's full detail, including its description body. Works for GitHub and Linear.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectId: { type: "string", description: "Project ID." },
      issue: {
        type: "string",
        description: "Issue ref as returned by list_issues: '42' for GitHub, 'ENG-123' for Linear.",
      },
      source: {
        type: "string",
        description: "Issue source: 'github' (default) or 'linear'.",
      },
    },
    required: ["projectId", "issue"],
  },
}
```

Handler: `http.get(\`/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue)}?${qs}\`)`
where `qs` carries `source` when provided. Format the `McpIssueDetail` as:

```
ENG-123 Fix login redirect
State: In Progress
Labels: bug, auth
Assignees: orry
URL: https://linear.app/...

<body>
```

Omit the `Labels:` and `Assignees:` lines entirely when their arrays are empty. Render
`(no description)` when `body` is null or empty. Return via `text(...)`.

Note the tool takes `issue` as a **string** even for GitHub — `"42"`, not `42`. The
control-server route parses and validates it.

## Files to touch

- `electron/mcp/tools-agents.ts` — add the `source` property to `list_issues`' schema,
  update its description and handler formatting; append the `get_issue_detail` `ToolDef` to
  the `tools` array and its handler to `handlers`. Both are picked up automatically by
  `mcp-webview-server.ts:116` — no registration needed there.
