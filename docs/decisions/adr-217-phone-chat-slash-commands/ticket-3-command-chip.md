---
title: Show slash commands as chips in the phone chat history
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Show slash commands as chips in the phone chat history

ADR-217 D2 (phone side). Ticket 1 adds the `command` `ChatEntry` kind.

- `src/components/phone/ChatPane/ChatEntryView.tsx`: add `case "command"` rendering a `CommandEntry`:
  - A right-aligned row like `userRow`, holding a compact chip styled as a small, muted pill rather than a full user bubble. It shows `/name` in monospace plus `args` (truncated to one line with ellipsis).
  - If `output` is set, the chip is a `<Button variant="ghost" size="sm">` with `aria-expanded` that toggles a `<pre>` of the output, following `ToolEntry`'s pattern. Without output it is not interactive. Use `Button` from `ui/`, never a raw `<button>`.
  - `data-testid="chat-command"`.
- Add styles to `ChatPane.module.css` using existing CSS variables/tokens in that file. Check it in light and dark themes.
- `chat-entries.ts` needs no change (upsert by id already handles the stdout update). Confirm nothing switches over `kind` exhaustively in a way that now fails the typecheck (grep `entry.kind`).

## Files to touch
- `src/components/phone/ChatPane/ChatEntryView.tsx` — `command` case and `CommandEntry`
- `src/components/phone/ChatPane/ChatPane.module.css` — chip styles
