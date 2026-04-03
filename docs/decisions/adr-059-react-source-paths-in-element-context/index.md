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

# ADR-059: Show file paths for all React components in element context

## Context

When an agent uses `pick_element` or `get_element_context`, the React Context section currently only shows the file path for the **closest** component. The parent chain is rendered as names only: `App > Form > Button`.

For agents, the file path is the most actionable piece of information — it lets them jump directly from a visual element to the source code. Showing paths for all components in the chain (like React's error stack traces do) makes this tool significantly faster for agent workflows.

The data is already being collected — the fiber walk extracts `_debugSource` (fileName + lineNumber) for every component. It's purely a formatting gap in `formatElementContext`.

## Decision

Update `formatElementContext` in `electron/mcp-webview-server.ts` to render file paths for every component in the React Context section, using a stack-trace-like format:

```
## React Context
  in Button (at /src/components/Button.tsx:42)
  in Form (at /src/features/auth/Form.tsx:18)
  in App (at /src/App.tsx:7)
```

Components without `_debugSource` just show the name without a path. Drop the old "Parent chain" line — the stack format already conveys the hierarchy.

## Consequences

- Agents can immediately find and open the right source file from any picked element
- Output is slightly longer but only when React is detected
- No changes to data collection — purely formatting
