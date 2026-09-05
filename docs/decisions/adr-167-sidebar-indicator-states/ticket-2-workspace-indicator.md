---
title: Add toWorkspaceIndicator pure function with tests
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add `toWorkspaceIndicator` pure function with tests

Create `src/lib/workspace-indicator.ts` exporting:

```ts
import type { AgentStatus } from "../electron.d";

export type WorkspaceIndicatorKind = "thinking" | "working" | "needs_you" | "done_unread";
export type WorkspaceIndicator = { kind: WorkspaceIndicatorKind; pulse: boolean } | null;

export function toWorkspaceIndicator(
  status: AgentStatus | null | undefined,
  pulse: boolean,
): WorkspaceIndicator;
```

Mapping:

| `status` | result |
|---|---|
| `thinking` | `{ kind: "thinking", pulse: false }` |
| `working` | `{ kind: "working", pulse: false }` |
| `requires_input` | `{ kind: "needs_you", pulse }` (pulse passed through — it is the unseen flag from the hook) |
| `error` | `{ kind: "needs_you", pulse: false }` |
| `responded` and `pulse === true` | `{ kind: "done_unread", pulse: true }` |
| `responded` and `pulse === false` | `null` |
| `complete`, `idle`, `null`, `undefined` | `null` |

Add a doc comment on the function explaining the two-question model from
ADR-167 (agent dot answers "does this workspace need me?") and that `pulse`
means exactly "unread".

Add `src/lib/__tests__/workspace-indicator.test.ts` (vitest, no DOM) with one
case per row above, including `requires_input` with pulse true and false.

Run `pnpm vitest run src/lib/__tests__/workspace-indicator.test.ts` and make it
pass.

## Files to touch
- `src/lib/workspace-indicator.ts` — new pure function
- `src/lib/__tests__/workspace-indicator.test.ts` — new tests
