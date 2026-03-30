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

# ADR-061: Browser History with URL Autocomplete

## Context

Browser panes have no history system. Every time a user opens a new browser tab, they start from scratch with no memory of previously visited sites. This makes it tedious to revisit URLs. The user wants a lightweight, global browser history that powers autocomplete suggestions in the URL bar.

## Decision

Add a global browser history store (`src/store/browser-history-store.ts`) using Zustand with `persist` middleware (localStorage). The store holds the last 50 entries (URL + title + lastVisited timestamp), deduplicated by URL (revisiting bumps the entry to most recent).

The `BrowserPane` URL input gets converted into a wrapper with a dropdown. When the user types, entries are filtered by substring match against both URL and title, showing up to 8 results sorted by most recently visited. Selecting a result navigates to that URL. The dropdown dismisses on blur, Escape, or selection.

History is recorded in `setPaneUrl` within `app-store.ts` — whenever a real navigation happens (not `about:blank`), we call `addHistoryEntry()`.

### Files

- **`src/store/browser-history-store.ts`** — New Zustand store: `{ entries: HistoryEntry[], addEntry(url, title), search(query): HistoryEntry[] }`
- **`src/components/BrowserPane.tsx`** — Add autocomplete dropdown to URL input, integrate history store for recording + searching
- **`src/components/BrowserPane.module.css`** — Styles for autocomplete dropdown

## Consequences

- Simple localStorage persistence — no electron IPC needed, survives restarts
- 50-entry cap keeps storage minimal
- Global history shared across all browser tabs automatically
- No delete/clear UI in this iteration (can be added later)
