---
type: adr
status: accepted
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

# ADR-168: Lightweight stats collection and badges

## Context

Manor already observes almost everything interesting about how someone works with agents: every hook event (`electron/agent-hook-events.ts`), every agent status transition (`electron/hook-relay.ts`), every pane close that abandons an active agent (`agents:abandonForPane`), every worktree created / removed / quick-merged (`electron/ipc/projects.ts`), and every PR notification (`electron/notifications.ts`). None of it is aggregated. There is no way to answer "how many prompts did I send today", "how many agents did I kill this week", or "how fast do I unblock a waiting agent".

An exploration session compared three shapes: an RPG-style XP/level sheet, an honest stats dashboard, and streaks + milestone badges. XP/levels were rejected: they reward volume, punish thinking days, and are trivially farmed. The chosen shape is **truthful counters + a handful of milestone badges**, with an explicit **"agents killed"** counter the user asked for.

Constraints that shape the design:

- **Lightweight.** No database, no new dependency, no per-event log. Bounded on-disk footprint.
- **Counts only, never content.** No prompt text, command text, file paths, or branch names are stored.
- **Local only.** Nothing leaves the machine. No sync, no telemetry.
- **Kill switch.** One preference disables collection; one action wipes the file.
- **Main owns the data.** Same ownership split as the notification log (ADR-162): main writes, renderer caches a broadcast copy and never mutates it speculatively.

## Decision

### 1. Storage: daily counter buckets in `<dataDir>/stats.json`

A new main-process `StatsStore` class in `electron/stats-store.ts`, modelled on `NotificationStore` (constructor takes `dataDir` for tests, 500 ms debounced save, `flushNow()` on quit, prune on load and after every write).

```ts
type StatCounter =
  | "prompts"            // UserPromptSubmit
  | "toolCalls"          // PreToolUse
  | "agentSessions"      // root SessionStart (CreateAgent effect)
  | "subagents"          // SubagentStart
  | "agentsResponded"    // Stop
  | "agentsKilled"       // see §3
  | "blocks"             // status entered requires_input
  | "unblocks"           // requires_input -> UserPromptSubmit
  | "unblockMsTotal"     // sum of unblock latencies (ms)
  | "fastUnblocks"       // unblock latency < 10 s
  | "worktreesCreated"
  | "worktreesRemoved"
  | "worktreesMerged"    // projects:quickMergeWorktree success
  | "prApproved"
  | "prChangesRequested"
  | "prChecksFailed";

type StatGauge = "maxConcurrentAgents"; // max(), not sum()

interface DayBucket { [k in StatCounter]?: number } & { [g in StatGauge]?: number }

interface PersistedStats {
  version: 1;
  days: Record<string, DayBucket>;      // key: local YYYY-MM-DD
  badges: Record<string, string>;       // badgeId -> ISO awarded-at
}
```

- `record(counter, n = 1, now = Date.now())` adds to today's bucket; `recordMax(gauge, value)` keeps the max.
- Day key uses the **local** date. Travel across midnight breaks streaks; accepted.
- Prune: keep at most 400 day buckets (oldest dropped). At ~200 bytes per day that is under 100 KB forever.
- `getSummary(now)` returns `{ today, last7Days, allTime, streakDays, badges, enabled }` where `today/last7Days/allTime` are `DayBucket`-shaped totals (gauges use max). `streakDays` counts consecutive local days with `prompts >= 1` ending today or yesterday.
- When the `statsEnabled` preference is false, `record`/`recordMax` are no-ops. `reset()` deletes the file and clears memory.

### 2. Signal taps (where each counter is incremented)

All taps are in main. `StatsStore` is added to `IpcDeps` (`electron/ipc/types.ts`) and constructed in `electron/app-lifecycle.ts` next to `NotificationStore`.

| Counter | Tap |
|---|---|
| prompts, toolCalls, subagents, agentsResponded, agentSessions, blocks, unblocks, unblockMsTotal, fastUnblocks, maxConcurrentAgents | `createHookRelay` gains an optional `onHookEvent(event, { effects })` dep. `app-lifecycle` passes `statsStore.observeHookEvent`. A pure module `electron/stats-signals.ts` turns `(event, effects, prevStatusForSession)` into a list of `{counter, n}` / `{gauge, value}` deltas so the mapping is unit-testable without the relay. Block/unblock latency is tracked per `sessionId` in a small map inside the signals module (`blockedAt` monotonic ms; cleared on `UserPromptSubmit`, `SessionEnd`, `DeleteSessionState`). Concurrency = `agentManager.getActiveAgents().length` sampled on each `CreateAgent` effect. |
| **agentsKilled** | See §3. |
| worktreesCreated / worktreesRemoved / worktreesMerged | `electron/ipc/projects.ts` handlers `projects:createWorktree`, `projects:removeWorktree`, `projects:quickMergeWorktree`, after the underlying call resolves without throwing. |
| prApproved / prChangesRequested / prChecksFailed | The single PR-notification append site in `electron/notifications.ts` (the `kind` map at line ~22). `pr-comment` is deliberately not counted; it is noise. |

Command-palette usage (`src/store/command-usage-store.ts`) stays a renderer-only store and is **not** folded in. It serves ranking, not stats.

### 3. "Agents killed" definition

An agent is *killed* when its pty session is terminated by a user action **while its last known status is one of `working`, `thinking`, `requires_input`**. `responded` and `idle` agents that get closed are not kills; they were done.

Taps, all in main so the renderer cannot forget one:

- `agents:abandonForPane` (`electron/ipc/agents.ts`): before flipping to `abandoned`, if `agent.status === "active"` and `agent.lastAgentStatus ∈ KILL_STATUSES` → `record("agentsKilled")`. This is the pane-close path (`closePaneById` in `app-store.ts` calls it first).
- `processes:killSession` and `processes:killAll` (`electron/ipc/processes.ts`): for each session being killed, look up `agentManager.getAgentByPaneId(sessionId)` and apply the same predicate.
- `agents:reconcileStale` is **not** a kill. The daemon or app died; the user did not pull the trigger.

`KILL_STATUSES` is exported from `electron/stats-signals.ts` so the predicate lives in one place: `isKill(agent: Pick<AgentInfo, "status" | "lastAgentStatus">): boolean`.

### 4. Badges

Pure module `electron/stats-badges.ts`: a static `BADGES: BadgeDef[]` list (`id`, `title`, `description`, `predicate(summary) => boolean`) and `evaluateBadges(summary, alreadyAwarded) => BadgeDef[]` returning newly earned ones. `StatsStore` runs it after every record (cheap; the list is ~12 predicates) and persists awards in `badges`. Each new award appends a notification of new kind `"badge-unlocked"` (`target: null`) to `NotificationStore`, so the existing notification center is the celebration surface. No native banner; in-app row only.

v1 badge set:

| id | title | predicate |
|---|---|---|
| first-blood | First Blood | allTime.agentsKilled ≥ 1 |
| executioner | Executioner | allTime.agentsKilled ≥ 25 |
| massacre | Massacre | allTime.agentsKilled ≥ 100 |
| delegator | Delegator | today.subagents ≥ 10 |
| swarm | Swarm | allTime.maxConcurrentAgents ≥ 5 |
| quick-draw | Quick Draw | allTime.fastUnblocks ≥ 25 |
| gardener | Gardener | allTime.worktreesCreated ≥ 50 |
| reaper | Reaper | allTime.worktreesRemoved ≥ 50 |
| shipper | Shipper | allTime.worktreesMerged ≥ 10 |
| centurion | Centurion | today.prompts ≥ 100 |
| week-streak | Seven Days | streakDays ≥ 7 |
| month-streak | Thirty Days | streakDays ≥ 30 |

Badges are never revoked. Adding a badge is a code change and a release; that is fine.

### 5. IPC, preference, renderer cache

- IPC (`electron/ipc/stats.ts`, registered in `app-lifecycle` alongside `notificationsIpc`): `stats:getSummary`, `stats:reset`; broadcast `stats:changed` with the full summary, debounced 1 s so a burst of tool calls is one message.
- Preload `stats: { getSummary, reset, onChanged }`; types in `src/electron.d.ts` (`StatsSummary`, `DayBucket`, `BadgeAward`).
- New preference `statsEnabled: boolean` (default `true`) in `electron/preferences.ts`, `src/electron.d.ts`, `src/store/preferences-store.ts`. `StatsStore` reads it through `preferencesManager` on every record; no restart needed.
- Renderer `src/store/stats-store.ts` zustand cache mirroring `notification-store.ts`: `summary`, `loaded`, `reset()`.

### 6. Surfaces

- **Command palette view** `"stats"` (`PaletteView` union + `StatsView.tsx`), reached by a new root command "Show Stats" in `useCommands.tsx`. Layout: three columns Today / 7 Days / All Time, rows per counter with humanised labels, a derived "median-ish unblock" row (`unblockMsTotal / unblocks`), a streak line, and an earned-badges strip. Footer: "Reset stats" (confirm dialog, `dialogStyles.confirmDialog` pattern from `ProcessesView`).
- **Status bar segment** (`StatusBar.tsx`, right side): `🔥 {streakDays} · {today.prompts} prompts · ☠ {today.agentsKilled}` with a `Tooltip` summarising today. Hidden when `statsEnabled` is false or nothing recorded yet. Click opens the palette at `initialView: "stats"`.
- **Settings** (`GeneralSettingsPage.tsx`): `Switch` for "Collect usage stats" + a "Reset stats" `Button`.
- **Remote control** and the sidebar are out of scope for this ADR.

### Non-goals

No XP, no levels, no leaderboards, no upstream telemetry, no content capture, no streak-break nag.

## Consequences

**Better**

- Every interesting number Manor already sees becomes visible, with one bounded JSON file and no new dependency.
- The kill counter is defined once (`isKill`) and enforced in main, so any future close path only needs to call the same predicate.
- Badges reuse the notification center; zero new celebration UI.
- Pure modules (`stats-signals`, `stats-badges`) carry the logic and are unit-tested without Electron.

**Harder / risks**

- `createHookRelay` gains one more optional dep. The relay is already the busiest seam in main; the tap must stay fire-and-forget and never throw into the relay (wrap in try/catch).
- `agentsKilled` depends on `lastAgentStatus` being current. A late `PostToolUse` racing after `Stop` is already guarded by the relay (ADR-139 late-active guard), so a just-finished agent will read `responded`, not `thinking`. Acceptable.
- `maxConcurrentAgents` samples on `CreateAgent` only; an agent that resumes an existing session does not re-sample. Under-counts slightly; acceptable.
- Local-date bucketing means a session spanning midnight splits across two days. Accepted.
- Two new `NotificationKind` values would break the exhaustive `isValidRecord` check in `notification-store.ts` if forgotten; ticket 4 covers it.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
