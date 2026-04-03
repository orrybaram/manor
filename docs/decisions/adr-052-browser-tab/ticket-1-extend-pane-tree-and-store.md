---
title: Extend PaneNode type and app store for browser panes
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Extend PaneNode type and app store for browser panes

Add browser pane support to the core data model and state management.

## Changes

### 1. Extend `PaneNode` leaf type (`src/store/pane-tree.ts`)

The leaf variant currently is `{ type: "leaf"; paneId: string }`. Add optional fields to support browser content:

```typescript
export type PaneNode =
  | { type: "leaf"; paneId: string; contentType?: "terminal" | "browser"; url?: string }
  | { type: "split"; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode };
```

- `contentType` defaults to `"terminal"` when omitted (backward-compatible with existing persisted layouts)
- `url` is only meaningful when `contentType === "browser"`

### 2. Add `addBrowserSession(url)` to the app store (`src/store/app-store.ts`)

Add a new action to `AppState`:

```typescript
addBrowserSession: (url: string) => void;
```

Implementation: similar to `addSession()` but creates a leaf with `contentType: "browser"` and the given `url`. Title should be the URL hostname + port (e.g., `localhost:3000`).

Also add to the `AppState` interface declaration.

### 3. Update type declarations (`src/electron.d.ts`)

The `PersistedSession` type uses `PaneNode` from the pane-tree module, so the extended type flows through automatically. No changes needed here unless the types diverge.

## Files to touch
- `src/store/pane-tree.ts` — extend PaneNode leaf type
- `src/store/app-store.ts` — add `addBrowserSession(url)` action + interface
