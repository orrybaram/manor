---
title: Create browser history Zustand store
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create browser history Zustand store

Create `src/store/browser-history-store.ts` — a Zustand store with `persist` middleware (localStorage key: `"browser-history"`).

## Types

```typescript
interface HistoryEntry {
  url: string;
  title: string;
  lastVisited: number; // Date.now()
}
```

## State & Actions

- `entries: HistoryEntry[]` — max 50, sorted by lastVisited desc
- `addEntry(url: string, title: string)` — if URL already exists, update title + lastVisited and re-sort; otherwise prepend and trim to 50
- `search(query: string): HistoryEntry[]` — case-insensitive substring match on url and title, return up to 8 results sorted by lastVisited desc. Empty query returns empty array.

Skip `about:blank` URLs in `addEntry`.

## Files to touch
- `src/store/browser-history-store.ts` — create new file
