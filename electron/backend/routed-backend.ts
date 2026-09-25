/**
 * RoutedBackend — one `WorkspaceBackend` over every host in a
 * `BackendRegistry` (ADR-160 §6).
 *
 * The IPC handlers, control routes and process tools were written against a
 * single backend and address things by what they already have: a pane id,
 * a working directory, a pid. This routes each of those to the host that
 * owns it, so none of them has to learn about hosts:
 *
 * - pty calls go to the host that owns the session — the one it was
 *   created on, or for a new session the host its cwd belongs to (the
 *   host of the project containing it);
 * - git calls go to the host their cwd belongs to;
 * - `ports.scan` splits its paths by host, `ports.kill` goes to the host
 *   whose last scan reported the pid;
 * - `shell.which` is always local (it answers "is this CLI installed here").
 *
 * With no remote host registered every route ends at the local backend,
 * called with exactly the arguments it was called with before.
 */

import type { BackendRegistry } from "./registry";
import {
  LOCAL_HOST_ID,
  type ActivePort,
  type GitBackend,
  type HostConnectionEventHandler,
  type PortsBackend,
  type PtyBackend,
  type SessionInfo,
  type ShellBackend,
  type WorkspaceBackend,
} from "./types";

/** Resolves a filesystem path to the host it lives on. */
export type HostForPath = (path: string) => string;

/** Split `paths` by host, preserving order within and across hosts. */
export function groupPathsByHost(
  paths: readonly string[],
  hostForPath: HostForPath,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const hostId = hostForPath(p);
    const group = groups.get(hostId);
    if (group) group.push(p);
    else groups.set(hostId, [p]);
  }
  return groups;
}

export class RoutedBackend implements WorkspaceBackend {
  readonly pty: PtyBackend;
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly ports: PortsBackend;

  /** Pids each host's latest port scan reported, for routing `kill`. */
  private readonly scannedPids = new Map<string, Set<number>>();

  constructor(
    private readonly registry: BackendRegistry,
    private readonly hostForPath: HostForPath,
  ) {
    const local = () => registry.get(LOCAL_HOST_ID);
    const bySession = (sessionId: string) =>
      registry.get(registry.hostForSession(sessionId) ?? LOCAL_HOST_ID).pty;
    const byPath = (cwd: string) => registry.get(hostForPath(cwd));

    this.pty = {
      createOrAttach: async (sessionId, cwd, cols, rows, shellArgs) => {
        const hostId = registry.hostForSession(sessionId) ?? hostForPath(cwd);
        const result = await registry
          .get(hostId)
          .pty.createOrAttach(sessionId, cwd, cols, rows, shellArgs);
        registry.noteSession(sessionId, hostId);
        return result;
      },
      write: (sessionId, data) => bySession(sessionId).write(sessionId, data),
      resize: (sessionId, cols, rows) =>
        bySession(sessionId).resize(sessionId, cols, rows),
      kill: async (sessionId) => {
        await bySession(sessionId).kill(sessionId);
        registry.forgetSession(sessionId);
      },
      detach: (sessionId) => bySession(sessionId).detach(sessionId),
      getSnapshot: (sessionId) => bySession(sessionId).getSnapshot(sessionId),
      listSessions: () =>
        this.acrossHosts(async (hostId, backend) => {
          const sessions = await backend.pty.listSessions();
          for (const s of sessions) registry.noteSession(s.sessionId, hostId);
          return sessions;
        }).then((lists): SessionInfo[] => lists.flat()),
      disposeDead: async () => {
        await this.acrossHosts((_hostId, backend) => backend.pty.disposeDead());
      },
      onEvent: (handler) => {
        registry.onEvent((_hostId, event) => handler(event));
      },
      updateEnv: (env) => local().pty.updateEnv(env),
      relayAgentHook: (sessionId, status, kind) =>
        bySession(sessionId).relayAgentHook(sessionId, status, kind),
    };

    this.git = {
      exec: (cwd, args) => byPath(cwd).git.exec(cwd, args),
      stage: (cwd, files) => byPath(cwd).git.stage(cwd, files),
      unstage: (cwd, files) => byPath(cwd).git.unstage(cwd, files),
      discard: (cwd, files) => byPath(cwd).git.discard(cwd, files),
      commit: (cwd, message, flags) => byPath(cwd).git.commit(cwd, message, flags),
      stash: (cwd, files) => byPath(cwd).git.stash(cwd, files),
      pushStream: (cwd, opts, callbacks) =>
        byPath(cwd).git.pushStream(cwd, opts, callbacks),
      // `targetDir` doesn't exist yet (that's the point of cloning into it),
      // so route by its host the same way `hostForPath` routes any other
      // not-yet-known path under a project's root.
      cloneStream: (repoUrl, targetDir, callbacks) =>
        byPath(targetDir).git.cloneStream(repoUrl, targetDir, callbacks),
      getFullDiff: (cwd, defaultBranch) =>
        byPath(cwd).git.getFullDiff(cwd, defaultBranch),
      getLocalDiff: (cwd) => byPath(cwd).git.getLocalDiff(cwd),
      getStagedFiles: (cwd) => byPath(cwd).git.getStagedFiles(cwd),
      worktreeList: (cwd) => byPath(cwd).git.worktreeList(cwd),
      worktreeAdd: (cwd, path, branch, opts) =>
        byPath(cwd).git.worktreeAdd(cwd, path, branch, opts),
      worktreeRemove: (cwd, path, force) =>
        byPath(cwd).git.worktreeRemove(cwd, path, force),
      currentBranch: (cwd) => byPath(cwd).git.currentBranch(cwd),
    };

    this.shell = {
      which: (bin) => local().shell.which(bin),
      exec: (cmd, args, opts) =>
        (opts?.cwd ? byPath(opts.cwd) : local()).shell.exec(cmd, args, opts),
      // No cwd to route by; callers that need a specific host's home
      // (ProjectManager, ADR-178 §3) go through the registry directly.
      homeDir: () => local().shell.homeDir(),
    };

    this.ports = {
      scan: (workspacePaths) => this.scanPorts(workspacePaths),
      kill: (pid) => {
        const owners = Array.from(this.scannedPids)
          .filter(([, pids]) => pids.has(pid))
          .map(([hostId]) => hostId);
        if (owners.length > 1) {
          return Promise.reject(
            new Error(`pid ${pid} is listening on more than one host (${owners.join(", ")})`),
          );
        }
        return registry.get(owners[0] ?? LOCAL_HOST_ID).ports.kill(pid);
      },
    };
  }

  connect(opts?: { version?: string }): Promise<void> {
    if (opts?.version) this.registry.setVersion(opts.version);
    return this.registry.ensureConnected(LOCAL_HOST_ID);
  }

  disconnect(): Promise<void> {
    return this.registry.disconnectAll();
  }

  onHostEvent(handler: HostConnectionEventHandler): void {
    this.registry.onHostEvent((_hostId, event) => handler(event));
  }

  /**
   * Run `fn` on the local host and every connected remote one. A local
   * failure rejects, as it always has; a remote one is logged and skipped,
   * so a flaky box never hides the local sessions.
   */
  private async acrossHosts<T>(
    fn: (hostId: string, backend: WorkspaceBackend) => Promise<T>,
  ): Promise<T[]> {
    const hostIds = [
      LOCAL_HOST_ID,
      ...this.registry
        .remoteHostIds()
        .filter((id) => this.registry.status(id) === "connected"),
    ];
    const settled = await Promise.allSettled(
      hostIds.map((id) => fn(id, this.registry.get(id))),
    );
    const results: T[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.push(r.value);
      else if (hostIds[i] === LOCAL_HOST_ID) throw r.reason;
      else console.warn(`[routed-backend] ${hostIds[i]} failed:`, r.reason);
    });
    return results;
  }

  private async scanPorts(workspacePaths: string[]): Promise<ActivePort[]> {
    const groups = groupPathsByHost(workspacePaths, this.hostForPath);
    const hostIds = groups.size === 0 ? [LOCAL_HOST_ID] : Array.from(groups.keys());
    const results = await Promise.allSettled(
      hostIds.map(async (hostId) => {
        const ports = await this.registry
          .get(hostId)
          .ports.scan(groups.get(hostId) ?? []);
        this.scannedPids.set(hostId, new Set(ports.map((p) => p.pid)));
        return hostId === LOCAL_HOST_ID ? ports : ports.map((p) => ({ ...p, hostId }));
      }),
    );
    const merged: ActivePort[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") merged.push(...r.value);
      else if (hostIds[i] === LOCAL_HOST_ID || hostIds.length === 1) throw r.reason;
      else console.warn(`[routed-backend] port scan on ${hostIds[i]} failed:`, r.reason);
    });
    return merged;
  }
}
