/**
 * `manor-host serve` (ADR-218 D1): run one host server in this process until
 * it is told to stop.
 *
 * What it leaves in `dataDir` while it runs (names in `hostServerPaths`):
 *
 * - `server.sock` — the owner channel's socket (`./socket.ts`), 0600;
 * - `owner-token` — the token that socket's hello must present, 0600, new on
 *   every start;
 * - `server.pid` and `server.version` — who is running, for the lifecycle
 *   check that replaces a server whose version is stale (ticket 5);
 * - `logs/host-server.log` — console output, rotated (`main-log.ts`);
 * - `secret-backend` — which `SecretBox` sealed this server's keys.
 *
 * Kept apart from `index.ts` so a test can run a whole server in-process.
 */

import fs from "node:fs";
import { errorMessage } from "../lib/errors";
import { installMainLog } from "../main-log";
import { hostServerPaths, type DaemonNamespace } from "../paths";
import { pickHostSecretBox } from "../platform/secret-box";
import type { HostTransport } from "../terminal-host/transport";
import { createHostServer, type HostServer } from "./server";
import {
  listenHostSocket,
  newOwnerToken,
  ownerTokenAuthenticator,
  writeOwnerToken,
} from "./socket";

export interface ServeOptions {
  /** Defaults to `~/.manor/remote/server/`. */
  dataDir?: string;
  version: string;
  daemonNamespace?: DaemonNamespace;
  /** Tests: reach the daemon some other way, and keep console output local. */
  transport?: HostTransport;
  logToFile?: boolean;
}

export interface RunningServer {
  server: HostServer;
  stop(): Promise<void>;
}

/** Whether `pid` names a live process other than this one. */
function isOtherLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, but someone else's — still not ours to replace.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(file: string): number | null {
  try {
    return Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

/** Remove `file` only if it still holds what this process wrote there. */
function removeIfOurs(file: string, contents: string): void {
  try {
    if (fs.readFileSync(file, "utf-8") === contents) fs.unlinkSync(file);
  } catch {
    // Gone, or replaced by a newer server.
  }
}

export async function runServe(opts: ServeOptions): Promise<RunningServer> {
  const paths = hostServerPaths(opts.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  if (opts.logToFile ?? true) {
    installMainLog({ dir: paths.logsDir, fileName: "host-server.log" });
  }

  const running = readPid(paths.pid);
  if (running !== null && isOtherLiveProcess(running)) {
    throw new Error(`a host server is already running (pid ${running})`);
  }

  const secretBox = await pickHostSecretBox({
    choiceFile: paths.secretBackend,
  });
  console.info(
    `[host-server] ${opts.version} starting in ${paths.dataDir}; secrets: ${secretBox.backend()}`,
  );

  const server = createHostServer({
    dataDir: paths.dataDir,
    daemonNamespace: opts.daemonNamespace ?? "remote",
    secretBox,
    appInfo: {
      version: opts.version,
      isPackaged: true,
      logsDir: paths.logsDir,
    },
    transport: opts.transport,
  });

  const token = newOwnerToken();
  writeOwnerToken(paths.ownerToken, token);
  const listener = await listenHostSocket(
    paths.socket,
    server.frames,
    ownerTokenAuthenticator(token),
  );

  // Written once the socket listens, so whoever sees the pid can connect.
  const pidContents = `${process.pid}\n`;
  const versionContents = `${opts.version}\n`;
  fs.writeFileSync(paths.pid, pidContents, { mode: 0o600 });
  fs.writeFileSync(paths.version, versionContents, { mode: 0o600 });

  await server.start();
  console.info(`[host-server] listening on ${paths.socket}`);

  let stopping: Promise<void> | null = null;
  return {
    server,
    stop: () => {
      stopping ??= (async () => {
        console.info("[host-server] stopping");
        try {
          await listener.close();
          await server.stop();
        } catch (err) {
          console.error(
            "[host-server] error while stopping:",
            errorMessage(err),
          );
        }
        removeIfOurs(paths.pid, pidContents);
        removeIfOurs(paths.version, versionContents);
        removeIfOurs(paths.ownerToken, token + "\n");
      })();
      return stopping;
    },
  };
}
