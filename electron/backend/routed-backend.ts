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
 * - `ports.kill` goes to the host whose last scan reported the pid;
 *   `ports.scan` is this machine's — `PortScanner` scans each host through
 *   the registry itself (ADR-183);
 * - `shell.which` is always local (it answers "is this CLI installed here").
 *
 * A cwd here is a bare path from outside (a pty cwd, a git call from the
 * renderer), so this is the one place a path's host is inferred (ADR-183);
 * everything that knows a workspace's host passes it along instead.
 *
 * With no remote host registered every route ends at the local backend,
 * called with exactly the arguments it was called with before.
 */

import type { BackendRegistry } from "./registry";
import {
  LOCAL_HOST_ID,
  type GitBackend,
  type MachineFacts,
  type PortsBackend,
  type PtyBackend,
  type SessionInfo,
  type ShellBackend,
  type WorkspaceBackend,
} from "./types";

/** Resolves a filesystem path to the host it lives on. */
export type HostForPath = (path: string) => string;

/** The hosts whose latest port scan reported a pid (`PortScanner`). */
export type PidHosts = (pid: number) => string[];

/** A `PtyBackend` whose `createOrAttach` also says which host it used. */
export interface RoutedPtyBackend extends PtyBackend {
  createOrAttach(
    ...args: Parameters<PtyBackend["createOrAttach"]>
  ): Promise<Awaited<ReturnType<PtyBackend["createOrAttach"]>> & { hostId: string }>;
}

export class RoutedBackend implements WorkspaceBackend {
  readonly pty: RoutedPtyBackend;
  readonly git: GitBackend;
  readonly shell: ShellBackend;
  readonly ports: PortsBackend;
  /**
   * This machine's facts: like `shell.homeDir`, there is nothing to route
   * by. Callers that need a specific host's go through the registry.
   */
  readonly facts: MachineFacts;

  constructor(
    private readonly registry: BackendRegistry,
    hostForPath: HostForPath,
    pidHosts: PidHosts = () => [],
  ) {
    const { sessions } = registry;
    const local = () => registry.get(LOCAL_HOST_ID);
    const bySession = (sessionId: string) =>
      registry.get(sessions.ownerOf(sessionId) ?? LOCAL_HOST_ID).pty;
    const byPath = (cwd: string) => registry.get(hostForPath(cwd));

    this.pty = {
      createOrAttach: async (sessionId, cwd, cols, rows, shellArgs, env) => {
        const hostId = sessions.ownerOf(sessionId) ?? hostForPath(cwd);
        const result = await registry
          .get(hostId)
          .pty.createOrAttach(sessionId, cwd, cols, rows, shellArgs, env);
        sessions.claim(sessionId, hostId);
        return { ...result, hostId };
      },
      write: (sessionId, data) => bySession(sessionId).write(sessionId, data),
      resize: (sessionId, cols, rows) =>
        bySession(sessionId).resize(sessionId, cols, rows),
      kill: async (sessionId) => {
        await bySession(sessionId).kill(sessionId);
        sessions.release(sessionId);
      },
      detach: (sessionId) => bySession(sessionId).detach(sessionId),
      getSnapshot: (sessionId) => bySession(sessionId).getSnapshot(sessionId),
      getPaneFacts: (sessionId) => bySession(sessionId).getPaneFacts(sessionId),
      listSessions: () =>
        this.acrossHosts(async (hostId, backend) => {
          const listed = await backend.pty.listSessions();
          for (const s of listed) sessions.claim(s.sessionId, hostId);
          return listed;
        }).then((lists): SessionInfo[] => lists.flat()),
      disposeDead: async () => {
        await this.acrossHosts((_hostId, backend) => backend.pty.disposeDead());
      },
      onEvent: (handler) => registry.onEvent((_hostId, event) => handler(event)),
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

    this.facts = local().facts;

    this.ports = {
      scan: (workspacePaths) => local().ports.scan(workspacePaths),
      kill: (pid) => {
        const owners = pidHosts(pid);
        if (owners.length > 1) {
          return Promise.reject(
            new Error(`pid ${pid} is listening on more than one host (${owners.join(", ")})`),
          );
        }
        return registry.get(owners[0] ?? LOCAL_HOST_ID).ports.kill(pid);
      },
    };
  }

  /** Connect the local host; remote ones connect on their own (see the registry). */
  connect(): Promise<void> {
    return this.registry.ensureConnected(LOCAL_HOST_ID);
  }

  disconnect(): Promise<void> {
    return this.registry.disconnectAll();
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
}
