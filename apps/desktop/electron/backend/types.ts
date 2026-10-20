// Re-export terminal-host types so consumers import from one place
export type {
  SessionInfo,
  TerminalSnapshot,
  TerminalModes,
  StreamEvent,
  AgentStatus,
  AgentKind,
  AgentState,
  PaneFacts,
} from "../terminal-host/types";

import type {
  SessionInfo,
  TerminalSnapshot,
  StreamEvent,
  PaneFacts,
} from "../terminal-host/types";
import type { MachineFacts } from "./machine-facts";

export type { MachineFacts } from "./machine-facts";

// ── Pty Backend ──

export type StreamEventHandler = (event: StreamEvent) => void;

/**
 * How a pty call that opens a session may reach its host.
 * `wake: false` is a call nobody meant — a pane restored at launch — which a
 * remote host's gate answers without waking a sleeping box. Every backend
 * but that gate ignores it.
 */
export interface PtyConnectOptions {
  wake?: boolean;
}

export interface PtyBackend {
  /**
   * `env` is merged into the spawn environment of a session this call creates
   * — `MANOR_AGENT_KIND`, which the agent hook script reads to know what it
   * is reporting for. Ignored for a warm reattach: the
   * session's environment was fixed when it was spawned.
   *
   * It was once missing from this interface, while
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
    connect?: PtyConnectOptions,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }>;

  /**
   * Attach to a session whose shell is still running, and snapshot it. Never
   * spawns and never resizes; null when there is no such live session.
   */
  attachExisting(sessionId: string, connect?: PtyConnectOptions): Promise<TerminalSnapshot | null>;

  write(sessionId: string, data: string): void;

  /**
   * Queue a write that fires once the session's shell has produced output —
   * i.e. has reached a prompt. What a pending pane command is typed with
   * and what the prewarm manager injects with: a write
   * sent the instant a session is spawned lands in a line editor that has not
   * initialised yet and is swallowed.
   */
  writeAfterReady(sessionId: string, data: string): Promise<void>;

  /** Resize a session, resolving once the backend's pty is at that size. */
  resize(sessionId: string, cols: number, rows: number): Promise<void>;

  kill(sessionId: string): Promise<void>;

  detach(sessionId: string): Promise<void>;

  getSnapshot(sessionId: string): Promise<TerminalSnapshot | null>;

  /**
   * A session's current Pane facts, or null when the host has no
   * such session. Main resyncs with it after a reconnect.
   */
  getPaneFacts(sessionId: string): Promise<PaneFacts | null>;

  listSessions(): Promise<SessionInfo[]>;

  disposeDead(): Promise<void>;

  /** Subscribe to the host's stream events. Returns an unsubscribe. */
  onEvent(handler: StreamEventHandler): () => void;

  updateEnv(env: Record<string, string>): Promise<void>;
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
   * `git clone --progress <repoUrl> <targetDir>`.
   * `targetDir` must not exist yet, or must be empty — the caller checks
   * that before calling. `onLine` gets each progress line git writes to
   * stderr during a clone; mirrors `pushStream`'s shape so both stream
   * through the same gate in the registry's host view.
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
   * unborn branch, etc.).
   */
  currentBranch(repoPath: string): Promise<string | null>;
}

// ── Shell Backend ──

export interface ShellBackend {
  /** Resolve a binary name to its absolute path (like `which`). */
  which(bin: string): Promise<string | null>;

  /** Execute a command and return stdout. */
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ): Promise<string>;

  /**
   * The home directory on the machine this backend runs commands on: its `MachineFacts.homeDir`.
   */
  homeDir(): Promise<string>;

  /**
   * Write `data` to `path` on the machine this backend runs commands on,
   * creating its parent directories and replacing any file already there
   * (a pasted image uploaded to a remote host).
   */
  writeFile(path: string, data: Buffer): Promise<void>;
}

// ── Ports Backend ──

/** A listening port as one host's backend reports it. */
export interface ScannedPort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;
  /**
   * `"::1"` when the port is listened on only at the IPv6 loopback, so a
   * forward must target `[::1]` rather than 127.0.0.1.
   */
  loopbackHost?: "::1";
}

/** A scanned port tagged with the host it listens on — `"local"` included. */
export interface ActivePort extends ScannedPort {
  hostId: string;
}

export interface PortsBackend {
  scan(workspacePaths: string[]): Promise<ScannedPort[]>;

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
 * - `hostRetrying` — a reconnect attempt failed; the next one is in
 *   `retryInMs`. `sessionIds` is empty (nothing changed about them).
 * - `hostReconnected` — the connection is back. `sessionIds` are the
 *   sessions that survived; whatever they printed during the gap was not
 *   delivered, so the renderer must resnapshot them via `getSnapshot`.
 *   Sessions that did not survive get an `exit` stream event marked `lost`.
 * - `hostFailed` — reconnecting hit a failure retrying will not fix (see
 *   `HostFailure`), so it stopped. `sessionIds` are still wanted; a later
 *   `connect()` retries, and on success `hostReconnected` follows.
 */
export type HostConnectionEvent =
  | { type: "hostDisconnected"; sessionIds: string[]; retryInMs: number | null }
  | { type: "hostRetrying"; sessionIds: string[]; retryInMs: number }
  | { type: "hostReconnected"; sessionIds: string[] }
  | ({ type: "hostFailed"; sessionIds: string[] } & HostFailure);

/**
 * Why a host cannot be reached until the user does something:
 * - `auth` — ssh could not authenticate.
 * - `host-key` — the host key is unknown or has changed.
 * - `bootstrap` — the host cannot run the daemon (`code` says why: e.g.
 *   `node-missing`, `unsupported-platform`, `install-failed`).
 * - `recipe` — the host's recipe failed or said something Manor can't use;
 *  the message quotes its stderr's tail.
 */
export interface HostFailure {
  reason: "auth" | "host-key" | "bootstrap" | "recipe";
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

/** A host's id: `LOCAL_HOST_ID`, or a registered remote host's. */
export type HostId = string;

/**
 * How to reach a remote host. Persisted per host in
 * `projects.json`; a `BackendRegistry` turns it into a `WorkspaceBackend`.
 * A discriminated union so other ways of reaching a box (managed providers)
 * are additions, not a migration.
 *
 * - `ssh`: a box the user brings, at an ssh target.
 * - `recipe`: a box Manor starts, stops and deletes with the user's own
 *   commands in `~/.manor/host-recipes/<recipeId>/`.
 */
export type HostSpec = { kind: "ssh"; target: string } | { kind: "recipe"; recipeId: string };

/** Whether `value` is a `HostSpec` this build knows, e.g. read back from disk. */
export function isHostSpec(value: unknown): value is HostSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as { kind?: unknown; target?: unknown; recipeId?: unknown };
  if (spec.kind === "ssh") return typeof spec.target === "string" && spec.target !== "";
  if (spec.kind === "recipe") return typeof spec.recipeId === "string" && spec.recipeId !== "";
  return false;
}

// ── Workspace Backend (aggregate) ──

export interface WorkspaceBackend {
  readonly pty: PtyBackend;
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly ports: PortsBackend;
  /** What the host's machine is: its OS, home, files. */
  readonly facts: MachineFacts;

  /** Connect to the host, at the version the backend was built with. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * A remote host's backend: it reconnects by itself and reports how
 * that goes.
 */
export interface RemoteHostBackend extends WorkspaceBackend {
  /**
   * Observe loss and recovery of the host connection (see
   * `HostConnectionEvent`). Returns an unsubscribe.
   */
  onHostEvent(handler: HostConnectionEventHandler): () => void;

  /**
   * While reconnecting on its own: attempt now instead of waiting out the
   * backoff. Returns false if there is no wait to cut short.
   */
  retryNow(): boolean;

  /**
   * Ping the host once and resolve whether it answered, for a
   * wake check: a connection can be up but wedged, which only asking it
   * something — not merely "is the socket open" — would catch. A failure is
   * reported through `onHostEvent`'s `hostDisconnected`, same as a heartbeat
   * tick going unanswered.
   */
  checkLiveness(): Promise<boolean>;
}

