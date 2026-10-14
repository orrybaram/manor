/**
 * Starting a pane's session, on the server (ADR-227 D5).
 *
 * `spawnPane` is what `pty.create` always did — create the session or attach
 * to it, and type the pane's pending command into a fresh one — factored out
 * so the server can call it with no renderer behind it. Two callers:
 *
 * - **`pty.create`** (`../bridge/handlers/pty.ts`), a viewer mounting a pane.
 * - **The server's launches** (`createServerLaunches`, below): an agent's
 *   startup line or a new workspace's setup script starts the moment its pane
 *   joins a tree (`LayoutStore`'s `PaneLauncher`), so `POST /agents`, a
 *   `layout.apply` with an agent tab and `workspaceOps.create` all run on a
 *   host nobody is looking at.
 *
 * A viewer that mounts a launched pane later reaches the same session through
 * `pty.create`: `createOrAttach` attaches to a session that exists, and the
 * command was taken off the queue by the spawn that typed it, so it is never
 * typed twice. The two creates are serialized per pane, so a mount that
 * races the launch attaches rather than asking the daemon for a second
 * session under the same id.
 *
 * Electron-free: `createManorServer` composes it on both platforms.
 */

import crypto from "node:crypto";
import path from "node:path";
import { getConnectorForCommand } from "../agent-connectors";
import { HostUnavailableError } from "../backend/host-view";
import { LOCAL_HOST_ID, type HostId } from "../backend/types";
import { assertPositiveInt, assertString } from "../ipc-validate";
import type { ServerDeps } from "../ipc/types";
import type { PaneLauncher } from "../layout/layout-store";
import { errorMessage } from "../lib/errors";
import { resolveSpawnCwd } from "../paths";
import type { ProjectManager } from "../persistence";
import type { PrewarmManager } from "../prewarm-manager";
import { isHomePath } from "../../src/lib/home-path";
import {
  agentCommandWithPrompt,
  agentCommandWithPromptFile,
} from "../../src/lib/agent-command";
import { createTab, newPaneId } from "../../src/lib/layout/ids";
import type { LayoutOrigin } from "../../src/lib/layout/protocol";
import { parseWorkspaceKey, workspaceKey } from "../../src/lib/workspace-key";
import type { PtyCreateResult, PtyFailure } from "../../src/electron.d";
import type { SetupProgressEvent } from "../../src/store/project-store";

/** What spawning a pane reads: the backends, the layout and its queue. */
export type SpawnPaneDeps = Pick<
  ServerDeps,
  "backend" | "backendRegistry" | "layoutStore"
> & {
  /** The desktop's background-warmed session; a host server has none. */
  prewarmManager?: Pick<PrewarmManager, "claimAdopted">;
};

export interface SpawnPaneOptions {
  /** The pane's directory; null is the home sentinel's (`resolveSpawnCwd`). */
  cwd: string | null;
  cols: number;
  rows: number;
  /**
   * The host a new session runs on: the host of the workspace its pane
   * belongs to. Omitted, `RoutedBackend` falls back to the host the cwd
   * belongs to. An existing session stays where it runs.
   */
  hostId?: HostId;
  /** Sets `MANOR_AGENT_KIND` in a freshly spawned session's env. */
  agentKind?: string | null;
}

/** The grid a launch spawns at; the first viewer to attach fits it. */
const LAUNCH_COLS = 80;
const LAUNCH_ROWS = 24;

export function validatePtyArgs(
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
): string {
  assertString(paneId, "paneId");
  if (cwd !== null) assertString(cwd, "cwd");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  if (isHomePath(cwd)) throw new Error("The Dashboard can't host panes");
  return resolveSpawnCwd(cwd);
}

/**
 * The host a new session should run on, as the caller named it — the host
 * of the workspace its pane belongs to — or undefined when it didn't, so
 * `RoutedBackend` falls back to the host the cwd belongs to.
 */
export function requestedHost(
  opts: { hostId?: HostId } | null | undefined,
): HostId | undefined {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== "object") throw new Error("opts must be an object");
  if (opts.hostId === undefined) return undefined;
  assertString(opts.hostId, "hostId");
  return opts.hostId;
}

/**
 * Each server's creates in flight, per pane. Keyed by the server's backend,
 * so two servers in one process (the test harness) share nothing (ADR-227
 * D1).
 */
const creating = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Run `create` after any create for the same pane already in flight on this
 * server. The daemon's create-or-attach is two calls (snapshot, then create),
 * so two that overlap could both find no session.
 */
function oneAtATime<T>(scope: object, paneId: string, create: () => Promise<T>): Promise<T> {
  let byPane = creating.get(scope);
  if (!byPane) {
    byPane = new Map();
    creating.set(scope, byPane);
  }
  const panes = byPane;
  const previous = panes.get(paneId) ?? Promise.resolve();
  const run = previous.then(create);
  const settled = run.then(
    () => {},
    () => {},
  );
  panes.set(paneId, settled);
  void settled.then(() => {
    if (panes.get(paneId) === settled) panes.delete(paneId);
  });
  return run;
}

/**
 * Whether this create is the one that brought the pane's shell into being.
 *
 * Two ways for that to be true, and the second is not obvious: a session the
 * prewarm manager warmed in the background already exists when the pane that
 * adopts it is created, so it reports a snapshot like any warm reattach. The
 * manager knows which pane it just handed out and says so once
 * (`claimAdopted`), which keeps the *second* create of that same pane — a
 * viewer mounting a pane the server already launched — a reattach, the
 * thing this predicate exists to exclude.
 */
function isFreshSession(
  deps: SpawnPaneDeps,
  paneId: string,
  result: { snapshot: unknown },
): boolean {
  const adopted = deps.prewarmManager?.claimAdopted(paneId) ?? false;
  return result.snapshot === null || adopted;
}

/**
 * Open (or attach to) a pane's session, and type its pending command into a
 * fresh one.
 *
 * Validation throws (a rejected promise); a session that could not be
 * opened answers a `PtyFailure`.
 */
export async function spawnPane(
  deps: SpawnPaneDeps,
  paneId: string,
  opts: SpawnPaneOptions,
): Promise<PtyCreateResult> {
  const { cols, rows, agentKind } = opts;
  const resolvedCwd = validatePtyArgs(paneId, opts.cwd, cols, rows);
  const hostId = requestedHost(opts);
  const env: Record<string, string> | undefined = agentKind
    ? { MANOR_AGENT_KIND: agentKind }
    : undefined;
  try {
    const result = await oneAtATime(deps.backend, paneId, () =>
      deps.backend.pty.createOrAttachWith(paneId, resolvedCwd, cols, rows, {
        env,
        hostId,
      }),
    );
    // A pane opened "with a command" — `POST /tabs { command }`, a split with
    // an agent, `POST /agents` — has its line waiting on the server. This is
    // the moment it has a shell to be typed into. A command put back after
    // its remote host dropped is typed on a reattach too: the session it was
    // meant for may have survived on the host, without it.
    const fresh = isFreshSession(deps, paneId, result);
    if (fresh) deps.layoutStore.recordSpawn(paneId, resolvedCwd);
    if (fresh || deps.layoutStore.pendingCommands.isRequeued(paneId)) {
      await deliverPendingCommand(deps, paneId, result.hostId);
    }

    // Return snapshot to the renderer so it can write it exactly once,
    // avoiding duplicate writes from StrictMode double-mounting.
    // A non-null snapshot means the session already existed (prewarmed, or
    // launched by the server).
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
    return toPtyFailure(err, paneId);
  }
}

/**
 * A create or attach that threw, as the failure it answers with.
 *
 * A registered remote host that is not connected is not a broken terminal
 * (ADR-178 §6): the renderer shows the host's offline banner and creates the
 * pane once the host is back. A remote pty call rejects with
 * `HostUnavailableError` whenever its host is away (ADR-183); "unknown" is a
 * host nobody registered.
 */
export function toPtyFailure(err: unknown, paneId: string): PtyFailure {
  const error = errorMessage(err);
  if (err instanceof HostUnavailableError && err.status !== "unknown") {
    return { ok: false, reason: "host-unavailable", hostId: err.hostId, error };
  }
  console.error(`Failed to create/attach PTY for ${paneId}:`, err);
  return { ok: false, reason: "error", error };
}

/**
 * Type the pane's pending command, once, when its shell reaches a prompt.
 *
 * `writeAfterReady` rather than a plain write because the session was spawned
 * a moment ago and its line editor may not have initialised: the daemon holds
 * the bytes until the shell's first output. The trailing `\r` is what an Enter
 * keypress sends — `\n` is not reliably `accept-line` under zsh's ZLE. Text
 * queued with `submit: false` (a fix-it command the user reviews, ADR-183)
 * is typed without it.
 *
 * Never fatal to the create: a pane that opened without running its command is
 * a worse outcome than a pane that never opened, but only slightly, and the
 * caller has already got its session.
 *
 * Not lost to a remote host that drops before the shell is ready, either
 * (ADR-178 §6): the command goes back on the queue for the pane's next
 * create, as long as the pane is still in a layout and nothing newer was
 * queued for it meanwhile — the server's form of the renderer requeue
 * (`shouldRequeuePaneCommand`) this queue replaced.
 *
 * An agent launch queued with a `prompt` (ADR-209) has it written to a file
 * on the pane's host first, and the typed line only names that file
 * (`promptLaunchLine`). `writeAfterReady` fires on the shell's first output,
 * which is not "line editor ready": a prompt theme can draw before `.zshrc`
 * loads, while the tty is still canonical, and the kernel drops whatever of
 * a typed line runs past `MAX_CANON` — 1024 bytes on macOS.
 */
async function deliverPendingCommand(
  deps: SpawnPaneDeps,
  paneId: string,
  hostId: HostId,
): Promise<void> {
  const { layoutStore } = deps;
  const pending = layoutStore.pendingCommands.take(paneId);
  if (!pending) return;
  try {
    const line =
      pending.prompt !== undefined
        ? await promptLaunchLine(deps, paneId, hostId, pending.text, pending.prompt)
        : pending.text;
    await deps.backend.pty.writeAfterReady(
      paneId,
      pending.submit ? line + "\r" : line,
    );
  } catch (err) {
    if (hostId !== LOCAL_HOST_ID && layoutStore.workspaceOf(paneId) !== null) {
      layoutStore.pendingCommands.requeue(paneId, pending);
      return;
    }
    console.error(
      `[pty] failed to send the ${pending.kind} command queued for ${paneId}:`,
      err,
    );
  }
}

/**
 * The launch line for an agent whose first prompt goes through a file
 * (ADR-209): the prompt is written to `~/.manor/prompts/` on the host the
 * session runs on, and the line is `<harness> "$(cat '<file>'; rm -f
 * '<file>')"` — short whatever the prompt's length, and the shell deletes the
 * file as it reads it.
 *
 * `backendRegistry.get(hostId)`, not `RoutedBackend.shell`, for ADR-187's
 * paste-image reason (`electron/ipc/paste-image.ts`): the session's host owns
 * the home directory and the write, and `RoutedBackend` would pick a host by
 * path instead.
 *
 * A failed write on the local host falls back to the inline line — a short
 * prompt still launches, and a long one is no worse off than before. On a
 * remote host it throws, so `deliverPendingCommand` requeues the command,
 * prompt and all, for when the host is back.
 */
async function promptLaunchLine(
  deps: SpawnPaneDeps,
  paneId: string,
  hostId: HostId,
  base: string,
  prompt: string,
): Promise<string> {
  try {
    const host = deps.backendRegistry.get(hostId);
    const home = await host.shell.homeDir();
    const dir = `${home}/.manor/prompts`;
    const file = path.posix.join(
      dir,
      `${paneId}-${crypto.randomBytes(4).toString("hex")}.txt`,
    );
    await host.shell.writeFile(file, Buffer.from(prompt, "utf-8"));
    // Fire and forget: sweep files whose launch line never ran (the pane
    // closed before its shell did). A failure here does not undo the write.
    host.shell
      .exec("find", [dir, "-type", "f", "-mtime", "+7", "-delete"])
      .catch(() => {});
    return agentCommandWithPromptFile(base, file);
  } catch (err) {
    if (hostId !== LOCAL_HOST_ID) throw err;
    console.warn(
      `[pty] could not write the prompt file for ${paneId}; typing it inline:`,
      err,
    );
    return agentCommandWithPrompt(base, prompt);
  }
}

// ── the server's launches ──

/** Who a setup script's tab, and its close, are recorded as coming from. */
const SETUP_ORIGIN: LayoutOrigin = { kind: "route", id: "setup-script" };

export interface ServerLaunchesDeps {
  /**
   * What spawning reads. Called at launch time: the server's deps are built
   * after its layout store, which is what calls `launch`.
   */
  spawnDeps: () => SpawnPaneDeps;
  /** Which project a workspace belongs to, for a launch's agent kind. */
  projectManager: Pick<ProjectManager, "workspaceProject">;
  /**
   * A setup script's progress, as a `projects.worktreeProgress` event to the
   * connection that created the workspace (everyone, when null).
   */
  publishSetupProgress: (origin: string | null, event: SetupProgressEvent) => void;
}

export interface ServerLaunches extends PaneLauncher {
  /**
   * Run a new workspace's setup script in a tab of its own: the tab's pane
   * queues `script; exit` and starts on the server at once. Resolves once
   * the tab exists. Never rejects: a script that cannot start is logged.
   */
  runSetupScript(
    workspacePath: string,
    script: string,
    hostId: HostId,
    origin: string | null,
  ): Promise<void>;
  /**
   * A session's shell exited: a setup script's tab closes with it, and a
   * script that ended with a non-zero `exitCode` is reported as failed.
   */
  onExit(paneId: string, exitCode?: number | null): void;
}

export function createServerLaunches(deps: ServerLaunchesDeps): ServerLaunches {
  /** Setup scripts still running, by pane: whom to tell when each ends. */
  const setups = new Map<
    string,
    { key: string; workspacePath: string; origin: string | null }
  >();

  /**
   * The agent kind a launched session's env names, as a renderer's create
   * would: an agent launch's own command, else the workspace's project's.
   */
  function agentKindFor(paneId: string, hostId: string, workspacePath: string): string {
    const spawn = deps.spawnDeps();
    const pending = spawn.layoutStore.pendingCommands.peek(paneId);
    const command =
      pending?.kind === "agent-startup"
        ? pending.text
        : deps.projectManager.workspaceProject(hostId, workspacePath)?.agentCommand;
    return command ? getConnectorForCommand(command).kind : "claude";
  }

  return {
    launch(key, paneId) {
      const { hostId, path: workspacePath } = parseWorkspaceKey(key);
      const spawn = deps.spawnDeps();
      // Not awaited: the layout command that added the pane answers now. A
      // failure is a pane a viewer creates later — its command is still
      // queued — and `toPtyFailure` has logged anything but an away host.
      void spawnPane(spawn, paneId, {
        cwd: workspacePath,
        cols: LAUNCH_COLS,
        rows: LAUNCH_ROWS,
        hostId,
        agentKind: agentKindFor(paneId, hostId, workspacePath),
      }).catch((err: unknown) => {
        console.error(`[launch] could not start ${paneId}:`, err);
      });
    },

    async runSetupScript(workspacePath, script, hostId, origin) {
      const { layoutStore } = deps.spawnDeps();
      const key = workspaceKey(hostId, workspacePath);
      const paneId = newPaneId();
      const tab = createTab("Setup", paneId);
      // Queued before the tab exists, for `pendingCommands`' ordering: the
      // apply is what launches it.
      layoutStore.pendingCommands.set(paneId, `${script}; exit`, "setup-script");
      setups.set(paneId, { key, workspacePath, origin });
      deps.publishSetupProgress(origin, {
        step: "setup-script",
        status: "in-progress",
        workspacePath,
      });
      try {
        const result = await layoutStore.apply(
          key,
          { type: "new-tab", tab, select: true },
          SETUP_ORIGIN,
        );
        if (!("error" in result)) return;
        throw new Error(result.error);
      } catch (err) {
        layoutStore.pendingCommands.clear(paneId);
        setups.delete(paneId);
        console.error(`[setup] could not run the setup script in ${workspacePath}:`, err);
        deps.publishSetupProgress(origin, {
          step: "setup-script",
          status: "error",
          message: errorMessage(err),
          workspacePath,
        });
      }
    },

    onExit(paneId, exitCode) {
      const setup = setups.get(paneId);
      if (!setup) return;
      setups.delete(paneId);
      // `script; exit` ends the shell with the script's own status. A shell
      // that was killed (no code) is not a failed script.
      deps.publishSetupProgress(
        setup.origin,
        exitCode
          ? {
              step: "setup-script",
              status: "error",
              message: `The setup script exited with code ${exitCode}.`,
              workspacePath: setup.workspacePath,
            }
          : {
              step: "setup-script",
              status: "done",
              workspacePath: setup.workspacePath,
            },
      );
      // `exit` ended the shell; its tab goes with it, whether or not anyone
      // is looking. A mounted pane closes itself too — the second close is a
      // no-op.
      void deps
        .spawnDeps()
        .layoutStore.apply(
          setup.key,
          { type: "close-pane", paneId },
          SETUP_ORIGIN,
          // Nobody closed it: "reopen closed pane" must not bring it back.
          { remember: false },
        )
        .catch(() => {});
    },
  };
}
