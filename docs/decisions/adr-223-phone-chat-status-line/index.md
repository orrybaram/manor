---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-223: Phone chat status line — PR drawer, local diff, context tokens

## Context

Commit `22f8bef9` added a status line under the phone chat composer
(`src/components/phone/ChatPane/ChatStatusLine.tsx`): chips for the active
workspace's open PR (number, CI, diff stat), each a plain link to GitHub. It
only renders when there is an open PR.

That falls short in three ways:

1. **The PR chip leaves the app.** The desk shows a rich PR card
   (`src/components/sidebar/PrPopover.tsx`: verdict, checks, reviewers,
   comments, "Send to agent"). The phone should show the same content, in a
   bottom drawer, instead of bouncing to GitHub.
2. **Line counts wait for a PR.** The workspace already has live local diff
   stats against its default branch (`ws.diffStats`, kept by
   `useDiffWatcher` / `electron/diff-watcher.ts`; the sidebar shows them and
   opens a diff pane on click via `useAppStore.openOrFocusDiff()`). Before a
   PR exists — the moment you most want to see how much the agent changed —
   the phone shows nothing.
3. **No context size.** On a phone you can't glance at Claude Code's own
   status line, so you can't tell when a session is close to its context
   limit. Nothing in Manor tracks token usage today. The chat mirror
   (`electron/chat-mirror/`) already tails the session transcript, whose
   assistant lines carry `message.usage`.

## Decision

**D1 — Extract the PR card body.** Split `PrPopover`'s content (header,
`SummaryRows`, checks, reviewers, comments) into an exported `PrDetails`
component in the same file. `PrPopover` renders it inside its Radix
`Popover.Content`; nothing about the desk popover's behavior changes.

**D2 — PR chip opens a drawer.** A new `PhonePrSheet`
(`src/components/phone/ChatPane/PhonePrSheet.tsx`) is a Radix `Dialog`
bottom sheet, built like `NotificationsSheet`, holding `PrDetails` plus an
"Open on GitHub" `<Link>`. Opening it calls `fetchPrs()` so it's fresh, as
the desk popover does on hover. The PR chip becomes a `<Button>` that opens
the sheet. The CI chip stays a link to the failing run.

**D3 — Diff chip uses local stats and opens a diff pane.** The diff chip
reads `ws.diffStats` (`added`/`removed`) first and falls back to the PR's
`additions`/`deletions`. It shows whenever either has a non-zero count —
with or without a PR. Tapping it calls `useAppStore.getState().openOrFocusDiff()`,
the same action the sidebar and `PhoneOverflowMenu` use.

**D4 — Context tokens from the transcript.** `TranscriptParser` records the
`usage` of the newest non-sidechain assistant line. Context size =
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(what Claude Code's own context indicator measures; output tokens are
excluded). The mirror exposes it:

- `ChatHistory`'s ok branch gains `contextTokens: number | null`.
- Changes are pushed over the existing `chat.entry` channel as a synthetic
  entry `{ kind: "usage", id: "usage", ts, contextTokens }`, republished
  whenever the value changes. Reusing the channel means no new IPC, preload
  or bridge event; the bridge already forwards every entry.
- The renderer (`usePaneChatView`) pulls `usage` entries out of the entry
  list into a separate `contextTokens` value; `ChatEntryView` must render
  nothing for an unknown kind, so an older renderer degrades quietly.

**D5 — Token chip.** The status line right-aligns the context size,
`Math.round(n / 1000)` + `k` (`8k`, `100k`, `420k`), `<1k` below 1000.
Hidden while unknown (a fresh session before its first reply). The status
line now renders whenever any chip has something to show, not only with a PR.

## Consequences

- The phone gets the desk's PR card for free, and any later improvement to
  `PrDetails` lands on both.
- Line counts appear as soon as the agent edits a file. Local and PR counts
  can differ (unpushed work); local wins because it's what the diff pane shows.
- Token usage relies on Claude Code's private transcript format. The parser
  stays defensive: a missing or odd `usage` yields `null`, never a crash.
- A synthetic `usage` entry on `chat.entry` is a mild abuse of an "entries"
  channel. The alternative, a dedicated `chat.usage` push, would need a new
  IPC handler, preload binding, `electron.d.ts` contract and bridge event
  mapping for one number. If more session metadata (model, cost) arrives
  later, revisit with a proper `chat.meta` channel.
- The status line is now visible in nearly every chat (tokens), costing
  ~24px under the composer.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
