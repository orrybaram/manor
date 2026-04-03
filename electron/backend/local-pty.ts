import type { TerminalHostClient } from "../terminal-host/client";
import type {
  PtyBackend,
  StreamEventHandler,
} from "./types";
import type {
  SessionInfo,
  TerminalSnapshot,
  AgentStatus,
  AgentKind,
} from "../terminal-host/types";

export class LocalPtyBackend implements PtyBackend {
  private client: TerminalHostClient;

  constructor(client: TerminalHostClient) {
    this.client = client;
  }

  async createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    return this.client.createOrAttach(sessionId, cwd, cols, rows, shellArgs);
  }

  write(sessionId: string, data: string): void {
    this.client.writeNoAck(sessionId, data);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.client.resize(sessionId, cols, rows);
  }

  async kill(sessionId: string): Promise<void> {
    await this.client.kill(sessionId);
  }

  async detach(sessionId: string): Promise<void> {
    await this.client.detach(sessionId);
  }

  async getSnapshot(sessionId: string): Promise<TerminalSnapshot | null> {
    return this.client.getSnapshot(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.client.listSessions();
  }

  onEvent(handler: StreamEventHandler): void {
    this.client.onEvent(handler);
  }

  async updateEnv(_env: Record<string, string>): Promise<void> {
    // The TerminalHostClient pushes env during connect() internally.
    // This is a no-op for local; kept for interface compliance.
  }

  relayAgentHook(
    sessionId: string,
    status: AgentStatus,
    kind: AgentKind,
  ): void {
    this.client.relayAgentHook(sessionId, status, kind);
  }

  /** Ensure the underlying client is connected to the daemon. */
  async ensureConnected(): Promise<void> {
    await this.client.connect();
  }
}
