/**
 * Terminal session — manages a single PTY subprocess and its attached clients.
 *
 * Responsibilities:
 * - Spawns a PTY subprocess (child process)
 * - Forwards output to attached stream sockets
 * - Maintains a headless xterm emulator for snapshots
 * - Tracks CWD via OSC 7
 * - Tracks terminal modes
 */

import { fork, type ChildProcess } from "node:child_process";
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
import { ScrollbackWriter } from "./scrollback";
import { AgentDetector } from "./agent-detector";
import { OutputPatternMatcher } from "./output-pattern-matcher";
import { TitleDetector, OscTitleParser } from "./title-detector";
import type {
  TerminalSnapshot,
  TerminalModes,
  SessionInfo,
  StreamEvent,
  PtySpawnPayload,
  AgentStatus,
  AgentKind,
} from "./types";
import { DEFAULT_TERMINAL_MODES } from "./types";

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

/** How long to wait for the pty subprocess to confirm a resize before giving up. */
const RESIZE_ACK_TIMEOUT_MS = 2_000;

export class Session {
  readonly sessionId: string;
  prewarmed = false;
  private subprocess: ChildProcess | null = null;
  private decoder: FrameDecoder;
  private headless: HeadlessTerminal;
  private serializeAddon: SerializeAddon;
  private attachedClients = new Set<net.Socket>();
  private cwd: string | null;
  private cols: number;
  private rows: number;
  private modes: TerminalModes = { ...DEFAULT_TERMINAL_MODES };
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

  // Agent detection
  private agentDetector: AgentDetector;

  // Fallback detection
  private outputMatcher: OutputPatternMatcher;
  private titleDetector: TitleDetector;
  private oscTitleParser: OscTitleParser;
  private pidSweepTimer: ReturnType<typeof setInterval> | null = null;

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

  // OSC 7 parser state
  private oscBuf: number[] = [];
  private inOsc7 = false;

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

    // Frame decoder for subprocess output
    this.decoder = new FrameDecoder((type, payload) => {
      this.handleSubprocessFrame(type, payload);
    });

    // Scrollback persistence
    if (sessionsDir !== undefined) {
      this.scrollbackWriter = new ScrollbackWriter(sessionId, sessionsDir);
      this.scrollbackWriter.init({ sessionId, cols, rows, cwd });
    }

    // Agent detection
    this.agentDetector = new AgentDetector(sessionId);
    this.agentDetector.onStatusChange = (state) => {
      this.broadcastEvent({
        type: "agentStatus",
        sessionId: this.sessionId,
        agent: state,
      });
    };

    // Fallback detection
    this.outputMatcher = new OutputPatternMatcher();
    this.titleDetector = new TitleDetector();
    this.oscTitleParser = new OscTitleParser();

    // Stale PID sweep every 30 seconds
    this.pidSweepTimer = setInterval(() => {
      this.agentDetector.sweepStalePids();
    }, 30_000);
  }

  get alive(): boolean {
    return this._alive;
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
          args: this.pendingSpawnArgs,
          cwd: this.cwd || process.env.HOME || "/",
          cols: this.cols,
          rows: this.rows,
          env: buildShellEnv(process.env, {
            MANOR_PANE_ID: this.sessionId,
            TERM: "xterm-256color",
            ZDOTDIR: zdotdir,
            REAL_ZDOTDIR: ShellManager.realZdotdir(),
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

        // Feed headless emulator (async — write callback fires after processing)
        const seq = ++this.outputSeq;
        this.headlessWritesPending++;
        this.headless.write(data, () => {
          this.appliedSeq = seq;
          this.headlessWritesPending--;
          if (this.headlessWritesPending === 0) {
            const cbs = this.headlessFlushCallbacks.splice(0);
            for (const cb of cbs) cb();
          }
        });

        // Scrollback persistence
        if (this.scrollbackWriter) {
          this.scrollbackWriter.append(data);
          // Detect clear-scrollback escape (\e[3J)
          if (data.includes("\x1b[3J")) {
            this.scrollbackWriter.handleClearScrollback();
          }
        }

        // Parse OSC 7 for CWD tracking
        this.parseOsc7(data);

        // Parse OSC 0/2 for title-based fallback detection
        const titles = this.oscTitleParser.parse(data);
        if (titles.length > 0) {
          const latestTitle = titles[titles.length - 1];
          this.titleDetector.setTitle(latestTitle);
          this.agentDetector.setTitle(latestTitle);
          const titleStatus = this.titleDetector.detect();
          if (titleStatus !== "unknown") {
            this.agentDetector.setFallbackStatus(titleStatus);
          }
        }

        // Output pattern fallback detection
        this.outputMatcher.addData(data);
        const patternStatus = this.outputMatcher.detect();
        if (patternStatus !== null) {
          this.agentDetector.setFallbackStatus(patternStatus);
        }

        // Track terminal modes from escape sequences
        this.trackModes(data);

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
        const { name } = JSON.parse(payload.toString("utf-8"));
        this.agentDetector.updateForegroundProcess(name);
        break;
      }
    }
  }

  /** Called when a hook event arrives for this session */
  setAgentHookStatus(status: AgentStatus, kind: AgentKind): void {
    this.agentDetector.setStatus(status, kind);
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
    this.agentDetector.dispose();
    if (this.pidSweepTimer) {
      clearInterval(this.pidSweepTimer);
      this.pidSweepTimer = null;
    }
    this.scrollbackWriter?.end();
    this.scrollbackWriter?.dispose();
    this.scrollbackWriter = null;
    this.headless.dispose();
    this.attachedClients.clear();
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
      modes: { ...this.modes },
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /** Attach a stream client socket */
  attachClient(socket: net.Socket): void {
    this.attachedClients.add(socket);
    socket.on("close", () => this.attachedClients.delete(socket));
  }

  /** Detach a stream client socket */
  detachClient(socket: net.Socket): void {
    this.attachedClients.delete(socket);
  }

  /** Broadcast a stream event to all attached clients */
  private broadcastEvent(event: StreamEvent): void {
    const line = JSON.stringify(event) + "\n";
    for (const client of this.attachedClients) {
      try {
        client.write(line);
      } catch {
        this.attachedClients.delete(client);
      }
    }
  }

  private writeToSubprocess(frame: Buffer): void {
    if (this.subprocess?.stdin?.writable) {
      this.subprocess.stdin.write(frame);
    }
  }

  // ── OSC 7 CWD Parsing ──

  private parseOsc7(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const byte = data.charCodeAt(i);

      if (this.inOsc7) {
        if (byte === 0x07 || byte === 0x1b) {
          // BEL or ESC terminator
          const payload = String.fromCharCode(...this.oscBuf);
          this.extractOsc7Cwd(payload);
          this.oscBuf = [];
          this.inOsc7 = false;
        } else {
          this.oscBuf.push(byte);
          if (this.oscBuf.length > 4096) {
            this.oscBuf = [];
            this.inOsc7 = false;
          }
        }
      } else if (byte === 0x1b) {
        this.oscBuf = [byte];
      } else if (
        this.oscBuf.length === 1 &&
        this.oscBuf[0] === 0x1b &&
        byte === 0x5d
      ) {
        this.oscBuf.push(byte);
      } else if (this.oscBuf.length === 2 && byte === 0x37) {
        this.oscBuf.push(byte);
      } else if (this.oscBuf.length === 3 && byte === 0x3b) {
        this.oscBuf = [];
        this.inOsc7 = true;
      } else {
        this.oscBuf = [];
      }
    }
  }

  private extractOsc7Cwd(payload: string): void {
    if (!payload.startsWith("file://")) return;
    const rest = payload.slice(7);
    const slashIdx = rest.indexOf("/");
    const p = slashIdx >= 0 ? rest.slice(slashIdx) : rest;
    this.cwd = decodeURIComponent(p);
    this.scrollbackWriter?.updateCwd(this.cwd);
    this.broadcastEvent({
      type: "cwd",
      sessionId: this.sessionId,
      cwd: this.cwd,
    });
  }

  // ── Mode Tracking ──

  private trackModes(data: string): void {
    // Bracketed paste: CSI ?2004h (enable) / CSI ?2004l (disable)
    if (data.includes("\x1b[?2004h")) this.modes.bracketedPaste = true;
    if (data.includes("\x1b[?2004l")) this.modes.bracketedPaste = false;

    // Application cursor: CSI ?1h (enable) / CSI ?1l (disable)
    if (data.includes("\x1b[?1h")) this.modes.applicationCursor = true;
    if (data.includes("\x1b[?1l")) this.modes.applicationCursor = false;

    // Alt screen: CSI ?1049h (enable) / CSI ?1049l (disable)
    if (data.includes("\x1b[?1049h")) {
      this.modes.altScreen = true;
      this.agentDetector.setAltScreen(true);
    }
    if (data.includes("\x1b[?1049l")) {
      this.modes.altScreen = false;
      this.agentDetector.setAltScreen(false);
    }

    // Mouse tracking: CSI ?1000h (enable) / CSI ?1000l (disable)
    if (data.includes("\x1b[?1000h")) this.modes.mouseTracking = true;
    if (data.includes("\x1b[?1000l")) this.modes.mouseTracking = false;

    // Reverse wraparound: CSI ?45h (enable) / CSI ?45l (disable)
    if (data.includes("\x1b[?45h")) this.modes.reverseWraparound = true;
    if (data.includes("\x1b[?45l")) this.modes.reverseWraparound = false;
  }
}
