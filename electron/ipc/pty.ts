import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../ipc-validate";
import { resolveSpawnCwd } from "../paths";
import { HostUnavailableError } from "../backend/host-view";
import { LOCAL_HOST_ID, type HostId } from "../backend/types";
import { errorMessage } from "../lib/errors";
import { isHomePath } from "../../src/lib/home-path";
import type { IpcDeps } from "./types";
import type {
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
} from "../../src/electron.d";

/**
 * Read git branch synchronously from a repo or worktree root, for this
 * machine's own checkout only. Its one caller (`main.ts`) reads
 * `process.cwd()` — Manor's own source tree — before `app.whenReady()`, so
 * before any `BackendRegistry` exists and always on this machine; it is
 * intentionally not routed through the backend (ADR-178 §3 concerns
 * *projects*' branches, read by `BranchWatcher`, not Manor's own repo).
 */
export function readBranchSync(repoPath: string): string | null {
  try {
    const gitPath = path.join(repoPath, ".git");
    const stat = fs.statSync(gitPath);

    let headPath: string;
    if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD");
    } else {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitPath, "utf-8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      const gitdir = path.isAbsolute(m[1])
        ? m[1]
        : path.resolve(repoPath, m[1]);
      headPath = path.join(gitdir, "HEAD");
    }

    const head = fs.readFileSync(headPath, "utf-8").trim();
    const refMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

function validatePtyArgs(paneId: string, cwd: string | null, cols: number, rows: number): string {
  assertString(paneId, "paneId");
  if (cwd !== null) assertString(cwd, "cwd");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  if (isHomePath(cwd)) throw new Error("The Dashboard can't host panes");
  return resolveSpawnCwd(cwd);
}

/**
 * The host a new session should run on, as the renderer named it — the host
 * of the workspace its pane belongs to — or undefined when it didn't, so
 * `RoutedBackend` falls back to the host the cwd belongs to.
 */
function requestedHost(opts: PtyResetOptions | undefined): HostId | undefined {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== "object") throw new Error("opts must be an object");
  if (opts.hostId === undefined) return undefined;
  assertString(opts.hostId, "hostId");
  return opts.hostId;
}

export function register(deps: IpcDeps): void {
  const { backend } = deps;

  ipcMain.handle(
    "pty:create",
    async (
      _event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
      opts?: PtyCreateOptions,
    ): Promise<PtyCreateResult> => {
      const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
      const hostId = requestedHost(opts);
      const agentKind = opts?.agentKind;
      const env: Record<string, string> | undefined = agentKind
        ? { MANOR_AGENT_KIND: agentKind }
        : undefined;
      try {
        const result = await backend.pty.createOrAttachWith(
          paneId,
          resolvedCwd,
          cols,
          rows,
          { env, hostId },
        );
        // Return snapshot to the renderer so it can write it exactly once,
        // avoiding duplicate writes from StrictMode double-mounting.
        // A non-null snapshot means the session already existed (prewarmed).
        return {
          ok: true,
          snapshot: result.snapshot?.screenAnsi || null,
          // Stream position the snapshot reflects — the renderer drops queued
          // output at or below it (ADR-159). Absent when there is no snapshot,
          // or when an older daemon does not report one.
          snapshotSeq: result.snapshot?.seq,
          prewarmed: result.snapshot !== null,
          // The host the session actually runs on — not its project's
          // current host, which may have changed since (ADR-160). The
          // renderer badges a tab from this, so a pane that predates a
          // project move keeps its true host.
          hostId: result.hostId,
        };
      } catch (err) {
        const error = errorMessage(err);
        // A registered remote host that is not connected is not a broken
        // terminal (ADR-178 §6): the renderer shows the host's offline
        // banner and creates the pane once the host is back. A remote pty
        // call rejects with `HostUnavailableError` whenever its host is away
        // (ADR-183); "unknown" is a host nobody registered.
        if (err instanceof HostUnavailableError && err.status !== "unknown") {
          return { ok: false, reason: "host-unavailable", hostId: err.hostId, error };
        }
        console.error(`Failed to create/attach PTY for ${paneId}:`, err);
        return { ok: false, reason: "error", error };
      }
    },
  );

  ipcMain.handle("pty:write", (_event, paneId: string, data: string) => {
    assertString(paneId, "paneId");
    assertString(data, "data");
    backend.pty.write(paneId, data);
  });

  ipcMain.handle(
    "pty:resize",
    async (_event, paneId: string, cols: number, rows: number) => {
      assertString(paneId, "paneId");
      assertPositiveInt(cols, "cols");
      assertPositiveInt(rows, "rows");
      try {
        await backend.pty.resize(paneId, cols, rows);
      } catch {
        // ignore resize errors
      }
    },
  );

  ipcMain.handle("pty:close", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    try {
      await backend.pty.kill(paneId);
    } catch {
      // ignore close errors
    }
  });

  ipcMain.handle(
    "pty:reset",
    async (
      _event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
      opts?: PtyResetOptions,
    ) => {
      const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
      const hostId = requestedHost(opts);
      try {
        try {
          await backend.pty.kill(paneId);
        } catch {
          // Session may not exist.
        }

        // The daemon may still have the old session in its map if the
        // shell hasn't fully exited yet. Retry until we get a fresh
        // session (snapshot === null).
        const deadline = Date.now() + 3_000;
        while (true) {
          if (Date.now() >= deadline) {
            return {
              ok: false,
              error: "Reset timed out — old session still active",
            };
          }

          try { await backend.pty.disposeDead(); } catch { /* ignore */ }

          const result = await backend.pty.createOrAttachWith(
            paneId, resolvedCwd, cols, rows, { hostId },
          );
          if (!result.snapshot) {
            return {
              ok: true,
              snapshot: null,
              prewarmed: false,
              hostId: result.hostId,
            };
          }

          // Reattached to old (dying) session — detach and retry.
          try { await backend.pty.detach(paneId); } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        console.error(`Failed to reset PTY for ${paneId}:`, err);
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );

  ipcMain.handle("pty:detach", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    try {
      await backend.pty.detach(paneId);
    } catch {
      // ignore detach errors
    }
  });

  // The renderer names the workspace's host alongside its cwd (ADR-183).
  ipcMain.handle(
    "pty:consumePrewarmed",
    (_event, cwd: string | null, hostId: string = LOCAL_HOST_ID) => {
      if (cwd !== null) assertString(cwd, "cwd");
      assertString(hostId, "hostId");
      if (isHomePath(cwd)) return null;
      return deps.prewarmManager?.consume(resolveSpawnCwd(cwd), hostId) ?? null;
    },
  );

  ipcMain.handle(
    "pty:updatePrewarmCwd",
    async (
      _event,
      cwd: string,
      hostId: string,
      agentCommand?: string | null,
      agentKind?: string | null,
    ) => {
      assertString(cwd, "cwd");
      assertString(hostId, "hostId");
      // The Dashboard hosts no panes; never warm a shell for it.
      if (isHomePath(cwd)) return;
      await deps.prewarmManager?.updateCwd(resolveSpawnCwd(cwd), hostId, agentCommand, agentKind);
    },
  );
}
