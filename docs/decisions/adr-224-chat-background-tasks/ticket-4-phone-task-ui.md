---
title: Phone TaskCard, TaskSheet and running-tasks chip
status: todo
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Phone TaskCard, TaskSheet and running-tasks chip

ADR-224 D4. Load the `react` skill and follow `.claude/rules/ui-components.md`
(use `Button`, `Tooltip`, etc. from `src/components/ui/`).

1. `src/components/phone/ChatPane/TaskCard.tsx`: replaces ticket 2's minimal
   row in `ChatEntryView`. It shows:
   - the status dot (`styles.statusDot`, `data-status`: map running →
     `pending`, killed → `error`, or add a `running`/`killed` style)
   - the title, an `agentType` chip, and a "background" label
   - elapsed time while running (tick each second only while running; use
     `useMountEffect` and the existing patterns)
   - a one-line `result` preview when done
   - `data-testid="chat-task"` and `data-task-status`
   Tap: with `hasTranscript` → open TaskSheet; without → toggle the full
   `result` inline.
2. `TaskSheet.tsx`: a bottom sheet modelled on `PhonePrSheet`. On open, call
   `chat.getTaskHistory(paneId, taskId)` and subscribe to
   `chat.onTaskEntry` filtered by taskId, upserting by entry id the same way
   `usePaneChatView` does for `chat.entry`. Put that logic in a
   `useTaskChatView` hook. Render the entries with `ChatEntryView`,
   `answerableId = null`, with no composer. The header shows the title, the
   agentType and the status. Empty or unavailable → a quiet "No transcript
   yet".
3. Stale running: when the pane's agent status is idle/responded (from the
   agent status store the phone already reads), render a `running` task that
   began before the latest user turn as status "unknown" (grey dot, no
   timer). This is display-only.
4. `ChatStatusLine` / `chat-status-line.ts`: a "N running" chip when any task
   entry is running. Tap → scroll to the newest running TaskCard (give cards
   `data-task-id`, and use `scrollIntoView`).
5. Unit tests next to the existing ones in `__tests__/`: the TaskCard states,
   the stale-running rule (a pure function), the running count.

## Files to touch
- `src/components/phone/ChatPane/TaskCard.tsx`, `TaskSheet.tsx`, `useTaskChatView.ts` — new
- `src/components/phone/ChatPane/ChatEntryView.tsx`
- `src/components/phone/ChatPane/ChatStatusLine.tsx`, `chat-status-line.ts`
- `src/components/phone/ChatPane/ChatPane.module.css`
- `src/components/phone/ChatPane/__tests__/*`
