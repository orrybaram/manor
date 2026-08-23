// ── Protocol types for Terminal Host daemon IPC ──

/** Terminal modes tracked by the headless emulator */
export interface TerminalModes {
  bracketedPaste: boolean;
  applicationCursor: boolean;
  applicationKeypad: boolean;
  mouseTracking: boolean;
  altScreen: boolean;
  reverseWraparound: boolean;
}

export const DEFAULT_TERMINAL_MODES: TerminalModes = {
  bracketedPaste: false,
  applicationCursor: false,
  applicationKeypad: false,
  mouseTracking: false,
  altScreen: false,
  reverseWraparound: false,
};

/**
 * Position in a session's output stream: the number of `data` events broadcast.
 *
 * Optional wherever it crosses the daemon↔app boundary — the daemon outlives
 * the app, so a new app can meet a daemon that predates ADR-159 and sends none.
 * Absent means "cannot tell what the snapshot covers", which is handled by
 * applying everything.
 */
export type StreamPosition = number;

/**
 * Version of the daemon↔client wire protocol, bumped whenever a change would
 * confuse the other side.
 *
 * Separate from the app version on purpose. A daemon outlives the app that
 * spawned it and is only replaced when the *app version* differs, so two builds
 * of the same release can meet across a protocol change — which is exactly how
 * a client that required `notFound` met a daemon that only said `error`.
 *
 * 1 — `notFound` replies, and `seq` on data events and snapshots (ADR-159).
 */
export const TERMINAL_HOST_PROTOCOL = 1;

/** Serialized terminal snapshot for warm restore */
export interface TerminalSnapshot {
  screenAnsi: string;
  /**
   * Position this screen reflects. A client that subscribed before snapshotting
   * uses it to skip the events already baked in.
   */
  seq?: StreamPosition;
  scrollbackAnsi: string;
  modes: TerminalModes;
  cwd: string | null;
  cols: number;
  rows: number;
}

/** Session info returned by list/create */
export interface SessionInfo {
  sessionId: string;
  cwd: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  prewarmed?: boolean;
}

// ── Control socket request types ──

export type ControlRequest =
  | { type: "auth"; token: string }
  | {
      type: "create";
      sessionId: string;
      cwd: string;
      cols: number;
      rows: number;
      shellArgs?: string[];
      prewarmed?: boolean;
      env?: Record<string, string>;
    }
  | { type: "attach"; sessionId: string }
  | { type: "detach"; sessionId: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "kill"; sessionId: string }
  | { type: "getSnapshot"; sessionId: string }
  | { type: "listSessions" }
  | { type: "writeAfterReady"; sessionId: string; data: string }
  | { type: "ping" }
  | { type: "updateEnv"; env: Record<string, string> }
  | { type: "disposeDead" }
  | { type: "handshake"; clientVersion: string };

export type ControlResponse =
  | { type: "authOk"; version?: string }
  | { type: "created"; session: SessionInfo }
  | { type: "attached"; snapshot: TerminalSnapshot }
  | { type: "detached" }
  | { type: "resized" }
  | { type: "killed" }
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  /**
   * The daemon has no session by that id — a fact, not a failure.
   *
   * Distinct from `error` on purpose: a client that reattaches decides whether
   * to spawn a fresh shell on this answer, and reading any error as "not there"
   * turns a transport hiccup into a live session silently treated as new.
   */
  | { type: "notFound"; sessionId: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "pong" }
  | { type: "envUpdated" }
  | { type: "writeQueued" }
  | { type: "disposedDead" }
  | {
      type: "handshake";
      daemonVersion: string;
      /** Absent from daemons older than TERMINAL_HOST_PROTOCOL 1. */
      protocol?: number;
    }
  | { type: "error"; message: string };

// ── Agent status types ──

export type AgentKind = "claude" | "opencode" | "codex" | "pi";
export type AgentStatus =
  | "idle"
  | "thinking"
  | "working"
  | "complete"
  | "requires_input"
  | "error"
  | "responded";

export interface AgentState {
  kind: AgentKind | null;
  status: AgentStatus;
  processName: string | null;
  since: number; // timestamp
  title: string | null;
}

// ── Stream socket event types ──

export type StreamEvent =
  | { type: "data"; sessionId: string; data: string; seq?: StreamPosition }
  | { type: "exit"; sessionId: string; exitCode: number }
  | { type: "cwd"; sessionId: string; cwd: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "agentStatus"; sessionId: string; agent: AgentState };

// ── Stream socket commands (client → daemon, fire-and-forget) ──

export type StreamCommand =
  | { type: "write"; sessionId: string; data: string }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | {
      type: "agentHook";
      sessionId: string;
      status: AgentStatus;
      kind: AgentKind;
    };

// ── PTY Subprocess spawn payload ──

export interface PtySpawnPayload {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}
