---
title: Strip emoji from sanitized branch names
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Strip emoji from sanitized branch names

The new workspace dialog builds the branch name from the workspace name with
`sanitizeBranchName`. Once names can hold emoji, those must not leak into git
branch names.

In both copies of `sanitizeBranchName`, as the **first** step after
`input.trim()` (before whitespace becomes `-`), remove emoji:

```ts
// Emoji belong in display names, not git refs.
result = result.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\u{20E3}]/gu, "");
result = result.trim();
```

Do not strip plain digits, `#` or `*`, which are `\p{Emoji}` but not
pictographic; this is why the regex uses `Extended_Pictographic`.

Add tests in the same style as existing tests, next to the source file
(create `src/utils/branch-name.test.ts` if none exists):
- `"🚀 Launch"` → `"Launch"`
- `"fix 👍🏽 thing"` → `"fix-thing"` (no double hyphen)
- `"👨‍👩‍👧 family"` → `"family"`
- `"v2 #1"` keeps its digits and `#`

Keep both files identical in behaviour.

## Files to touch
- `src/utils/branch-name.ts`
- `electron/branch-name.ts`
- `src/utils/branch-name.test.ts`: new or extended
