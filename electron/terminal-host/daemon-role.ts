/**
 * Which of this machine's daemons a terminal-host process is, and everything
 * that follows from it (see `DaemonNamespace` in electron/paths.ts):
 *
 *   - `localRole` — Manor desktop's daemon (~/.manor/daemon/). Electron main
 *     bootstraps this host itself (app-lifecycle) and runs its own
 *     `AgentHookServer`, so this role does nothing at startup, keeps no hook
 *     journal and accepts any env the app pushes.
 *   - `remoteRole` — the daemon `manor-host remote-bridge` spawns on another
 *     box (~/.manor/remote/daemon/), serving a client on a different machine.
 *     It bootstraps its own host once at startup, owns the box's agent hooks
 *     (a loopback listener plus a journal for replay, ADR-178 §2), and refuses
 *     env that names ports on the client's machine.
 *
 * Built once in `main()` (index.ts) and handed to the server; nothing else in
 * the daemon asks which namespace it is in.
 *
 * Electron-free: the daemon bundle imports this.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  daemonDir,
  daemonPidFile,
  daemonSocketFile,
  daemonTokenFile,
  hookJournalFile,
  remoteHookPortFile,
  type DaemonNamespace,
} from "../paths";
import { bootstrapHost, type BootstrapHostResult } from "./bootstrap-host";
import { HookJournal } from "./hook-journal";
import { HookListener } from "./hook-listener";
import type { HookJournalEntry } from "./types";
import { errorMessage } from "../lib/errors";

export interface DaemonPaths {
  dir: string;
  socket: string;
  token: string;
  pid: string;
}

/** What `bootstrap` reports: see the `bootstrapped` control response. */
export interface BootstrapReport {
  agents: string[];
  warnings: string[];
}

export interface DaemonStartupContext {
  /** Broadcast a freshly journaled agent hook to every stream socket. */
  onHookEntry(entry: HookJournalEntry): void;
}

export interface DaemonRole {
  readonly namespace: DaemonNamespace;
  readonly paths: DaemonPaths;
  /** The agent-hook journal `replayHooks` serves; null when there is none. */
  readonly hookJournal: HookJournal | null;
  /**
   * Called once, right after the server starts listening and before it
   * handles any connection.
   */
  onStartup(ctx: DaemonStartupContext): void;
  /** Whether `updateEnv` may set `key` in the daemon's environment. */
  acceptsEnvKey(key: string): boolean;
  /** Answer the `bootstrap` control request. */
  bootstrap(): Promise<BootstrapReport>;
  /** Release what `onStartup` acquired, on the way out. */
  shutdown(): void;
}

type Log = (message: string) => void;

function pathsFor(namespace: DaemonNamespace): DaemonPaths {
  return {
    dir: daemonDir(namespace),
    socket: daemonSocketFile(namespace),
    token: daemonTokenFile(namespace),
    pid: daemonPidFile(namespace),
  };
}

export function localRole(): DaemonRole {
  const paths = pathsFor("local");
  return {
    namespace: "local",
    paths,
    hookJournal: null,
    onStartup() {
      // Before the remote namespace existed, a remote-bridge daemon shared
      // this directory and left a flag here that turned hook journaling on. A
      // local daemon never journals, so the flag is only ever stale.
      try {
        fs.unlinkSync(path.join(paths.dir, "remote-mode"));
      } catch {
        // Not there — the normal case.
      }
    },
    acceptsEnvKey: () => true,
    bootstrap() {
      // Electron main bootstraps the laptop itself, with MCP registration
      // this daemon could not do (app-lifecycle).
      return Promise.reject(
        new Error("Manor desktop bootstraps this host itself; its daemon does not"),
      );
    },
    shutdown() {},
  };
}

/**
 * Env naming ports on the client's machine. Meaningless on the box, and a
 * pushed `MANOR_HOOK_PORT{,_FILE}` would point agents there away from this
 * daemon's own hook listener (ADR-178 §2).
 */
const CLIENT_MACHINE_ENV_KEYS: ReadonlySet<string> = new Set([
  "MANOR_HOOK_PORT",
  "MANOR_HOOK_PORT_FILE",
  "MANOR_WEBVIEW_PORT",
  "MANOR_PORTLESS_PORT",
]);

export function remoteRole(log: Log): DaemonRole {
  let journal: HookJournal | null = null;
  let listener: HookListener | null = null;
  let bootstrapped: BootstrapHostResult | null = null;

  /**
   * The host bootstrap, run once and cached. MCP registration is skipped: the
   * MCP webview server talks to Electron's webview server, which is not on
   * this host. Retried by a later `bootstrap` request if it failed.
   */
  const runBootstrap = (): BootstrapHostResult => {
    if (!bootstrapped) {
      bootstrapped = bootstrapHost({ mcpServerScriptPath: null });
      log(`bootstrap: registered agents ${bootstrapped.agents.join(", ")}`);
      for (const warning of bootstrapped.warnings) log(`bootstrap warning: ${warning}`);
    }
    return bootstrapped;
  };

  /** Start the hook listener (idempotent; retried after a failure). */
  const startListener = async (): Promise<number> => {
    if (!listener) throw new Error("the hook journal could not be opened");
    const port = await listener.start();
    log(`hook listener on 127.0.0.1:${port} (journal seq ${journal?.lastSeq ?? 0})`);
    return port;
  };

  return {
    namespace: "remote",
    paths: pathsFor("remote"),
    get hookJournal() {
      return journal;
    },
    onStartup(ctx) {
      // All at startup rather than on the first `bootstrap` request: the
      // client's auto-reconnect after a daemon restart doesn't re-send it, a
      // shell spawned before the zdotdir / bash rcfile exist would miss OSC 7
      // prompt reporting, and hooks must be journaled before any client
      // reconnects.
      try {
        runBootstrap();
      } catch (err) {
        log(`bootstrap failed: ${errorMessage(err)}`);
      }
      try {
        const opened = new HookJournal(hookJournalFile(), { log });
        opened.open();
        journal = opened;
      } catch (err) {
        log(`hook journal could not be opened: ${errorMessage(err)}`);
        return;
      }
      // Published in the remote namespace's own port file, which every PTY
      // spawned from here on gets as `MANOR_HOOK_PORT_FILE`.
      listener = new HookListener({
        journal,
        portFile: remoteHookPortFile(),
        log,
        onEntry: (entry) => ctx.onHookEntry(entry),
      });
      startListener().catch((err: unknown) => {
        log(`hook listener failed to start: ${errorMessage(err)}`);
      });
    },
    acceptsEnvKey: (key) => !CLIENT_MACHINE_ENV_KEYS.has(key),
    async bootstrap() {
      const { agents, warnings } = runBootstrap();
      const report = { agents, warnings: [...warnings] };
      try {
        await startListener();
      } catch (err) {
        report.warnings.push(`agent hook listener could not start: ${errorMessage(err)}`);
      }
      return report;
    },
    shutdown() {
      listener?.stop();
      journal?.compact();
    },
  };
}
