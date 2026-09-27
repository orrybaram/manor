/**
 * The Status reconciler (ADR-184): a pure per-pane function
 *
 *   reconcile(state, signal, ctx) → { state, status, reason, effects }
 *
 * that turns Status signals (hooks, Pane facts, ticks, user actions) into the
 * pane's Agent status and the reason for it.
 *
 * Pure: no IO, no timers, no clocks (time comes from `ctx.nowMs` or the tick),
 * and inputs are never mutated — Sets are copied whenever they change.
 *
 * Rules, in the order they are checked (each is a row in the table below):
 *
 * Hook signals (`reconcileHook`)
 *  H1  Late-active guard (ADR-139): an active hook other than UserPromptSubmit /
 *      SessionStart for a session that has already responded is dropped.
 *  H2  SessionStart: claims the pane's root, or replaces it (the old root's
 *      in-progress turn is forced to responded). Status unchanged otherwise.
 *  H3  No session id: cannot be attributed. Ignored on a hook-driven pane;
 *      otherwise its status is applied like a fallback signal (old detector).
 *  H4  Child session (root exists, session differs): while the root's turn is
 *      in progress its activity shows on the pane — thinking / working, and
 *      requires_input so a subagent's permission prompt is visible. A child
 *      lowers only a prompt it raised itself. Never persists and never ends
 *      a turn.
 *  H5  Root session: first hook makes the pane hook-driven. SubagentStart /
 *      SubagentStop bookkeeping; active hook → create or update the Agent.
 *  H6  Terminal hook on a root that was never active is dropped (hasBeenActive).
 *  H7  Stop: held (pendingStop) while subagents are active, else responded.
 *  H8  SessionEnd: drains a held Stop, then completes; pane → idle, not
 *      hook-driven.
 *  H9  StopFailure → error.
 *
 * Pane facts (`reconcileFacts`)
 *  F1  Liveness, every Agent: a live status (active or responded) with no agent
 *      process in the foreground → idle; a root stuck mid-turn is persisted as
 *      responded (the old `notifyAgentDetectorGone` bridge). Ends hook-driven.
 *  F2  Hook-driven panes: facts decide nothing else.
 *  F3  Otherwise facts decide every status: foreground kind, then title rules
 *      for the matching Agent kind only, then the output hint.
 *
 * Ticks (`reconcileTick`) — the old `sweepStaleSessions` branches
 *  T1  Held Stop drain (ADR-130): pending Stop and root quiet > STALE_STOP_MS.
 *  T2  Stuck-working (ADR-131): root turn quiet > STALE_ACTIVE_MS while the
 *      Agent is still active.
 *  T3  Orphan (ADR-132): the pane's Agent is stuck active but has no turn state,
 *      and is older than STALE_ACTIVE_MS.
 *
 * User signals (`reconcileUser`)
 *  U1  abandon / end: an active Agent's lifecycle becomes `abandoned`; pane →
 *      idle and forgets its root.
 *  U2  markSeen: clears the Agent's unseen flags; status unchanged.
 */

import type { AgentHookEvent } from "../agent-hook-events";
import type { AgentInfo } from "../agent-persistence";
import type {
  ActiveAgentStatus,
  AgentKind,
  AgentStatus,
  Effect,
  PaneAgentState,
  PaneFacts,
  ReconcileContext,
  ReconcileResult,
  StatusSignal,
  UserAction,
} from "./types";

// ── Thresholds (same values as `hook-relay.ts` and `agent-detector.ts`) ──

/** A held Stop is forced after the root has been quiet this long (ADR-130). */
export const STALE_STOP_MS = 15_000;
/** An active turn is forced to responded after this much quiet (ADR-131). */
export const STALE_ACTIVE_MS = 60_000;
/** An orphaned active Agent is forced to responded at this age (ADR-132). */
export const ORPHAN_AGENT_MS = STALE_ACTIVE_MS;
/** Pane facts may not override an unattributed hook within this window. */
export const HOOK_DEBOUNCE_MS = 2_000;

// ── Status helpers ──

const ACTIVE_STATUSES: ReadonlySet<string> = new Set<ActiveAgentStatus>([
  "thinking",
  "working",
  "requires_input",
]);

function isActiveStatus(status: string | null | undefined): status is ActiveAgentStatus {
  return status != null && ACTIVE_STATUSES.has(status);
}

/** Statuses for which the agent process is expected to be alive (F1). */
function isLiveStatus(status: AgentStatus): boolean {
  return isActiveStatus(status) || status === "responded";
}

const KNOWN_SHELLS: ReadonlySet<string> = new Set([
  "zsh",
  "bash",
  "sh",
  "fish",
  "nu",
  "pwsh",
  "powershell",
]);

function basename(name: string): string {
  return name.split("/").pop()?.toLowerCase() ?? "";
}

// ── Title rules per Agent kind ──

type TitleVerdict = "working" | "responded" | null;

function hasBrailleChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x2800 && code <= 0x28ff) return true;
  }
  return false;
}

/** Markers Claude Code puts in its title when a turn is done. */
const CLAUDE_DONE_MARKERS = ["✳", "✻", "✽", "✶", "✢"];

/**
 * Title conventions are per Agent kind (ADR-184 §1). Only Claude Code has
 * known ones: a braille spinner while working, a done marker when finished.
 * The old TitleDetector applied these to every kind; here a kind without an
 * entry gets no title rules.
 */
const TITLE_RULES: Partial<Record<AgentKind, (title: string) => TitleVerdict>> = {
  claude: (title) => {
    if (hasBrailleChars(title)) return "working";
    if (CLAUDE_DONE_MARKERS.some((m) => title.includes(m))) return "responded";
    return null;
  },
};

// ── State helpers ──

/** The state of a pane the reconciler has not seen a signal for yet. */
export function initialPaneState(paneId: string): PaneAgentState {
  return {
    paneId,
    rootSessionId: null,
    children: new Set(),
    phase: "none",
    hookDriven: false,
    activeSubagents: new Set(),
    lastHookAt: null,
    pendingStopAt: null,
    lastUnattributedHookAt: null,
    lastFacts: null,
    kind: null,
    status: "idle",
    statusReason: "no agent",
    inputSessionId: null,
  };
}

/** Turn state cleared: what a pane looks like once its root session is gone. */
function withoutRoot(state: PaneAgentState): PaneAgentState {
  return {
    ...state,
    rootSessionId: null,
    children: new Set(),
    phase: "none",
    hookDriven: false,
    activeSubagents: new Set(),
    lastHookAt: null,
    pendingStopAt: null,
    inputSessionId: null,
  };
}

/**
 * Set the pane's status. `inputSessionId` names the session that raised a
 * `requires_input` (null for facts / unattributed hooks); any other status
 * clears it. An unchanged status keeps its reason and prompt owner.
 */
function withStatus(
  state: PaneAgentState,
  status: AgentStatus,
  reason: string,
  inputSessionId: string | null = null,
): PaneAgentState {
  if (state.status === status) return state;
  return {
    ...state,
    status,
    statusReason: reason,
    inputSessionId: status === "requires_input" ? inputSessionId : null,
  };
}

/**
 * Build a result. When the pane's status or kind changed, a
 * `PublishPaneStatus` effect is put first — the slot ADR-139's
 * `RelayAgentHook` held — so the dot updates before persistence effects run.
 */
function result(
  prev: PaneAgentState,
  next: PaneAgentState,
  reason: string,
  effects: Effect[] = [],
): ReconcileResult {
  const out: Effect[] =
    prev.status !== next.status || prev.kind !== next.kind
      ? [
          {
            kind: "PublishPaneStatus",
            paneId: next.paneId,
            status: next.status,
            reason: next.statusReason,
            agentKind: next.kind,
          },
          ...effects,
        ]
      : effects;
  return { state: next, status: next.status, reason, effects: out };
}

// ── Entry point ──

export function reconcile(
  state: PaneAgentState,
  signal: StatusSignal,
  ctx: ReconcileContext,
): ReconcileResult {
  switch (signal.type) {
    case "hook":
      return reconcileHook(state, signal.event, ctx);
    case "paneFacts":
      return reconcileFacts(state, signal.facts, ctx);
    case "tick":
      return reconcileTick(state, signal.nowMs, ctx);
    case "user":
      return reconcileUser(state, signal.action, ctx);
    default: {
      const _exhaustive: never = signal;
      void _exhaustive;
      return result(state, state, "unknown signal");
    }
  }
}

// ── Hooks ──

function reconcileHook(
  state: PaneAgentState,
  event: AgentHookEvent,
  ctx: ReconcileContext,
): ReconcileResult {
  const { sessionId, type } = event;
  const { existingAgent, nowMs } = ctx;
  const hookLabel = `${type} hook`;

  // H1 — late-active guard (ADR-139). Hook delivery is independent HTTP, so a
  // PreToolUse / PostToolUse can race in after Stop. Only UserPromptSubmit
  // starts the next turn; SessionStart is a lifecycle event (H2).
  if (
    sessionId &&
    isActiveStatus(event.status) &&
    type !== "UserPromptSubmit" &&
    type !== "SessionStart" &&
    (existingAgent?.lastAgentStatus === "responded" ||
      (sessionId === state.rootSessionId && state.phase === "responded"))
  ) {
    return result(state, state, `late ${hookLabel} after Stop ignored`);
  }

  // H2 — SessionStart. Never changes the status on its own (ADR-014: the agent
  // stays idle until a real event), except to close a replaced root's turn.
  if (type === "SessionStart") {
    if (!sessionId) {
      return result(state, state, "SessionStart without a session id ignored");
    }
    if (state.rootSessionId === null || state.rootSessionId === sessionId) {
      const next: PaneAgentState = {
        ...state,
        rootSessionId: sessionId,
        hookDriven: true,
        kind: event.agentKind,
      };
      return result(state, next, "SessionStart hook: root session claimed");
    }
    // Root replacement (`/clear`, `--resume`): the old root's turn, if it was
    // still in progress, is forced to responded (was ForceCloseOldSession).
    const oldRoot = state.rootSessionId;
    const oldTurnInProgress = state.phase === "active" || state.phase === "pendingStop";
    const effects: Effect[] = oldTurnInProgress
      ? [{ kind: "PersistAgentStatus", sessionId: oldRoot, transition: { to: "responded" } }]
      : [];
    let next: PaneAgentState = {
      ...withoutRoot(state),
      rootSessionId: sessionId,
      hookDriven: true,
      kind: event.agentKind,
    };
    if (oldTurnInProgress) {
      next = withStatus(next, "responded", "previous session replaced by SessionStart");
    }
    return result(state, next, "SessionStart hook: root session replaced", effects);
  }

  // H3 — no session id: nothing to attribute it to, so no persistence and no
  // hook-driven flag. Mirrors the old relay→AgentDetector path for panes whose
  // status is still decided by facts.
  if (!sessionId) {
    return reconcileUnattributedHook(state, event, nowMs);
  }

  // H4 — child session. A root exists and this is a different session.
  if (state.rootSessionId !== null && state.rootSessionId !== sessionId) {
    return reconcileChildHook(state, event, sessionId);
  }

  return reconcileRootHook(state, event, sessionId, ctx);
}

function reconcileUnattributedHook(
  state: PaneAgentState,
  event: AgentHookEvent,
  nowMs: number,
): ReconcileResult {
  const label = `${event.type} hook without a session id`;
  if (state.hookDriven) {
    return result(state, state, `${label} ignored: pane is hook-driven`);
  }
  let next: PaneAgentState = {
    ...state,
    lastUnattributedHookAt: nowMs,
    kind: state.kind ?? event.agentKind,
  };
  if (isActiveStatus(event.status)) {
    next = withStatus(next, event.status, label);
  } else if (event.type === "SessionEnd") {
    next = { ...withStatus(next, "idle", label), kind: null };
  } else if (event.type === "Stop" || event.type === "StopFailure") {
    // The old detector dropped a terminal status for an agent never active.
    if (!isActiveStatus(state.status)) {
      return result(state, next, `${label} ignored: no turn in progress`);
    }
    next = withStatus(next, event.type === "Stop" ? "responded" : "error", label);
  }
  return result(state, next, label);
}

function reconcileChildHook(
  state: PaneAgentState,
  event: AgentHookEvent,
  sessionId: string,
): ReconcileResult {
  const children = state.children.has(sessionId)
    ? state.children
    : new Set([...state.children, sessionId]);
  const recorded: PaneAgentState = children === state.children ? state : { ...state, children };
  const label = `child session ${event.type} hook`;

  // Only the root's own signals end a turn.
  if (!isActiveStatus(event.status)) {
    return result(state, recorded, `${label} ignored: only the root session ends a turn`);
  }
  // A child's activity shows on the pane while the root's turn is in progress
  // (active or held Stop); it never reopens a finished turn.
  const turnInProgress = state.phase === "active" || state.phase === "pendingStop";
  if (!turnInProgress) {
    return result(state, recorded, `${label} ignored: root turn not in progress`);
  }
  // A child's permission prompt raises the pane to requires_input, so it is
  // visible. The child owns that prompt until it moves on.
  if (event.status === "requires_input") {
    if (state.status === "requires_input") {
      return result(state, recorded, `${label}: pane already requires input`);
    }
    const next = withStatus(recorded, "requires_input", label, sessionId);
    return result(state, next, label);
  }
  // thinking / working: follows the pane from thinking / working, or from a
  // prompt this same child raised. Never lowers a prompt another session
  // (the root or another child) raised.
  if (state.status === "requires_input" && state.inputSessionId !== sessionId) {
    return result(state, recorded, `${label} ignored: another session requires input`);
  }
  if (state.status !== "thinking" && state.status !== "working" && state.status !== "requires_input") {
    return result(state, recorded, `${label} ignored: root is ${state.status}`);
  }
  const next = withStatus(recorded, event.status, label);
  return result(state, next, label);
}

function reconcileRootHook(
  state: PaneAgentState,
  event: AgentHookEvent,
  sessionId: string,
  ctx: ReconcileContext,
): ReconcileResult {
  const { existingAgent, nowMs } = ctx;
  const hookLabel = `${event.type} hook`;
  const hadTurn = state.phase !== "none";

  // H6 — hasBeenActive guard: a terminal hook for a root that has never been
  // active is dropped, and does not claim the pane (ADR-139). SessionEnd still
  // ends a root claimed by SessionStart.
  if (!isActiveStatus(event.status) && !hadTurn) {
    if (event.type === "SessionEnd" && state.rootSessionId === sessionId) {
      const next = { ...withStatus(withoutRoot(state), "idle", "SessionEnd hook"), kind: null };
      return result(state, next, "SessionEnd hook: session ended before any turn");
    }
    return result(state, state, `${hookLabel} ignored: session never active`);
  }

  // H5 — root session. Claim the root on first sight; the pane is hook-driven
  // from the root's first hook until the session ends.
  let next: PaneAgentState = {
    ...state,
    rootSessionId: sessionId,
    hookDriven: true,
    kind: event.agentKind,
    lastHookAt: nowMs,
  };
  if (!hadTurn) {
    next = { ...next, phase: "active", activeSubagents: new Set(), pendingStopAt: null };
  }

  if (event.type === "SubagentStart") {
    const subs = new Set(next.activeSubagents);
    subs.add(event.toolUseId ?? `__fallback_${subs.size}`);
    next = { ...next, activeSubagents: subs };
  } else if (event.type === "SubagentStop") {
    const subs = new Set(next.activeSubagents);
    if (event.toolUseId) {
      subs.delete(event.toolUseId);
    } else {
      const first = subs.values().next().value;
      if (first !== undefined) subs.delete(first);
    }
    next = { ...next, activeSubagents: subs };
  }

  // Active hook: the turn is in progress; create or update the Agent. A held
  // Stop (`pendingStopAt`) is kept — T1 drains it once the root goes quiet.
  if (isActiveStatus(event.status)) {
    // The root's own hook is authoritative: it also takes over (or clears)
    // ownership of a prompt a child raised.
    next = {
      ...withStatus({ ...next, phase: "active" }, event.status, hookLabel, sessionId),
      inputSessionId: event.status === "requires_input" ? sessionId : null,
    };
    const effect: Effect = existingAgent
      ? {
          kind: "PersistAgentStatus",
          sessionId,
          transition: { to: "active", status: event.status },
        }
      : {
          kind: "CreateAgent",
          sessionId,
          paneId: state.paneId,
          agentKind: event.agentKind,
          status: event.status,
        };
    return result(state, next, hookLabel, [effect]);
  }

  // H7 — Stop.
  if (event.type === "Stop") {
    if (next.activeSubagents.size > 0) {
      const n = next.activeSubagents.size;
      next = {
        ...next,
        phase: "pendingStop",
        pendingStopAt: state.pendingStopAt ?? nowMs,
      };
      // Status is deliberately unchanged: the turn is not over while
      // subagents run (fixes "held Stop shows responded").
      return result(state, next, `Stop hook held: ${n} subagent${n === 1 ? "" : "s"} active`);
    }
    next = withStatus(
      { ...next, phase: "responded", pendingStopAt: null },
      "responded",
      "Stop hook",
    );
    return result(state, next, "Stop hook", [
      { kind: "PersistAgentStatus", sessionId, transition: { to: "responded" } },
    ]);
  }

  // H8 — SessionEnd: drain a held Stop so completion sees a responded Agent.
  if (event.type === "SessionEnd") {
    const effects: Effect[] = [];
    if (next.phase === "pendingStop") {
      effects.push({ kind: "PersistAgentStatus", sessionId, transition: { to: "responded" } });
    }
    effects.push({ kind: "PersistAgentStatus", sessionId, transition: { to: "completed" } });
    const ended = { ...withStatus(withoutRoot(next), "idle", "SessionEnd hook"), kind: null };
    return result(state, ended, "SessionEnd hook", effects);
  }

  // H9 — StopFailure. Turn state is dropped; the root stays (as in ADR-139).
  if (event.type === "StopFailure") {
    next = withStatus(
      { ...next, phase: "none", activeSubagents: new Set(), pendingStopAt: null },
      "error",
      "StopFailure hook",
    );
    return result(state, next, "StopFailure hook", [
      { kind: "PersistAgentStatus", sessionId, transition: { to: "error" } },
    ]);
  }

  // Defensive: a future hook variant without a row above.
  return result(state, next, `${hookLabel}: no rule`);
}

// ── Pane facts ──

/**
 * Whether the facts show no agent process in the pane (ported from
 * `AgentDetector.updateForegroundProcess`): no foreground process, or a shell
 * back in the foreground. A non-shell, non-agent process counts as the agent's
 * child while a turn is in progress, and as "agent gone" otherwise.
 */
function agentProcessGone(facts: PaneFacts, turnInProgress: boolean): boolean {
  const fg = facts.foreground;
  if (!fg) return true;
  if (fg.kind) return false;
  if (KNOWN_SHELLS.has(basename(fg.name))) return true;
  return !turnInProgress;
}

function reconcileFacts(
  state: PaneAgentState,
  facts: PaneFacts,
  ctx: ReconcileContext,
): ReconcileResult {
  const prevFacts = state.lastFacts;
  const recorded: PaneAgentState = { ...state, lastFacts: facts };
  const gone = agentProcessGone(facts, isActiveStatus(state.status));

  // F1 — liveness, for every Agent.
  if (gone && isLiveStatus(state.status)) {
    const reason = "agent process exited";
    const effects: Effect[] = [];
    const root = state.rootSessionId;
    const rootAgent = root !== null && ctx.existingAgent?.agentSessionId === root
      ? ctx.existingAgent
      : null;
    // The old `notifyAgentDetectorGone` bridge: a root stuck mid-turn gets its
    // Stop applied (lifecycle stays `active`, last status `responded`).
    if (root !== null && rootAgent && isActiveStatus(rootAgent.lastAgentStatus)) {
      effects.push({ kind: "PersistAgentStatus", sessionId: root, transition: { to: "responded" } });
    }
    const next: PaneAgentState = {
      ...withStatus(recorded, "idle", reason),
      kind: null,
      hookDriven: false,
      activeSubagents: new Set(),
      pendingStopAt: null,
      phase: state.phase === "none" ? "none" : "responded",
    };
    return result(state, next, reason, effects);
  }

  // F2 — hook-driven panes: hooks decide turn statuses.
  if (state.hookDriven) {
    return result(state, recorded, "pane facts ignored: pane is hook-driven");
  }

  // F3 — not hook-driven: facts decide every status.
  if (gone) {
    const next = { ...recorded, kind: null };
    return result(state, next, "no agent process in the foreground");
  }

  let next = recorded;
  let reason = "pane facts: no change";

  const fgKind = facts.foreground?.kind ?? null;
  if (fgKind && fgKind !== state.kind) {
    // A newly seen agent stays idle until something shows it is busy.
    reason = `${fgKind} process in the foreground`;
    next = { ...withStatus(next, "idle", reason), kind: fgKind };
  }

  if (!next.kind) {
    return result(state, next, "pane facts ignored: no agent tracked");
  }

  const sinceHook =
    state.lastUnattributedHookAt === null ? Infinity : ctx.nowMs - state.lastUnattributedHookAt;
  if (sinceHook < HOOK_DEBOUNCE_MS) {
    return result(state, next, `pane facts debounced: hook ${sinceHook}ms ago`);
  }

  // Title rules, for the tracked Agent kind only, when the title changed.
  const titleRule = TITLE_RULES[next.kind];
  if (titleRule && facts.title && facts.title !== prevFacts?.title) {
    const verdict = titleRule(facts.title);
    if (verdict === "working") {
      reason = "title spinner";
      next = withStatus(next, "working", reason);
    } else if (verdict === "responded" && isActiveStatus(next.status)) {
      // A done marker only finishes a turn that was in progress.
      reason = "title done marker";
      next = withStatus(next, "responded", reason);
    }
  }

  // Output hint, when a new one arrived. Applied after the title, so it wins
  // (the order the old `session.ts` data handler applied them in).
  const hint = facts.outputHint;
  if (hint && hint.at !== prevFacts?.outputHint?.at) {
    if (hint.hint === "requires_input" && next.status === "responded") {
      // A prompt cannot open after the turn ended: leftover prompt text.
      reason = "output prompt ignored: turn already responded";
    } else {
      reason = `output hint: ${hint.hint}`;
      next = withStatus(next, hint.hint, reason);
    }
  }

  return result(state, next, reason);
}

// ── Ticks ──

function reconcileTick(
  state: PaneAgentState,
  nowMs: number,
  ctx: ReconcileContext,
): ReconcileResult {
  const agent = ctx.existingAgent;
  const root = state.rootSessionId;
  const rootAgent: AgentInfo | null =
    root !== null && agent?.agentSessionId === root ? agent : null;

  if (root !== null && state.phase !== "none") {
    const idle = state.lastHookAt !== null ? nowMs - state.lastHookAt : 0;
    const early = reconcileTurnTick(state, root, idle, rootAgent);
    if (early) return early;
  }

  // T3 — orphan recovery (ADR-132): an active Agent stuck mid-turn whose
  // session has no turn state (replacement / SessionEnd races, restarts).
  const age = ctx.existingAgentAgeMs;
  if (
    agent &&
    agent.status === "active" &&
    agent.agentSessionId &&
    !(agent.agentSessionId === root && state.phase !== "none") &&
    isActiveStatus(agent.lastAgentStatus) &&
    age !== undefined &&
    age >= ORPHAN_AGENT_MS
  ) {
    const reason = `orphaned agent recovered after ${Math.round(age / 1000)}s`;
    // Only show it on the pane when the pane still belongs to that session.
    const ownsPane = root === null || root === agent.agentSessionId;
    const next = ownsPane ? withStatus(state, "responded", reason) : state;
    return result(state, next, reason, [
      {
        kind: "PersistAgentStatus",
        sessionId: agent.agentSessionId,
        transition: { to: "responded" },
      },
    ]);
  }

  return result(state, state, "tick: no time-based rule due");
}

/** T1 / T2 — time-based rules for a root session with turn state. */
function reconcileTurnTick(
  state: PaneAgentState,
  root: string,
  idle: number,
  rootAgent: AgentInfo | null,
): ReconcileResult | null {
  // T1 — held-Stop drain (ADR-130).
  if (state.pendingStopAt !== null && idle > STALE_STOP_MS) {
    const reason = `held Stop applied after ${Math.round(idle / 1000)}s without a hook`;
    const next = withStatus(
      { ...state, phase: "responded", activeSubagents: new Set(), pendingStopAt: null },
      "responded",
      reason,
    );
    return result(state, next, reason, [
      { kind: "PersistAgentStatus", sessionId: root, transition: { to: "responded" } },
    ]);
  }

  // T2 — stuck-working safety net (ADR-131).
  if (
    state.phase === "active" &&
    idle > STALE_ACTIVE_MS &&
    rootAgent &&
    isActiveStatus(rootAgent.lastAgentStatus)
  ) {
    const reason = `no hook for ${Math.round(idle / 1000)}s (stuck-working recovery)`;
    const next = withStatus(
      { ...state, phase: "responded", activeSubagents: new Set() },
      "responded",
      reason,
    );
    return result(state, next, reason, [
      { kind: "PersistAgentStatus", sessionId: root, transition: { to: "responded" } },
    ]);
  }

  return null;
}

// ── User signals ──

function reconcileUser(
  state: PaneAgentState,
  action: UserAction,
  ctx: ReconcileContext,
): ReconcileResult {
  const agent = ctx.existingAgent;

  if (action === "markSeen") {
    if (!agent) return result(state, state, "marked seen: no agent");
    return result(state, state, "marked seen", [{ kind: "MarkSeen", agentId: agent.id }]);
  }

  // `agents:abandonForPane` and `/sessions/end` both move only an *active*
  // Agent to `abandoned`; one that completed or errored keeps that outcome.
  const reason = action === "abandon" ? "pane closed by the user" : "session ended by the user";
  const effects: Effect[] =
    agent && agent.status === "active"
      ? [{ kind: "PersistAgentStatus", sessionId: agent.agentSessionId, transition: { to: "abandoned" } }]
      : [];
  const next = { ...withStatus(withoutRoot(state), "idle", reason), kind: null };
  return result(state, next, reason, effects);
}
