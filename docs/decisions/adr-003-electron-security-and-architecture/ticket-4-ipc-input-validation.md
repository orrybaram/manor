---
title: Add IPC input validation for security-critical handlers
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Add IPC input validation for security-critical handlers

Main process IPC handlers accept renderer arguments without type checking. Add runtime validation for the most security-sensitive handlers. Keep it lightweight — simple type guards, not a schema library.

## Implementation

Create a small validation helper in a new file `electron/ipc-validate.ts`:

```typescript
export function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name}: expected string, got ${typeof value}`);
  }
}

export function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}: expected finite number, got ${typeof value}`);
  }
}

export function assertPositiveInt(value: unknown, name: string): asserts value is number {
  assertNumber(value, name);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}: expected positive integer, got ${value}`);
  }
}
```

Then add validation calls to these handlers in `electron/main.ts`:

1. **`pty:create`** — validate `paneId` (string), `cwd` (string or null), `cols` (positive int), `rows` (positive int)
2. **`pty:write`** — validate `paneId` (string), `data` (string)
3. **`pty:resize`** — validate `paneId` (string), `cols` (positive int), `rows` (positive int)
4. **`pty:close`** / **`pty:detach`** — validate `paneId` (string)
5. **`projects:add`** — validate `name` (string), `path` (string)
6. **`linear:connect`** — validate `apiKey` (string)

Pattern for each handler — add assertions at the top:

```typescript
ipcMain.handle("pty:create", async (_event, paneId, cwd, cols, rows) => {
  assertString(paneId, "paneId");
  if (cwd !== null) assertString(cwd, "cwd");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  // ... existing implementation
});
```

Don't over-validate — focus on the security boundary. Internal-only handlers like `layout:save` and `theme:get` can remain as-is.

## Files to touch
- `electron/ipc-validate.ts` — new file with assertion helpers
- `electron/main.ts` — add validation calls to the 6 handlers listed above
