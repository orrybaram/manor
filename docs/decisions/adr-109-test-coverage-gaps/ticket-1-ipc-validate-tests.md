---
title: Add tests for ipc-validate.ts
status: done
priority: critical
assignee: haiku
blocked_by: []
---

# Add tests for ipc-validate.ts

Write `electron/ipc-validate.test.ts` testing all three assertion functions.

## Test cases

### `assertString(value, name)`
- Passes for a normal string
- Passes for empty string
- Throws for `undefined`, `null`, `123`, `true`, `{}`, `[]`
- Error message includes the field name and actual type

### `assertNumber(value, name)`
- Passes for positive number, zero, negative number
- Throws for `NaN`, `Infinity`, `-Infinity`
- Throws for string, null, undefined, boolean

### `assertPositiveInt(value, name)`
- Passes for `1`, `100`
- Throws for `0`, `-1`, `1.5`
- Throws for non-number types (delegates to assertNumber first)
- Error message includes the field name and actual value

## Files to touch
- `electron/ipc-validate.test.ts` — new file

## Patterns to follow
- Import from `vitest`: `describe, it, expect`
- Nested `describe` blocks per function
- No mocking needed — these are pure functions
