---
title: Add pushStream interface and pure error categorizer
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Ticket 1: Add pushStream interface and pure error categorizer

Lay the type foundation for the streaming push and the pure error-categorization function. No runtime behavior changes yet.

## Files to touch

- `electron/backend/types.ts` — Add `pushStream` to the `GitBackend` interface alongside the existing `push`. Signature:
  ```ts
  pushStream(
    cwd: string,
    opts: { remote?: string; branch?: string; setUpstream?: boolean },
    callbacks: {
      onLine: (line: string) => void;
      onDone: (result: { exitCode: number | null; stderr: string }) => void;
    },
  ): { cancel: () => void };
  ```
  Do NOT delete the old `push` method yet (ticket 2 deletes it after the new impl lands).

- `electron/backend/push-error.ts` (new) — Pure module exporting:
  ```ts
  export type PushErrorKind =
    | "no-upstream"
    | "non-fast-forward"
    | "auth"
    | "network"
    | "permission"
    | "hook-rejected"
    | "unknown";

  export type PushError = {
    kind: PushErrorKind;
    message: string;
    action?: { kind: "set-upstream" | "pull-and-retry"; label: string };
  };

  export function categorizePushError(stderr: string): PushError;
  ```
  Match each kind against representative substrings (case-insensitive where appropriate):
  - `no-upstream`: `has no upstream branch` OR `set-upstream` OR `current branch ... has no upstream`. Action: `{ kind: "set-upstream", label: "Push with --set-upstream" }`. Message: "No upstream branch — first push needs `--set-upstream`."
  - `non-fast-forward`: `non-fast-forward` OR `Updates were rejected because the tip` OR `failed to push some refs`. Action: `{ kind: "pull-and-retry", label: "Pull & retry" }`. Message: "Remote has new commits — pull first."
  - `auth`: `Authentication failed` OR `could not read Username` OR `terminal prompts disabled` OR `unable to access` (HTTPS auth). No action. Message: "Authentication failed — check your credentials."
  - `permission`: `Permission denied (publickey)` OR `Permission denied (publickey,password)`. No action. Message: "SSH permission denied — check your key."
  - `network`: `Could not resolve host` OR `Connection timed out` OR `Network is unreachable` OR `Failed to connect`. No action. Message: "Network error — check your connection."
  - `hook-rejected`: `pre-push hook` OR `hook declined` OR a stderr where the first non-empty line ends with `rejected` AND `non-fast-forward` did not match. No action. Message: "Pre-push hook rejected the push."
  - `unknown` fallback: stderr's last non-empty line as message; if stderr is empty, "Push failed".

- `electron/backend/__tests__/push-error.test.ts` (new) — Vitest spec, one `describe` per kind, two-three fixtures each including a real-world stderr example. Also test the empty-stderr fallback to `"Push failed"`.

## Notes

- Categorizer must be pure — no side effects, no I/O.
- Order matters: check `non-fast-forward` before `hook-rejected` since a hook may also include the word "rejected".
- Keep the regex/substring checks plain — no clever normalization. If a future git version changes wording, that's a test update.
