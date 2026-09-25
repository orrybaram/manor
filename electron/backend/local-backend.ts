import type { TerminalHostClient } from "../terminal-host/client";
import type { WorkspaceBackend } from "./types";
import { LocalPtyBackend } from "./local-pty";
import { LocalGitBackend } from "./local-git";
import { LocalShellBackend } from "./local-shell";
import { LocalPortsBackend } from "./local-ports";
import { localExec } from "./exec";

export class LocalBackend implements WorkspaceBackend {
  readonly pty: LocalPtyBackend;
  readonly git: LocalGitBackend;
  readonly shell: LocalShellBackend;
  readonly ports: LocalPortsBackend;
  private client: TerminalHostClient;

  constructor(client: TerminalHostClient) {
    this.client = client;
    this.pty = new LocalPtyBackend(client);
    this.git = new LocalGitBackend(localExec);
    this.shell = new LocalShellBackend(localExec);
    this.ports = new LocalPortsBackend(localExec);
  }

  async connect(opts?: { version?: string }): Promise<void> {
    if (opts?.version) {
      this.client.setVersion(opts.version);
    }
    await this.pty.ensureConnected();
  }

  async disconnect(): Promise<void> {}

}
