---
title: Token count chip on the status line
status: done
priority: medium
assignee: sonnet
blocked_by: [2, 3]
---

# Token count chip on the status line

ADR-223 D5. Render the context size from ticket 3 on the right of the status
line built in ticket 2.

- Add `formatContextTokens(n: number): string` to
  `src/components/phone/ChatPane/chat-status-line.ts`:
  `n < 1000` → `"<1k"`, else `` `${Math.round(n / 1000)}k` `` (`8k`, `100k`, `420k`).
  Unit tests in `__tests__/chat-status-line.test.ts` (999 → `<1k`, 1000 → `1k`,
  8_400 → `8k`, 419_600 → `420k`).
- `ChatStatusLine` takes `contextTokens?: number | null`. When non-null,
  render a non-interactive chip pushed to the right (flex spacer or
  `margin-left: auto`), dim text (`var(--text-dim)`), mono, tabular-nums,
  `aria-label={`${n} tokens in context`}`, with a `title` of the exact count.
- The line renders when any of PR, CI, diff or tokens has something to show.
- If the diff/PR chips plus tokens overflow at 320px, the left group should
  shrink/clip, never the token chip — give the left chips `min-width: 0`
  where needed and the token chip `flex-shrink: 0`.

## Files to touch
- `src/components/phone/ChatPane/chat-status-line.ts` — `formatContextTokens`
- `src/components/phone/ChatPane/__tests__/chat-status-line.test.ts` — tests
- `src/components/phone/ChatPane/ChatStatusLine.tsx` — token chip
- `src/components/phone/ChatPane/ChatPane.module.css` — token chip style
