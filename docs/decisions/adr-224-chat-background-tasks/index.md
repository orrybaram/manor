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

# ADR-224: Background tasks in the chat mirror, behind a per-agent transcript adapter

## Context

The chat mirror (ADR-215, ADR-216) tails an agent's JSONL transcript and
turns it into `ChatEntry`s for the phone chat. Background work is shown badly
today:

1. **A launch looks like a finish.** A Claude Code `Agent` call with
   `run_in_background` gets its `tool_result` right away ("Async agent
   launched"), so its tool row turns ✓ while the agent is still running. The
   summary just says "Agent", because `summarizeTool` has no case for it.
   Background `Bash` (`run_in_background`) has the same problem.
2. **The finish has no link to the launch.** `<task-notification>` is parsed
   into a separate `notice` entry. It carries `<tool-use-id>`, which points
   back to the launching `tool_use`, but the parser never uses it.
3. **There's no way into a subagent.** Claude Code writes each subagent's
   transcript to `<session-dir>/<sessionId>/subagents/agent-<agentId>.jsonl`,
   next to a `.meta.json` file (`{agentType, description, toolUseId,
   requestShape, model}`). The parser drops `isSidechain` lines and never
   opens these files.

All the data needed is already in the parent transcript. These are the real
shapes, checked against transcripts on this machine:

- **The `tool_use`.** `name: "Agent"` (older versions: `"Task"`) with input
  `{description, subagent_type, prompt, run_in_background?, model?}`.
  `name: "Bash"` with `run_in_background: true`.
- **The result line's top-level `toolUseResult`.** For an async agent:
  `{isAsync: true, status: "async_launched", agentId, resolvedModel,
  outputFile}`. A foreground agent has an `agentId` and no `isAsync`.
- **The user turn on completion.** `<task-notification><task-id/>
  <tool-use-id/><output-file/><status>completed|failed|killed</status>
  <summary/></task-notification>`.

**Other agents.** Manor runs `claude`, `codex`, `opencode` and `pi`
(`AgentKind`, `electron/agent-persistence.ts`). The mirror doesn't know which
kind it's reading. `PaneAgent` is `{hostId, transcriptPath}`, and every
transcript goes through the Claude-specific `TranscriptParser`. A Codex pane
whose hooks report a `transcript_path` gets its rollout file parsed as Claude
JSONL, which quietly produces next to nothing. Background tasks would make
that coupling deeper unless the format-specific part is split off now.

## Decision

### D1. A per-agent `TranscriptAdapter`

Split the mirror (agent-neutral: offsets, tailing, sources, watching,
pickers) from the format (agent-specific). Add
`electron/chat-mirror/adapters/`:

```ts
interface TranscriptAdapter {
  /** A fresh line parser for one transcript. */
  createParser(): TranscriptLineParser;
  /**
   * Where a task's own transcript lives, given the parent's path and the
   * task entry. Null when the agent writes none, or this task has none.
   */
  childTranscriptPath(parentPath: string, task: ChatTaskEntry): string | null;
}

interface TranscriptLineParser {
  push(line: string): ChatEntry[];
  entries(): ChatEntry[];
  contextTokens(): number | null;
  skills(): ChatSkill[];
  hasSkillListing(): boolean;
}
```

- `adapters/claude.ts` wraps today's `TranscriptParser`. Its file stays
  `transcript.ts`, and it implements `TranscriptLineParser` as it is now.
- `adapters/index.ts` exports `adapterFor(kind: AgentKind): TranscriptAdapter
  | null`. Only `claude` is registered.
- `PaneAgent` gains `agentKind`. `app-lifecycle.ts` passes
  `agent.agentKind` through.
- An agent with no adapter answers `{ok: false, reason: "unsupported-agent"}`
  from `getHistory`/`getCommands`/`answer`, instead of a misparsed chat. The
  phone shows "Chat isn't available for this agent yet" for that reason.
- The picker encoders (`picker-keys.ts`) stay Claude-only for now. A question
  or plan entry only ever comes from the Claude adapter, so nothing changes.

The `ChatEntry` union is the shared language. A Codex, opencode or pi
adapter only has to map its own format onto it. It gets tailing, remote
hosts, child streams (D3) and the phone UI without further changes.

### D2. A `task` entry: delegated or background work, agent-neutral

```ts
| {
    kind: "task";
    id: string;            // the launching tool_use id
    ts: string;
    /** What sort of work: a delegated agent, a shell command, or other. */
    taskKind: "agent" | "shell" | "other";
    /** One line: the description, else the command's first line. */
    title: string;
    /** e.g. "implementer", "Explore". Agent tasks only. */
    agentType?: string;
    model?: string;
    background: boolean;
    status: "running" | "ok" | "error" | "killed";
    /** The final summary or result text, capped at MAX_DETAIL. */
    result?: string;
    /** The agent's own id for this task, when it has one (Claude: agentId). */
    taskRef?: string;
    /** True when `childTranscriptPath` can resolve a transcript for it. */
    hasTranscript: boolean;
  }
```

Field names describe the idea, not Claude. Nothing says `subagent_type` or
`isAsync`.

How the Claude adapter fills it in (`transcript.ts`):

- **A `tool_use` named `Agent` or `Task`.** Becomes a `task`: `taskKind:
  "agent"`, `title` = `description`, `agentType` = `subagent_type`,
  `background` = `run_in_background === true`, `status: "running"`.
- **A `tool_use` of `Bash` with `run_in_background: true`.** Becomes a
  `task`: `taskKind: "shell"`, `title` = `description` or the command's first
  line. A foreground `Bash` stays a `tool`.
- **The `tool_result` for a task.** Read the line's top-level `toolUseResult`:
  - It has `agentId`: set `taskRef`. For an agent, set `hasTranscript: true`.
  - `isAsync === true`, or the result is a background launch: keep `status:
    "running"`, and don't store the launch text as `result`.
  - Otherwise (foreground): `status` = `is_error ? "error" : "ok"`, `result`
    = the result text.
- **`<task-notification>`.** If its `<tool-use-id>` matches a `task`, update
  that entry: `status` from `<status>` (`completed` → ok, `failed` → error,
  `killed` → killed), `result` = `<summary>`. **No separate `notice`.** With
  no matching task (it scrolled away before a `/clear`, or a kind we don't
  model), keep today's `notice` as the fallback.

Entries are replaced, not mutated, as `resolve` does today, so an update is a
republish of the same id. The renderer already upserts by id.

### D3. Child streams: reading a task's own transcript

`ChatMirror` gains child streams, keyed `(paneId, taskId)`:

- **Its own state.** A child stream is a `PaneMirror`-like record (path,
  offset, parser, generation, watch/poll) holding its own parser from the
  same adapter. Refactor the tail-and-consume parts of `PaneMirror` into a
  `TranscriptStream` that both use. Pickers and answers stay on the pane
  stream only: a subagent's chat is read-only.
- **Finding the path.** `adapter.childTranscriptPath(parentPath, task)`. For
  Claude: `join(dirname(parentPath), basename(parentPath, ".jsonl"),
  "subagents", "agent-" + task.taskRef + ".jsonl")`. It's computed, not
  listed, so it works the same through `RemoteTranscriptSource`.
- **Sidechain lines.** Lines in the child file are marked `isSidechain: true`,
  so the Claude parser takes an option, `{ sidechain: boolean }`, that
  decides whether it keeps them. The adapter's `createParser({ child: true })`
  sets it.
- **Bridge.**
  - `chat.getTaskHistory(paneId, taskId)` returns `ChatHistory`, or `{ok:
    false, reason: "no-transcript"}` when the task has none.
  - A new event, `chat.taskEntry: [paneId, taskId, entry]`, is published keyed
    by `paneId`. Subscribing to it watches that child stream, using the same
    `setWatched` mechanics as `chat.entry`.
- **Cleanup.** A child stream is dropped when the pane's path resets (`/clear`,
  resume), when the pane closes, or when its last subscriber leaves *and*
  its task is no longer running.
- **Remote hosts.** These keep working because the child read goes through the
  same `sourceFor(agent)`. A `poke` from a hook also reads every watched
  child stream of that pane. Subagent hooks already arrive as root-session
  hooks with an `agent_id`.

### D4. Phone UI

- **`TaskCard`.** Shows `task` entries in `ChatEntryView`. They don't join
  tool groups: a running background agent is the kind of thing the user
  wants to see, not a line folded into "Ran 3 commands". The card shows a
  status dot (reusing `statusDot`/`data-status`), the title, an `agentType`
  chip, "background" when it applies, and the elapsed time while it's
  running. Once done it shows a one-line `result` preview.
- **Opening a task.** Tapping a card with `hasTranscript` opens `TaskSheet`, a
  bottom sheet like `PhonePrSheet`. The sheet renders the child stream with
  the same `ChatEntryView`, read-only: no composer, and no answerable picker
  (`answerableId = null`). Without `hasTranscript`, tapping expands the
  `result` text inline.
- **Running count.** `ChatStatusLine` shows a "N running" chip while any task
  is running. Tapping it scrolls to the newest running task.

### D5. Out of scope

- Adapters for Codex, opencode and pi. D1 makes each one a self-contained
  follow-up: `adapters/<kind>.ts` plus fixtures.
- Using the other unused transcript lines (`ai-title`, `away_summary`,
  `cost-state`, `compact_boundary`, `api_error`, `queue-operation`,
  `permission-mode`). Each of these maps onto either a `ChatEntry` or an
  adapter-level getter like `contextTokens()`. They'll follow the same
  adapter seam later.
- Stopping or messaging a task from the phone.
- The desk (non-phone) chat. There's none today.

## Consequences

**Better**
- A background agent reads as running until it actually finishes, and its
  launch and its finish are a single card.
- You can follow a subagent's work live from the phone, on local and remote
  hosts alike.
- The mirror no longer assumes Claude Code. Adding another agent's chat means
  writing one adapter, and its tasks, child streams and UI come with it.
- Codex, opencode and pi panes stop getting a misparsed, nearly empty chat.
  They say outright that chat isn't supported.

**Harder / risks**
- The transcript and subagent layout are private to Claude Code. That covers
  the `subagents/` directory, `toolUseResult`, and `<task-notification>` tags.
  As in ADR-215, everything is defensive: a missing `toolUseResult` leaves
  the task running until a notification or the foreground result arrives,
  and a missing child file reads as size 0 (an empty sheet that fills in
  later).
- **A task that never gets a notification stays "running".** That happens
  when the session is killed mid-task. Mitigation: once the pane's agent
  status is idle and there are no active subagents by the reconciler's
  count, the phone renders running tasks older than the last turn as
  "unknown". It does this from the status store, without changing the entry.
- More watchers. Each open `TaskSheet` adds one tail. They're bounded by
  open sheets, not by the number of tasks.
- `PaneMirror` → `TranscriptStream` is a refactor of tested code, so the
  existing `mirror.test.ts` has to pass unchanged before the child streams
  land.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
