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
  HookReplay,
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
  /**
   * The host daemon's hook journal after `sinceSeq` (ADR-178 §2); `null`
   * when the daemon has no journal (it predates the request). Optional: only
   * a remote host's hooks are journaled, and the registry calls this only
   * for remote hosts. `headOnly` returns the journal's position with no
   * entries.
   */
  replayHooks?(
    sinceSeq: number,
    opts?: { headOnly?: boolean },
  ): Promise<HookReplay | null>;
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

  /**
   * `git clone --progress <repoUrl> <targetDir>` (ADR-178 ticket 5).
   * `targetDir` must not exist yet, or must be empty — the caller checks
   * that before calling. `onLine` gets each progress line git writes to
   * stderr during a clone; mirrors `pushStream`'s shape so both stream
   * through the same gate in `BackendRegistry`.
   */
  cloneStream(
    repoUrl: string,
    targetDir: string,
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

  /**
   * The current branch at `repoPath` (a repo or worktree root), or a short
   * SHA for a detached HEAD. `null` if it cannot be determined (not a repo,
   * unborn branch, etc.) — ADR-178 §3.
   */
  currentBranch(repoPath: string): Promise<string | null>;
}

// ── Shell Backend ──

export interface ShellBackend {
  /** Resolve a binary name to its absolute path (like `which`). */
  which(bin: string): Promise<string | null>;

  /** Execute a command and return stdout. */
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string>;

  /**
   * The home directory on the machine this backend runs commands on (ADR-178
   * §3). Local: `os.homedir()`. Remote: asked of the host and cached.
   */
  homeDir(): Promise<string>;
}

// ── Ports Backend ──

export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;
  /** The remote host the port is listening on; absent for this machine. */
  hostId?: string;
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

// ── Host connection events ──

/**
 * The connection to a backend's host dropped or came back. Not a
 * `StreamEvent`: those come from the daemon, and these are about losing it.
 *
 * - `hostDisconnected` — the transport died (for a remote host, the ssh
 *   child exited). `sessionIds` stop producing output; reconnect attempts
 *   follow, the next one after `retryInMs`.
 * - `hostReconnected` — the connection is back. `sessionIds` are the
 *   sessions that survived; whatever they printed during the gap was not
 *   delivered, so the renderer must resnapshot them via `getSnapshot`.
 *   Sessions that did not survive get an ordinary `exit` stream event.
 * - `hostFailed` — reconnecting hit a failure retrying will not fix (see
 *   `HostFailure`), so it stopped. `sessionIds` are still wanted; a later
 *   `connect()` retries, and on success `hostReconnected` follows.
 */
export type HostConnectionEvent =
  | { type: "hostDisconnected"; sessionIds: string[]; retryInMs: number | null }
  | { type: "hostReconnected"; sessionIds: string[] }
  | ({ type: "hostFailed"; sessionIds: string[] } & HostFailure);

/**
 * Why a host cannot be reached until the user does something:
 * - `auth` — ssh could not authenticate.
 * - `host-key` — the host key is unknown or has changed.
 * - `bootstrap` — the host cannot run the daemon (`code` says why: e.g.
 *   `node-missing`, `unsupported-platform`, `install-failed`).
 */
export interface HostFailure {
  reason: "auth" | "host-key" | "bootstrap";
  code?: string;
  message: string;
}

export type HostConnectionEventHandler = (event: HostConnectionEvent) => void;

// ── Hosts ──

/**
 * The host every project without a `hostId` lives on: this machine, reached
 * through the local terminal-host daemon.
 */
export const LOCAL_HOST_ID = "local";

/**
 * How to reach a remote host (ADR-160). Persisted per host in
 * `projects.json`; a `BackendRegistry` turns it into a `WorkspaceBackend`.
 * A discriminated union so other ways of reaching a box (ADR-178's managed
 * providers) are additions, not a migration.
 */
export type HostSpec = { kind: "ssh"; target: string };

// ── Workspace Backend (aggregate) ──

export interface WorkspaceBackend {
  readonly pty: PtyBackend;
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly ports: PortsBackend;

  connect(opts?: { version?: string }): Promise<void>;
  disconnect(): Promise<void>;

  /** Observe loss and recovery of the host connection (see `HostConnectionEvent`). */
  onHostEvent(handler: HostConnectionEventHandler): void;
}
