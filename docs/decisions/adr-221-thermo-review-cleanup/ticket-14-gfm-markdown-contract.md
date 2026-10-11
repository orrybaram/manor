---
title: GfmMarkdown contract cleanup
status: todo
priority: low
assignee: sonnet
blocked_by: [12]
---

# GfmMarkdown contract cleanup

`src/components/ui/GfmMarkdown/GfmMarkdown.tsx`:
1. `renderImage` is optional (`:24, 71`) but both callers pass it — make it required; delete the `!renderImage` branch.
2. Link propagation is inconsistent: `#` anchors always `stopPropagation` (`:53`); http links only via `onLinkClick` (`:63`), which only `CommentMarkdown` uses. Pick one policy: always stop propagation inside GfmMarkdown and delete `onLinkClick` (check CommentMarkdown's reason for it first; if it does more than stop propagation, route both link kinds through the prop instead).
3. Footnote `jumpTo` (`~676-688`) tries two candidate ids to cope with rehype-sanitize double-prefixing `user-content-`. Set the sanitize schema's `clobberPrefix` deliberately so one id is correct, and simplify `jumpTo`.
Update callers `src/components/tasks/TaskDetail/TaskMarkdown.tsx`, `src/components/ui/PrCommentCard/CommentMarkdown.tsx`. Add/adjust a unit test for footnote id + link click if a test file exists nearby.

## Files to touch
- `src/components/ui/GfmMarkdown/GfmMarkdown.tsx`
- `src/components/tasks/TaskDetail/TaskMarkdown.tsx`
- `src/components/ui/PrCommentCard/CommentMarkdown.tsx`
