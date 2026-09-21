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
  /**
   * `env` is merged into the spawn environment of a session this call creates
   * — `MANOR_AGENT_KIND`, which the agent hook script reads to know what it
   * is reporting for (ADR-135 ticket 7). Ignored for a warm reattach: the
   * session's environment was fixed when it was spawned.
   *
   * It was missing from this interface until ADR-180 ticket 5, while
   * `ipc/pty.ts` passed it and `TerminalHostClient` accepted it — so the kind
   * was dropped in between, silently, and every hook defaulted to `claude`.
   * That gap was the `Expected 4-5 arguments, but got 6` in the electron
   * tsconfig's error baseline, which is how it was eventually found.
   */
  createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
    env?: Record<string, string>,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }>;

  write(sessionId: string, data: string): void;

  /**
   * Queue a write that fires once the session's shell has produced output —
   * i.e. has reached a prompt. What a pending pane command is typed with
   * (ADR-179 ticket 11) and what the prewarm manager injects with: a write
   * sent the instant a session is spawned lands in a line editor that has not
   * initialised yet and is swallowed.
   */
  writeAfterReady(sessionId: string, data: string): Promise<void>;

  /** Resize a session, resolving once the backend's pty is at that size. */
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

  pushStream(
    cwd: string,
    opts: { remote?: string; branch?: string; setUpstream?: boolean },
    callbacks: {
      onLine: (line: string) => void;
      onDone: (result: { exitCode: number | null; stderr: string }) => void;
    },
  ): { cancel: () => void };

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
