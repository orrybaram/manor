---
title: Format clipboard copy with React context file paths
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Format clipboard copy with React context file paths

When the user picks an element via the UI toolbar button, `BrowserPane.tsx` copies the result to clipboard as raw JSON. Update it to format the React Context section as readable text with file paths.

Current (line 108 of BrowserPane.tsx):
```typescript
window.electronAPI.clipboard.writeText(JSON.stringify(result, null, 2));
```

Change to: format the result as structured text. Keep the JSON for non-React fields, but add a formatted React Context section at the top when react components are present:

```
## React Context
  in Button (at /src/components/Button.tsx:42)
  in Form (at /src/features/auth/Form.tsx:18)
  in App (at /src/App.tsx:7)

## Selector
div#root > div.app > button.submit

## HTML
<button class="submit">Click me</button>
```

## Files to touch
- `src/components/BrowserPane.tsx` — update clipboard copy logic (around line 108)
