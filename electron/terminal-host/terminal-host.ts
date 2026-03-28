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

  /** Create a new session and spawn its PTY */
  create(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs: string[] = [],
  ): SessionInfo {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!.info;
    }

    const session = new Session(sessionId, cwd, cols, rows, this.sessionsDir);
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

  /** Resize a session's PTY */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  /** Kill a session's PTY process */
  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill();
    }
  }

  /** Get a snapshot for warm restore */
  async getSnapshot(sessionId: string): Promise<TerminalSnapshot | null> {
    return this.sessions.get(sessionId)?.getSnapshot() ?? null;
  }

  /** List all sessions */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  /** Dispose a specific session */
  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionId);
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
