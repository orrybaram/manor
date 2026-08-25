/**
 * TerminalHost — session lifecycle manager.
 *
 * Manages creation, attachment, detachment, and destruction of terminal sessions.
 * This is the core logic used by the daemon's socket server.
 */

import type net from "node:net";
import { Session } from "./session";
import { SESSIONS_DIR } from "./scrollback";
import type {
  SessionInfo,
  TerminalSnapshot,
  AgentStatus,
  AgentKind,
} from "./types";

export class TerminalHost {
  private sessions = new Map<string, Session>();
  private sessionsDir: string;

  constructor(sessionsDir: string = SESSIONS_DIR) {
    this.sessionsDir = sessionsDir;
  }

  /**
   * Create a new session and spawn its PTY, or bring an existing one to the
   * size the caller asked for.
   *
   * The reconciliation matters as much as the creation. A session that outlives
   * the pane showing it comes back at whatever size it was left at, and a grid
   * that wraps at a different width than the program does strands a copy of
   * every frame the program repaints (ADR-165). `client.doCreateOrAttach` does
   * send a resize of its own before it subscribes, but that is one caller's
   * good manners standing in for an invariant, and the invariant belongs here.
   *
   * Not awaited: `Session.resize` records the new size and writes towards the
   * subprocess synchronously, so `info` already reports what the caller asked
   * for. What the promise waits for is the ioctl's acknowledgement, and there
   * is nothing here that needs it — the clients that care are told by the
   * `resized` event, at its own position in the output stream.
   */
  create(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs: string[] = [],
    prewarmed?: boolean,
    envOverrides?: Record<string, string>,
  ): SessionInfo {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      void existing.resize(cols, rows);
      return existing.info;
    }

    const session = new Session(sessionId, cwd, cols, rows, this.sessionsDir, envOverrides);
    session.prewarmed = prewarmed ?? false;
    this.sessions.set(sessionId, session);
    session.spawn(shellArgs);
    return session.info;
  }

  /** Attach a stream socket to a session (for receiving output) */
  async attach(
    sessionId: string,
    socket: net.Socket,
  ): Promise<TerminalSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.attachClient(socket);
    return session.getSnapshot();
  }

  /** Detach a stream socket from a session */
  detach(sessionId: string, socket: net.Socket): void {
    const session = this.sessions.get(sessionId);
    if (session) session.detachClient(socket);
  }

  /** Write terminal input to a session */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data);
  }

  /** Queue a write that fires after the session's first output (shell prompt) */
  writeAfterReady(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.writeAfterReady(data);
    return true;
  }

  /** Resize a session's PTY */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.sessions.get(sessionId)?.resize(cols, rows);
  }

  /** Kill a session's PTY process and remove it so the ID can be reused */
  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.disposeAndWait();
    }
  }

  /** Get a snapshot for warm restore */
  async getSnapshot(sessionId: string): Promise<TerminalSnapshot | null> {
    return this.sessions.get(sessionId)?.getSnapshot() ?? null;
  }

  /** List all sessions (excludes prewarmed sessions) */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => !s.prewarmed)
      .map((s) => s.info);
  }

  /** Clear the prewarmed flag on a session (called on warm restore) */
  clearPrewarmed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.prewarmed = false;
  }

  /** Dispose a specific session */
  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /** Dispose all dead sessions */
  disposeDeadSessions(): void {
    for (const [id, session] of this.sessions) {
      if (!session.info.alive) {
        session.dispose();
        this.sessions.delete(id);
      }
    }
  }

  /** Dispose all sessions and clean up */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  /** Relay a hook-driven agent status to a session's detector */
  setAgentHookStatus(
    sessionId: string,
    status: AgentStatus,
    kind: AgentKind,
  ): void {
    this.sessions.get(sessionId)?.setAgentHookStatus(status, kind);
  }

  /** Detach all clients from a specific socket (when a client disconnects) */
  detachAllFromSocket(socket: net.Socket): void {
    for (const session of this.sessions.values()) {
      session.detachClient(socket);
    }
  }
}
