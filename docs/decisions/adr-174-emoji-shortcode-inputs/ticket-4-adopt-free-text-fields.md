---
title: Adopt emoji autocomplete in commit, feedback and review comment fields
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Adopt emoji autocomplete in commit, feedback and review comment fields

Wire `ui/EmojiAutocomplete` (ticket 2) into the free-text prose fields.

- `src/components/workspace-panes/DiffPane/CommitModal/CommitModal.tsx`:
  message `Input` → `EmojiInput`, description `Textarea` → `EmojiTextarea`.
- `src/components/statusbar/FeedbackModal/FeedbackModal.tsx`: title `Input`
  (keep `ref={titleInputRef}`, which the dialog's `onOpenAutoFocus` uses) →
  `EmojiInput`, description `Textarea` → `EmojiTextarea`.
- `src/components/workspace-panes/DiffPane/DiffCommentCard/DiffCommentCard.tsx`:
  raw `<textarea ref={textareaRef}>`. Call
  `useEmojiAutocomplete(textareaRef)` and spread `fieldProps`. At the top of
  the existing `onKeyDown`, `if (handleKeyDown(e)) return;`. This must run
  before the Escape branch, so Escape with the list open only closes the
  list. Render `suggestions` inside the card. Insertion dispatches `input`, so
  `onChange` still runs `autoGrow()`.

Check in the app that Escape inside CommitModal with the list open keeps the
modal open, and that Cmd+Enter in the comment card still saves.

## Files to touch
- `src/components/workspace-panes/DiffPane/CommitModal/CommitModal.tsx`
- `src/components/statusbar/FeedbackModal/FeedbackModal.tsx`
- `src/components/workspace-panes/DiffPane/DiffCommentCard/DiffCommentCard.tsx`
