/**
 * Types for the Status reconciler (ADR-184).
 *
 * The Status reconciler is the one module that turns Status signals for a pane
 * into that pane's Agent status and the reason for it. See `/CONTEXT.md` for the
 * domain terms used here (Agent, Agent kind, Agent status, Status signal, Pane
 * facts, Hook-driven, Status reconciler).
 *
 * Everything in this file is data. The pure `reconcile()` function lives in
 * `./reconciler.ts`; a driver (ADR-184 ticket 3) owns the per-pane states and
 * applies the effects.
 */

import type { AgentHookEvent } from "../agent-hook-events";
import type { AgentInfo } from "../agent-persistence";
import type { AgentKind } from "../terminal-host/types";

export type { AgentKind };

// ── Agent status ──

/**
 * The one live state shown for an Agent's pane (ADR-184).
 *
 * There is no `"complete"`: a finished turn is `responded`, an ended session is
 * `idle` (and the Agent's lifecycle becomes `completed`). Local to this module
 * until ADR-184 ticket 5 unifies it with `terminal-host/types.ts`.
 */
export type AgentStatus =
  | "idle"
  | "thinking"
  | "working"
  | "requires_input"
  | "responded"
  | "error";

/** Agent statuses that mean a turn is in progress. */
export type ActiveAgentStatus = "thinking" | "working" | "requires_input";

/** An Agent's persisted lifecycle (`AgentInfo.status`). */
export type AgentLifecycle = AgentInfo["status"];

// ── Pane facts ──

/** What an output pattern suggests the pane is doing (ADR-184 §3). */
export type OutputHint = "thinking" | "working" | "requires_input" | "idle";

/**
 * The daemon's latest snapshot of what it can see in a pane. A source of Status
 * signals, never an Agent status (ADR-184 §3).
 */
export interface PaneFacts {
  /** Foreground process, with its Agent kind when it is a known agent CLI. */
  foreground: { name: string; kind: AgentKind | null } | null;
  /** Last terminal title (OSC 0/2), or null. */
  title: string | null;
  /** Last output hint and when it was seen (monotonic ms), or null. */
  outputHint: { hint: OutputHint; at: number } | null;
}

// ── Status signals ──

/** A user action that changes an Agent's lifecycle or unseen state. */
export type UserAction =
  /** The pane was closed (`agents:abandonForPane`). */
  | "abandon"
  /** The session was ended from outside (`/sessions/end`). */
  | "end"
  /** The user looked at the pane (`agents:markSeen`, `/agents/:id/seen`). */
  | "markSeen";

/** A single piece of evidence about an Agent's state (sealed union, ADR-184 §1). */
export type StatusSignal =
  | { type: "hook"; event: AgentHookEvent }
  | { type: "paneFacts"; facts: PaneFacts }
  /** The current monotonic time. Every time-based rule runs on a tick. */
  | { type: "tick"; nowMs: number }
  | { type: "user"; action: UserAction };

// ── Per-pane state ──

/**
 * Where the root session's turn is (ADR-139's `SessionPhase`, plus `none`).
 *
 * `none` means the root session has no turn state: it has never sent an active
 * hook, or its state was dropped (StopFailure, replacement, session end). This
 * is what ADR-139 modelled as "no entry in sessionStateMap".
 */
export type TurnPhase = "none" | "active" | "pendingStop" | "responded";

/** The Status reconciler's state for one pane. Treated as immutable. */
export interface PaneAgentState {
  readonly paneId: string;
  /** The pane's root session (the Agent the user started there), or null. */
  readonly rootSessionId: string | null;
  /** Child sessions seen on this pane while the current root was in place. */
  readonly children: ReadonlySet<string>;
  readonly phase: TurnPhase;
  /** True from the root session's first hook until it ends (ADR-184 §1). */
  readonly hookDriven: boolean;
  /** Subagents (by toolUseId) the root has started and not yet stopped. */
  readonly activeSubagents: ReadonlySet<string>;
  /** Monotonic ms of the root session's last hook, or null. */
  readonly lastHookAt: number | null;
  /** Monotonic ms when a Stop was first held for active subagents, or null. */
  readonly pendingStopAt: number | null;
  /**
   * Monotonic ms of the last hook that carried no session id. Such hooks cannot
   * make a pane hook-driven, but Pane facts may not override them for
   * `HOOK_DEBOUNCE_MS` (the old AgentDetector's debounce).
   */
  readonly lastUnattributedHookAt: number | null;
  /** The last Pane facts received, or null. */
  readonly lastFacts: PaneFacts | null;
  /** The Agent kind currently tracked on the pane, or null. */
  readonly kind: AgentKind | null;
  /** The pane's current Agent status. */
  readonly status: AgentStatus;
  /** Why the pane has its current Agent status (published with it). */
  readonly statusReason: string;
  /**
   * The session whose hook put the pane in `requires_input` (the root or a
   * child), or null. Lets a child that raised its own permission prompt lower
   * the pane again when it moves on, without letting any child lower a prompt
   * it did not raise (ADR-184 rule H4).
   */
  readonly inputSessionId: string | null;
}

// ── Effects ──

/**
 * A named change to an Agent's persisted lifecycle and last Agent status. The
 * applier performs the write together with its unseen / notification /
 * broadcast side effects, in the ADR-139 order:
 *
 * - `active`    (was `UpdateAgentActiveStatus`): lifecycle `active`, last status
 *               = `status`, stamp `activatedAt` if unset; `requires_input` adds
 *               to unseen-input; notify; broadcast.
 * - `responded` (was `ApplyStop` / `applyStopForSession`): lifecycle `active`,
 *               last status `responded`; add to unseen-responded; notify;
 *               broadcast.
 * - `completed` (was `MarkCompleted`): lifecycle `completed`, last status
 *               `idle` (was `"complete"`), `completedAt`; clear unseen; broadcast.
 * - `error`     (was `MarkError`): lifecycle `error`, last status `error`,
 *               `completedAt`; clear unseen; broadcast.
 * - `abandoned` (was the `agents:abandonForPane` / `/sessions/end` write):
 *               lifecycle `abandoned`, `completedAt`; broadcast.
 */
export type AgentStatusTransition =
  | { to: "active"; status: ActiveAgentStatus }
  | { to: "responded" }
  | { to: "completed" }
  | { to: "error" }
  | { to: "abandoned" };

/**
 * Effects are data (ADR-184 §1). Extends ADR-139's union
 * (`hook-relay-transition.ts`):
 *
 * - `RelayAgentHook` is dropped; `PublishPaneStatus` replaces it.
 * - `ApplyStop`, `MarkCompleted`, `MarkError` and `UpdateAgentActiveStatus`
 *   become `PersistAgentStatus` transitions.
 * - `SetPaneRoot`, `DeletePaneRoot`, `DeleteSessionState` and
 *   `ForceCloseOldSession` are dropped: the pane's root and turn state now live
 *   in `PaneAgentState`, and a replaced root's forced Stop is an explicit
 *   `PersistAgentStatus { to: "responded" }` on the old session.
 */
export type Effect =
  | {
      kind: "CreateAgent";
      sessionId: string;
      paneId: string;
      agentKind: AgentKind;
      status: ActiveAgentStatus;
    }
  | {
      kind: "PersistAgentStatus";
      sessionId: string;
      transition: AgentStatusTransition;
    }
  | { kind: "MarkSeen"; agentId: string }
  | {
      kind: "PublishPaneStatus";
      paneId: string;
      status: AgentStatus;
      reason: string;
      agentKind: AgentKind | null;
    };

// ── reconcile() in/out ──

export interface ReconcileContext {
  /** Monotonic ms. A `tick` signal's own `nowMs` takes precedence. */
  nowMs: number;
  /**
   * The persisted Agent the signal concerns:
   * - `hook`: the Agent whose `agentSessionId` is the event's session id.
   * - `paneFacts` / `tick` / `user`: the Agent of the pane's root session if
   *   there is one, otherwise the Agent bound to the pane (`getAgentByPaneId`).
   */
  existingAgent: AgentInfo | null;
  /**
   * `tick` only: `existingAgent`'s age, from `activatedAt`, clamped by the
   * driver's monotonic run-time so a suspend/resume wall-clock jump cannot
   * trip the orphan rule (ADR-132). Omitted → the orphan rule does not fire.
   */
  existingAgentAgeMs?: number;
}

export interface ReconcileResult {
  state: PaneAgentState;
  status: AgentStatus;
  /** Short human-readable reason for what this signal did. */
  reason: string;
  effects: Effect[];
}
