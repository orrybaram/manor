/**
 * Terminal session — manages a single PTY subprocess and its attached clients.
 *
 * Responsibilities:
 * - Spawns a PTY subprocess (child process)
 * - Forwards output to attached stream sockets
 * - Maintains a headless xterm emulator for snapshots
 * - Takes CWD (OSC 7), titles and terminal modes from that emulator's parser,
 *   so every byte is parsed once
 */

import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type net from "node:net";
import "./xterm-env-polyfill";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  MSG,
  FrameDecoder,
  encodeFrame,
  encodeJsonFrame,
} from "./pty-subprocess-ipc";
import { ShellManager } from "../shell";
import { manorBinDir } from "../paths";
import { ScrollbackWriter } from "./scrollback";
import { PaneFactsExtractor } from "./pane-facts";
import type {
  TerminalSnapshot,
  TerminalModes,
  SessionInfo,
  StreamEvent,
  PtySpawnPayload,
  PaneFacts,
} from "./types";

/**
 * The argv for a pane's shell. A plain bash pane starts with Manor's rcfile
 * (which sources ~/.bashrc and adds OSC 7 prompt reporting), the way zsh
 * gets it through ZDOTDIR; explicit args and other shells pass through.
 */
export function spawnArgsFor(
  shell: string,
  args: string[],
  bashrcPath: () => string = () => ShellManager.bashrcPath(),
): string[] {
  if (args.length > 0 || path.basename(shell) !== "bash") return args;
  const bashrc = bashrcPath();
  // `--rcfile` replaces ~/.bashrc, so a missing file would drop the user's rc
  // too — fall back to plain bash until the daemon's bootstrap writes it.
  if (!fs.existsSync(bashrc)) return args;
  return ["--rcfile", bashrc];
}

/**
 * Build the environment for a user-facing PTY shell.
 *
 * Strips vars that must not leak from the Manor Electron process into user shells:
 *   - NODE_ENV  — set to 'development' by Vite; tools like Jest and Next.js need
 *                 to set it themselves from a clean slate.
 *   - ELECTRON_* — Electron-runtime vars with no meaning in a user shell.
 *
 * The pty-subprocess.js fork() is intentionally excluded from this filtering; it
 * is a Node.js subprocess that legitimately needs the full process environment.
 *
 * @param base      Source environment (pass process.env in production)
 * @param overrides Manor-specific vars merged in last (MANOR_PANE_ID, TERM, etc.)
 */
export function buildShellEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "NODE_ENV") continue;
    if (key.startsWith("ELECTRON_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Prepend `~/.manor/bin` to PATH so `manor` (ADR-170) is reachable from every
 * Manor terminal. Skips the prepend if it's already present — the daemon's
 * own `process.env.PATH` may already contain it (e.g. inherited from a
 * parent process that put it there), and re-prepending on every session
 * spawn would otherwise grow PATH with a duplicate entry each time the
 * daemon restarts.
 */
export function prependManorBinDir(basePath: string | undefined): string {
  const existing = basePath ?? "";
  const binDir = manorBinDir();
  if (existing.split(":").includes(binDir)) return existing;
  return existing ? `${binDir}:${existing}` : binDir;
}

/** How long to wait for the pty subprocess to confirm a resize before giving up. */
const RESIZE_ACK_TIMEOUT_MS = 2_000;

export class Session {
  readonly sessionId: string;
  prewarmed = false;
  private subprocess: ChildProcess | null = null;
  private decoder: FrameDecoder;
  private headless: HeadlessTerminal;
  private serializeAddon: SerializeAddon;
  /** Attached stream sockets, each with the `close` listener it was given. */
  private attachedClients = new Map<net.Socket, () => void>();
  private cwd: string | null;
  private cols: number;
  private rows: number;
  private _alive = true;
  private exitCode = 0;
  private pid: number | null = null;

  /**
   * Position of the last `data` event broadcast. Stamped on each event so a
   * reattaching client can tell which output its snapshot already contains.
   * Counts events rather than bytes — the client drops whole chunks, and bytes
   * would mean tracking encodings.
   */
  private outputSeq = 0;

  /**
   * Position of the last event the headless screen has actually applied, which
   * is what a snapshot reports.
   *
   * It trails `outputSeq` whenever writes are still in flight, and `getSnapshot`
   * normally waits for them — but `flushHeadless` gives up after 2s and
   * serializes anyway. Reporting the broadcast position there would tell the
   * client its snapshot covers output the screen never received, and the client
   * would drop exactly those chunks. Reporting the applied position makes the
   * worst case a duplicate rather than a hole.
   */
  private appliedSeq = 0;

  // Headless write flush tracking — write() is async, we need to
  // wait for it before serialize() will return content
  private headlessWritesPending = 0;
  private headlessFlushCallbacks: Array<() => void> = [];

  // Scrollback persistence
  private scrollbackWriter: ScrollbackWriter | null = null;

  // Pane facts (ADR-184 §3): the daemon's only source of Status signals.
  private paneFacts: PaneFactsExtractor;

  // Pending writes queued before first output (for prewarmed command injection)
  private pendingWrites: string[] = [];
  private hasReceivedOutput = false;

  /**
   * Resizes sent to the subprocess that have not been acknowledged yet, oldest
   * first. The subprocess answers each one after the ioctl has landed, which is
   * the only moment the winsize the program reads actually changed — the write
   * to its stdin is not.
   *
   * Each carries the pair it was sent with, because an ack belongs to one
   * specific ioctl and that ioctl's size is what it reports. Reading
   * `this.cols`/`this.rows` instead — already the newest size asked for — makes
   * the first of two in-flight resizes publish the second one's size, which on
   * a shrinking drag hands clients a grid narrower than the pty their program
   * is reading from.
   */
  private pendingResizes: Array<{
    cols: number;
    rows: number;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  /** Optional extra env vars injected on top of the shell env at spawn time */
  private envOverrides: Record<string, string>;

  constructor(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    sessionsDir?: string,
    envOverrides?: Record<string, string>,
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.envOverrides = envOverrides ?? {};

    // Set up headless terminal for snapshots
    this.headless = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10_000,
    });
    this.serializeAddon = new SerializeAddon();
    this.headless.loadAddon(this.serializeAddon);

    // The headless mirror is the one parser of this session's output: CWD,
    // title and modes come from it, not from re-scanning each chunk (whose
    // escape sequences may be split across chunks, or combined).
    this.headless.parser.registerOscHandler(7, (payload) => {
      this.extractOsc7Cwd(payload);
      return true;
    });
    this.headless.onTitleChange((title) => this.paneFacts.setTitle(title));

    // Frame decoder for subprocess output
    this.decoder = new FrameDecoder((type, payload) => {
      this.handleSubprocessFrame(type, payload);
    });

    // Scrollback persistence
    if (sessionsDir !== undefined) {
      this.scrollbackWriter = new ScrollbackWriter(sessionId, sessionsDir);
      this.scrollbackWriter.init({ sessionId, cols, rows, cwd });
    }

    this.paneFacts = new PaneFactsExtractor({
      onChange: (facts) => {
        this.broadcastEvent({ type: "paneFacts", sessionId: this.sessionId, facts });
      },
    });
  }

  get alive(): boolean {
    return this._alive;
  }

  /** The session's current Pane facts (ADR-184 §3). */
  getPaneFacts(): PaneFacts {
    return this.paneFacts.facts;
  }

  get info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      alive: this._alive,
    };
  }

  /** Spawn the PTY subprocess */
  spawn(shellArgs: string[] = []): void {
    const subprocessPath = path.join(__dirname, "pty-subprocess.js");

    this.subprocess = fork(subprocessPath, [], {
      stdio: ["pipe", "pipe", "inherit", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    // Read stdout from subprocess (binary frames)
    this.subprocess.stdout!.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
    });

    this.subprocess.on("exit", () => {
      if (this._alive) {
        this._alive = false;
        this.broadcastEvent({
          type: "exit",
          sessionId: this.sessionId,
          exitCode: this.exitCode,
        });
      }
    });

    // Wait for Ready, then send Spawn
    // The Ready handling is done in handleSubprocessFrame
    this.pendingSpawnArgs = shellArgs;
  }

  private pendingSpawnArgs: string[] = [];

  private handleSubprocessFrame(type: number, payload: Buffer): void {
    switch (type) {
      case MSG.READY: {
        // Subprocess is ready — send spawn command
        const zdotdir = ShellManager.zdotdirPath();
        const shell = process.env.SHELL || "/bin/zsh";

        // HISTFILE for shared history is set directly in the generated .zshrc
        // (see ShellManager.setupZdotdir), not injected here — so it can't go
        // stale when this daemon outlives a code change.
        const spawnPayload: PtySpawnPayload = {
          shell,
          args: spawnArgsFor(shell, this.pendingSpawnArgs),
          cwd: this.cwd || process.env.HOME || "/",
          cols: this.cols,
          rows: this.rows,
          env: buildShellEnv(process.env, {
            MANOR_PANE_ID: this.sessionId,
            TERM: "xterm-256color",
            ZDOTDIR: zdotdir,
            REAL_ZDOTDIR: ShellManager.realZdotdir(),
            PATH: prependManorBinDir(process.env.PATH),
            ...this.envOverrides,
          }),
        };

        this.writeToSubprocess(encodeJsonFrame(MSG.SPAWN, spawnPayload));
        break;
      }

      case MSG.SPAWNED: {
        const { pid } = JSON.parse(payload.toString("utf-8"));
        this.pid = pid;
        break;
      }

      case MSG.DATA: {
        const data = payload.toString("utf-8");

        // Flush any writes queued before first output (e.g. prewarmed agent command)
        if (!this.hasReceivedOutput) {
          this.hasReceivedOutput = true;
          for (const pending of this.pendingWrites) {
            this.write(pending);
          }
          this.pendingWrites = [];
        }

        // Feed headless emulator (async — write callback fires after processing).
        // Its OSC and title handlers fire while it parses the chunk; output
        // hints follow in the callback, so Pane facts keep the stream's order.
        const seq = ++this.outputSeq;
        this.writeHeadless(data, () => {
          this.paneFacts.feedData(data);
          this.appliedSeq = seq;
        });

        // Scrollback persistence
        if (this.scrollbackWriter) {
          this.scrollbackWriter.append(data);
          // Detect clear-scrollback escape (\e[3J)
          if (data.includes("\x1b[3J")) {
            void this.scrollbackWriter.handleClearScrollback();
          }
        }

        // Broadcast to attached clients
        this.broadcastEvent({
          type: "data",
          sessionId: this.sessionId,
          data,
          seq,
        });
        break;
      }

      case MSG.EXIT: {
        const { exitCode } = JSON.parse(payload.toString("utf-8"));
        this.exitCode = exitCode;
        this._alive = false;
        this.scrollbackWriter?.end();
        this.scrollbackWriter?.dispose();
        this.broadcastEvent({
          type: "exit",
          sessionId: this.sessionId,
          exitCode,
        });
        break;
      }

      case MSG.ERROR: {
        const { message } = JSON.parse(payload.toString("utf-8"));
        this.broadcastEvent({
          type: "error",
          sessionId: this.sessionId,
          message,
        });
        break;
      }

      case MSG.RESIZED: {
        const pending = this.pendingResizes.shift();
        if (!pending) break;
        clearTimeout(pending.timer);
        this.applyResized(pending.cols, pending.rows);
        pending.resolve();
        break;
      }

      case MSG.FGPROC: {
        const { name } = JSON.parse(payload.toString("utf-8")) as { name: string | null };
        // Behind the mirror's write queue, like the output hints it resets.
        this.writeHeadless("", () => this.paneFacts.setForeground(name));
        break;
      }
    }
  }

  /** Write terminal input to the subprocess */
  write(data: string): void {
    if (!this._alive || !this.subprocess) return;
    this.writeToSubprocess(encodeFrame(MSG.WRITE, data));
  }

  /** Queue a write that fires after the shell emits its first output (prompt) */
  writeAfterReady(data: string): void {
    if (this.hasReceivedOutput) {
      this.write(data);
    } else {
      this.pendingWrites.push(data);
    }
  }

  /**
   * Resize the PTY, resolving once the ioctl has landed.
   *
   * The distinction is the whole point: writing a resize towards the subprocess
   * says nothing about when the winsize a program reads actually changed, and a
   * client that moves its own grid on that reply moves it too early.
   */
  async resize(cols: number, rows: number): Promise<void> {
    if (this.cols === cols && this.rows === rows) {
      // Say so anyway, rather than returning silently.
      //
      // A client whose grid has drifted away from the winsize asks for the
      // size it should already have, and this event is the only thing that
      // puts it back. Staying quiet is what turns such a disagreement from a
      // moment into a permanent one — and a grid that wraps at a different
      // width than the program does strands a copy of every frame the program
      // repaints, off the top of the screen where nothing can erase it
      // afterwards (ADR-165).
      //
      // A client that already agrees drops this without touching its terminal.
      // The ioctl is skipped, so no program is made to repaint for a request
      // that changed nothing.
      this.applyResized(cols, rows);
      return;
    }
    this.cols = cols;
    this.rows = rows;
    if (!this.subprocess || !this._alive) {
      this.applyResized(cols, rows);
      return;
    }
    return new Promise<void>((resolve) => {
      // A subprocess that dies mid-resize would otherwise leave the caller —
      // and the terminal it is holding at the old size — waiting forever. The
      // oldest pending resize is always the first to time out, so it is the one
      // at the head of the queue.
      const timer = setTimeout(() => {
        if (this.pendingResizes[0]?.timer === timer) this.pendingResizes.shift();
        // A client left waiting on an event that will never come would keep its
        // grid at the old size for good, so the timeout publishes one too.
        this.applyResized(cols, rows);
        resolve();
      }, RESIZE_ACK_TIMEOUT_MS);
      this.pendingResizes.push({ cols, rows, resolve, timer });
      this.writeToSubprocess(encodeJsonFrame(MSG.RESIZE, { cols, rows }));
    });
  }

  /**
   * Publish where in the stream the size changed, and bring the mirror with it.
   *
   * Attached clients apply the resize at the position in the byte stream they
   * are reading, so their emulator and the program's belief about the width
   * change together — which is the whole of ADR-164.
   *
   * The two halves are ordered differently on purpose, and getting that wrong
   * reopens the gap ADR-164 exists to close:
   *
   * - The **mirror** resizes behind its own write queue. The subprocess flushed
   *   its output before the ioctl, so everything drawn at the old size is
   *   already queued here and a bare `resize` would jump it.
   * - The **broadcast** goes out synchronously, because a client's position in
   *   the stream is its position among the events *this* object broadcasts —
   *   and `data` is broadcast the moment its frame is decoded. Publishing from
   *   inside the callback above would put the resize behind whatever the mirror
   *   still has to parse while post-resize output kept overtaking it.
   */
  private applyResized(cols: number, rows: number): void {
    this.headless.write("", () => {
      this.headless.resize(cols, rows);
    });
    this.broadcastEvent({
      type: "resized",
      sessionId: this.sessionId,
      cols,
      rows,
    });
  }

  /** Dispose of this session entirely */
  dispose(): void {
    this.disposeInternal();
  }

  /**
   * Resolves once every scrollback and meta.json write this session has
   * started has landed on disk. Scrollback writes run async, so the daemon
   * waits on this before it exits.
   */
  whenPersisted(): Promise<void> {
    return this.scrollbackWriter?.whenIdle() ?? Promise.resolve();
  }

  /** Dispose and wait for the subprocess to fully exit (used by kill path). */
  async disposeAndWait(timeoutMs = 3_000): Promise<void> {
    const proc = this.subprocess;
    this.disposeInternal();
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[session ${this.sessionId}] subprocess did not exit within ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private disposeInternal(): void {
    if (this.subprocess) {
      try {
        this.writeToSubprocess(encodeFrame(MSG.DISPOSE));
      } catch {
        // ignore
      }
      this.subprocess = null;
    }
    this._alive = false;
    for (const pending of this.pendingResizes.splice(0)) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    // Kept after disposal, which makes it inert, so `whenPersisted` can
    // still wait on its last writes.
    this.scrollbackWriter?.end();
    this.scrollbackWriter?.dispose();
    this.headless.dispose();
    this.detachAllClients();
  }

  /**
   * Write to the headless mirror and run `applied` once it has parsed `data`,
   * counting the write as pending until then so `flushHeadless` waits for it.
   */
  private writeHeadless(data: string, applied: () => void): void {
    this.headlessWritesPending++;
    this.headless.write(data, () => {
      applied();
      this.headlessWritesPending--;
      if (this.headlessWritesPending === 0) {
        const cbs = this.headlessFlushCallbacks.splice(0);
        for (const cb of cbs) cb();
      }
    });
  }

  /** Wait for all pending headless writes to flush */
  private flushHeadless(): Promise<void> {
    if (this.headlessWritesPending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(
          `[Session ${this.sessionId}] flushHeadless timed out after 2s with ${this.headlessWritesPending} pending write(s) — resolving anyway`,
        );
        resolve();
      }, 2000);
      this.headlessFlushCallbacks.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Get a snapshot of the terminal state for warm restore */
  async getSnapshot(): Promise<TerminalSnapshot> {
    await this.flushHeadless();
    return {
      screenAnsi: this.serializeAddon.serialize(),
      seq: this.appliedSeq,
      scrollbackAnsi: "", // headless serialize already includes scrollback
      modes: this.modes(),
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /**
   * Attach a stream client socket. Attaching one already attached is a no-op.
   *
   * The `close` listener is removed again on detach and dispose: a stream
   * socket lives as long as the app's connection and subscribes over and over,
   * and a listener left behind each time would pile up on it and keep this
   * session — headless buffer and all — alive after it was killed.
   */
  attachClient(socket: net.Socket): void {
    if (this.attachedClients.has(socket)) return;
    const onClose = () => this.detachClient(socket);
    this.attachedClients.set(socket, onClose);
    socket.on("close", onClose);
  }

  /** Detach a stream client socket */
  detachClient(socket: net.Socket): void {
    const onClose = this.attachedClients.get(socket);
    if (!onClose) return;
    this.attachedClients.delete(socket);
    socket.off("close", onClose);
  }

  private detachAllClients(): void {
    for (const socket of [...this.attachedClients.keys()]) {
      this.detachClient(socket);
    }
  }

  /** Broadcast a stream event to all attached clients */
  private broadcastEvent(event: StreamEvent): void {
    const line = JSON.stringify(event) + "\n";
    for (const client of [...this.attachedClients.keys()]) {
      try {
        client.write(line);
      } catch {
        this.detachClient(client);
      }
    }
  }

  private writeToSubprocess(frame: Buffer): void {
    if (this.subprocess?.stdin?.writable) {
      this.subprocess.stdin.write(frame);
    }
  }

  // ── OSC 7 CWD ──

  private extractOsc7Cwd(payload: string): void {
    if (!payload.startsWith("file://")) return;
    const rest = payload.slice(7);
    const slashIdx = rest.indexOf("/");
    const p = slashIdx >= 0 ? rest.slice(slashIdx) : rest;
    this.cwd = decodeURIComponent(p);
    void this.scrollbackWriter?.updateCwd(this.cwd);
    this.broadcastEvent({
      type: "cwd",
      sessionId: this.sessionId,
      cwd: this.cwd,
    });
  }

  // ── Modes ──

  /** The terminal modes as the headless mirror has applied them. */
  private modes(): TerminalModes {
    const modes = this.headless.modes;
    return {
      bracketedPaste: modes.bracketedPasteMode,
      applicationCursor: modes.applicationCursorKeysMode,
      applicationKeypad: modes.applicationKeypadMode,
      mouseTracking: modes.mouseTrackingMode !== "none",
      altScreen: this.headless.buffer.active.type === "alternate",
      reverseWraparound: modes.reverseWraparoundMode,
    };
  }
}
