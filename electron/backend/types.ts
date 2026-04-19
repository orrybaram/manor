// Re-export terminal-host types so consumers import from one place
export type {
  SessionInfo,
  TerminalSnapshot,
  TerminalModes,
  StreamEvent,
  AgentStatus,
  AgentKind,
  AgentState,
} from "../terminal-host/types";

import type {
  SessionInfo,
  TerminalSnapshot,
  StreamEvent,
  AgentStatus,
  AgentKind,
} from "../terminal-host/types";

// ── Pty Backend ──

export type StreamEventHandler = (event: StreamEvent) => void;

export interface PtyBackend {
  createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }>;

  write(sessionId: string, data: string): void;

  resize(sessionId: string, cols: number, rows: number): Promise<void>;

  kill(sessionId: string): Promise<void>;

  detach(sessionId: string): Promise<void>;

  getSnapshot(sessionId: string): Promise<TerminalSnapshot | null>;

  listSessions(): Promise<SessionInfo[]>;

  disposeDead(): Promise<void>;

  onEvent(handler: StreamEventHandler): void;

  updateEnv(env: Record<string, string>): Promise<void>;

  relayAgentHook(
    sessionId: string,
    status: AgentStatus,
    kind: AgentKind,
  ): void;
}

// ── Git Backend ──

export interface GitBackend {
  /** Run an arbitrary git command. Returns stdout. */
  exec(cwd: string, args: string[]): Promise<string>;

  stage(cwd: string, files: string[]): Promise<void>;

  unstage(cwd: string, files: string[]): Promise<void>;

  discard(cwd: string, files: string[]): Promise<void>;

  commit(cwd: string, message: string, flags: string[]): Promise<void>;

  stash(cwd: string, files: string[]): Promise<void>;

  push(cwd: string, remote?: string, branch?: string): Promise<void>;

  getFullDiff(cwd: string, defaultBranch: string): Promise<string | null>;

  getLocalDiff(cwd: string): Promise<string | null>;

  getStagedFiles(cwd: string): Promise<string[]>;

  worktreeList(cwd: string): Promise<WorktreeInfo[]>;

  worktreeAdd(
    cwd: string,
    path: string,
    branch: string,
    opts?: { createBranch?: boolean; startPoint?: string },
  ): Promise<void>;

  worktreeRemove(cwd: string, path: string, force?: boolean): Promise<void>;
}

// ── Shell Backend ──

export interface ShellBackend {
  /** Resolve a binary name to its absolute path (like `which`). */
  which(bin: string): Promise<string | null>;

  /** Execute a command and return stdout. */
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string>;
}

// ── Ports Backend ──

export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;
}

export interface PortsBackend {
  scan(workspacePaths: string[]): Promise<ActivePort[]>;

  kill(pid: number): Promise<void>;
}

// ── Worktree Info ──

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
}

// ── Workspace Backend (aggregate) ──

export interface WorkspaceBackend {
  readonly pty: PtyBackend;
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly ports: PortsBackend;

  connect(opts?: { version?: string }): Promise<void>;
  disconnect(): Promise<void>;
}
