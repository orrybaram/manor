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
 * Where it is absent, a client cannot tell what a snapshot covers and applies
 * everything.
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
 * 2 — `resized` replies only once the pty ioctl has landed, rather than as soon
 *     as a resize has been written towards it.
 *
 * 3 — a `resized` *stream* event, broadcast at the position in the output where
 *     the ioctl landed. A client applies its own grid resize there rather than
 *     guessing when — see ADR-164. A protocol-2 daemon never sends it, and a
 *     client that waits for one would never resize its grid at all.
 *
 * 4 — every resize *request* answers with a `resized` event, including one that
 *     changes nothing. That is what repairs a client whose grid has drifted
 *     away from the winsize (ADR-165), and a protocol-3 daemon stays silent for
 *     exactly the request that needs an answer — so it cannot serve this client
 *     correctly, however new its build looks. No wire *shape* changed here;
 *     the number is carrying the thing it exists to carry.
 *
 * 5 — a `paneFacts` stream event and a `getPaneFacts` request (ADR-184 §3).
 *     Main's Status reconciler reads Pane facts from them, and a protocol-4
 *     daemon sends neither.
 */
export const TERMINAL_HOST_PROTOCOL = 5;

// ── Handshake ──

/** The wire protocol a handshake reply reports; 0 when it reports none. */
export function daemonProtocolOf(response: ControlResponse): number {
  return response.type === "handshake" ? (response.protocol ?? 0) : 0;
}

/**
 * Whether the daemon that sent `response` must be replaced before it can serve
 * this client. Two independent reasons, and checking only the first is what
 * let ADR-159's fix sit inert in a running app for days:
 *
 * - **Different app version** — the daemon binary is mismatched.
 * - **Older wire protocol at the same app version** — two builds of one
 *   release meet across a protocol bump. Serving a terminal we know is broken
 *   is worse than replacing the daemon, even though replacing it ends live
 *   sessions.
 *
 * In a released build the second reason is unreachable — a protocol bump ships
 * inside a version bump, so the version check fires first. It exists for
 * development, where the version is constant across rebuilds and a daemon can
 * outlive the protocol it was built against by days.
 */
export function isDaemonStale(
  response: ControlResponse,
  clientVersion: string,
): boolean {
  if (response.type === "handshake" && response.daemonVersion !== clientVersion)
    return true;
  return daemonProtocolOf(response) < TERMINAL_HOST_PROTOCOL;
}

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
  | { type: "handshake"; clientVersion: string }
  /**
   * Run a command to completion. Answered out of order relative to other
   * requests on the socket — match the reply by `requestId`. `timeout` is in
   * ms (default 30000; `0` means none); `maxBuffer` caps stdout and stderr
   * each (default 10 MiB, at most 64 MiB) and truncates rather than failing.
   */
  | {
      type: "exec";
      cmd: string;
      args: string[];
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
    }
  /** Read a UTF-8 file of at most 10 MiB. Also answered out of order. */
  | { type: "readFile"; path: string }
  /**
   * Report how the daemon's own host was set up for shell integration and
   * agent hooks (ADR-160 ticket 10): zdotdir, hook scripts, agent connector
   * registration. A remote daemon does that once at startup; this returns
   * the cached result. Answered with `bootstrapped`. Sent by `RemoteBackend`
   * after connecting.
   */
  | { type: "bootstrap" }
  /**
   * Hook journal entries after `sinceSeq` (ADR-178 §2). Answered with
   * `hookReplay`; a daemon without a journal (Manor desktop's) answers
   * `error`.
   *
   * `headOnly` asks for the journal's position (`lastSeq`, `epoch`) without
   * any entries — how a client meeting a journal for the first time starts
   * from "now" instead of replaying its whole history.
   */
  | { type: "replayHooks"; sinceSeq: number; headOnly?: boolean }
  /**
   * The session's current Pane facts (ADR-184 §3), so main can resync after a
   * reconnect with nothing to replay. Answered with `paneFacts`; `facts` is
   * null when the daemon has no such session.
   */
  | { type: "getPaneFacts"; sessionId: string };

/**
 * A remote daemon's answer to `replayHooks` (ADR-178 §2): journal entries
 * with `seq > sinceSeq`, oldest first, and the journal's highest seq.
 * `lastSeq` may exceed the last entry's seq (and entries may start after
 * `sinceSeq + 1`) when compaction dropped what was asked for.
 */
export interface HookReplay {
  entries: HookJournalEntry[];
  lastSeq: number;
  /**
   * The journal's identity (see `HookJournal.epoch`). A different epoch than
   * last time means the journal was recreated. Every journal has one.
   */
  epoch: string;
}

/**
 * One agent-hook request as the hook script sent it: the query parameters of
 * `GET /hook/event` (paneId, eventType, kind, sessionId, ...). Kept in wire
 * form so the daemon journals exactly what Electron main would have parsed.
 */
export type HookPayload = Record<string, string>;

/** One entry of a remote daemon's hook journal (ADR-178 §2). */
export interface HookJournalEntry {
  /** Monotonic across daemon restarts; consecutive, starting at 1. */
  seq: number;
  /** Wall-clock ms when the daemon received the hook. */
  receivedAt: number;
  payload: HookPayload;
}

export type ControlResponse =
  | { type: "authOk"; version?: string }
  | { type: "created"; session: SessionInfo }
  | { type: "attached"; snapshot: TerminalSnapshot }
  | { type: "detached" }
  /** The pty is at the new size — the ioctl has landed, not merely been sent. */
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
      protocol?: number;
    }
  | { type: "error"; message: string }
  | {
      type: "execResult";
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }
  | { type: "fileContents"; contents: string }
  /**
   * `bootstrap` succeeded; `agents` lists the connectors registered.
   * `warnings`, when present, lists connectors that skipped registration
   * rather than risk clobbering a config the daemon couldn't safely parse
   * (e.g. unreadable or malformed JSON) — absent or empty means no issues.
   */
  | { type: "bootstrapped"; agents: string[]; warnings?: string[] }
  /** See `HookReplay`. */
  | ({ type: "hookReplay" } & HookReplay)
  /** See `getPaneFacts`. */
  | { type: "paneFacts"; facts: PaneFacts | null };

/**
 * A control message on the wire: the payload plus the id the client assigned
 * the request. The daemon echoes the id on every reply — the client matches
 * replies by it, since `exec`/`readFile` replies may overtake others. The
 * only reply without one is an "Invalid JSON" error for a line whose id could
 * not be recovered, and the client answers that by failing every pending
 * request rather than guessing which one it was.
 */
export type Envelope<T> = T & { requestId: string };

type Reply<T extends ControlResponse["type"]> = Extract<ControlResponse, { type: T }>;

/** Fails to compile unless every request type has an entry. */
type ExhaustiveResponseMap<
  M extends Record<ControlRequest["type"], ControlResponse>,
> = M;

type ResponseMap = ExhaustiveResponseMap<{
  auth: Reply<"authOk">;
  create: Reply<"created">;
  attach: Reply<"attached" | "notFound">;
  detach: Reply<"detached">;
  resize: Reply<"resized">;
  kill: Reply<"killed">;
  getSnapshot: Reply<"snapshot" | "notFound">;
  listSessions: Reply<"sessions">;
  writeAfterReady: Reply<"writeQueued">;
  ping: Reply<"pong">;
  updateEnv: Reply<"envUpdated">;
  disposeDead: Reply<"disposedDead">;
  handshake: Reply<"handshake">;
  exec: Reply<"execResult">;
  readFile: Reply<"fileContents">;
  bootstrap: Reply<"bootstrapped">;
  replayHooks: Reply<"hookReplay">;
  getPaneFacts: Reply<"paneFacts">;
}>;

/** The replies a request of type `T` can get: its own, or an `error`. */
export type ResponseFor<T extends ControlRequest["type"]> =
  | ResponseMap[T]
  | Reply<"error">;

/** The replies that answer a request of type `T` successfully. */
export type SuccessFor<T extends ControlRequest["type"]> = ResponseMap[T];

/**
 * `ResponseMap` at run time: the reply types each request succeeds with. The
 * client checks replies against it, so a wrong one fails loudly rather than
 * being read as something it is not.
 */
export const REPLY_TYPES = {
  auth: ["authOk"],
  create: ["created"],
  attach: ["attached", "notFound"],
  detach: ["detached"],
  resize: ["resized"],
  kill: ["killed"],
  getSnapshot: ["snapshot", "notFound"],
  listSessions: ["sessions"],
  writeAfterReady: ["writeQueued"],
  ping: ["pong"],
  updateEnv: ["envUpdated"],
  disposeDead: ["disposedDead"],
  handshake: ["handshake"],
  exec: ["execResult"],
  readFile: ["fileContents"],
  bootstrap: ["bootstrapped"],
  replayHooks: ["hookReplay"],
  getPaneFacts: ["paneFacts"],
} as const satisfies {
  [K in ControlRequest["type"]]: readonly SuccessFor<K>["type"][];
};

// ── ssh bridge preamble ──

/**
 * The one-line JSON preamble `manor-host remote-bridge` writes to stdout
 * before any protocol bytes (see bridge.ts), carrying the daemon's auth token.
 * `SshTransport` strips it before handing the connection to the client.
 */
export interface BridgeHello {
  type: "bridgeHello";
  token: string;
}

/** `line` as a `BridgeHello`, or null for anything else (e.g. shell rc noise). */
export function parseHello(line: string): BridgeHello | null {
  try {
    const value = JSON.parse(line) as Partial<BridgeHello> | null;
    if (value && value.type === "bridgeHello" && typeof value.token === "string") {
      return { type: "bridgeHello", token: value.token };
    }
  } catch {
    // Not JSON.
  }
  return null;
}

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

// ── Pane facts (ADR-184 §3) ──

/**
 * What an output pattern suggests the pane is doing. A raw fact, not an Agent
 * status: the Status reconciler decides what it means.
 */
export type OutputHint = "thinking" | "working" | "requires_input" | "idle";

/**
 * The daemon's latest snapshot of what it can see in a pane. A source of Status
 * signals, never an Agent status (ADR-184 §3). Produced by the daemon's
 * `PaneFactsExtractor` (`pane-facts.ts`) and consumed by the Status reconciler
 * (`electron/agent-status`). Lives here so the daemon bundle and main share it
 * without either pulling in the other's dependencies.
 */
export interface PaneFacts {
  /**
   * Foreground process, with its Agent kind when it is a known agent CLI;
   * null when the shell itself is in the foreground.
   */
  foreground: { name: string; kind: AgentKind | null } | null;
  /** Last terminal title (OSC 0/2), or null. */
  title: string | null;
  /**
   * Last output hint and when it was seen (monotonic ms on the daemon's clock),
   * or null. `at` changes for every new hint, so it identifies one: a consumer
   * re-applies the hint only when `at` changes.
   */
  outputHint: { hint: OutputHint; at: number } | null;
}

// ── Stream socket event types ──

export type StreamEvent =
  | { type: "data"; sessionId: string; data: string; seq?: StreamPosition }
  /**
   * The session is gone. `lost` marks one the client synthesized because the
   * daemon no longer has it after a reconnect (the daemon restarted, the box
   * rebooted) — not a shell that exited. A remote pane keeps such a session's
   * pane and recovers it (ADR-178 §6); the local host closes it (ADR-169).
   */
  | { type: "exit"; sessionId: string; exitCode: number; lost?: true }
  | { type: "cwd"; sessionId: string; cwd: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "agentStatus"; sessionId: string; agent: AgentState }
  /** The session's Pane facts changed; `facts` is the whole new snapshot (ADR-184 §3). */
  | { type: "paneFacts"; sessionId: string; facts: PaneFacts }
  /**
   * The pty is at this size, and this is where in the stream it changed: every
   * byte before this event was produced at the old size, every byte after it at
   * the new one. Clients resize their emulator here.
   */
  | { type: "resized"; sessionId: string; cols: number; rows: number }
  | { type: "execStdout" | "execStderr"; execId: string; data: string }
  | { type: "execExit"; execId: string; exitCode: number | null }
  /**
   * An agent hook the daemon's listener received and journaled (ADR-178 §2).
   * Sent to every authenticated stream socket, subscribed or not.
   */
  | { type: "hookEvent"; seq: number; payload: HookPayload };

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
    }
  | {
      type: "execStream";
      execId: string;
      cmd: string;
      args: string[];
      cwd?: string;
      /** Overrides merged onto the daemon's own environment. */
      env?: Record<string, string>;
    }
  | { type: "execCancel"; execId: string };

// ── PTY Subprocess spawn payload ──

export interface PtySpawnPayload {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}
