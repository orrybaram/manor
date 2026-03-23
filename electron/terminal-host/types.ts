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

/** Serialized terminal snapshot for warm restore */
export interface TerminalSnapshot {
  screenAnsi: string;
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
    }
  | { type: "attach"; sessionId: string }
  | { type: "detach"; sessionId: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "kill"; sessionId: string }
  | { type: "getSnapshot"; sessionId: string }
  | { type: "listSessions" }
  | { type: "ping" };

export type ControlResponse =
  | { type: "authOk"; version?: string }
  | { type: "created"; session: SessionInfo }
  | { type: "attached"; snapshot: TerminalSnapshot }
  | { type: "detached" }
  | { type: "resized" }
  | { type: "killed" }
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "pong" }
  | { type: "error"; message: string };

// ── Agent status types ──

export type AgentKind = "claude" | "opencode" | "codex";
export type AgentStatus = "idle" | "thinking" | "working" | "complete" | "requires_input" | "error" | "responded";

export interface AgentState {
  kind: AgentKind | null;
  status: AgentStatus;
  processName: string | null;
  since: number; // timestamp
  title: string | null;
}

// ── Stream socket event types ──

export type StreamEvent =
  | { type: "data"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; exitCode: number }
  | { type: "cwd"; sessionId: string; cwd: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "agentStatus"; sessionId: string; agent: AgentState };

// ── Stream socket commands (client → daemon, fire-and-forget) ──

export type StreamCommand =
  | { type: "write"; sessionId: string; data: string }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "agentHook"; sessionId: string; status: AgentStatus; kind: AgentKind };

// ── PTY Subprocess spawn payload ──

export interface PtySpawnPayload {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}
