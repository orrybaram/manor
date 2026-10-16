/**
 * `manor-host serve` (ADR-225 D1): run one host server in this process until
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
 * - `secret-backend` — which `SecretBox` sealed this server's keys;
 * - `relay-identity.enc`, `remote-devices.enc`, `remote-vapid.enc` — its own
 *   relay room, the phones paired to it and its push keys, sealed (D3).
 *
 * Kept apart from `index.ts` so a test can run a whole server in-process.
 */

import fs from "node:fs";
import { errorMessage } from "../lib/errors";
import { installMainLog } from "../main-log";
import { hostServerPaths, type DaemonNamespace } from "../paths";
import { pickHostSecretBox } from "../platform/secret-box";
import type { HostTransport } from "../terminal-host/transport";
import { isAlive, readPid, removeIfOurs } from "./pid-file";
import type { HostRelayOptions } from "./relay";
import type { ServerKeyStatus } from "./secrets-command";
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
  /** Tests: a local relay, and push with no push service behind it. */
  relay?: HostRelayOptions;
  /**
   * The key sealing the pairing keys, kept out of `process.env` (ADR-236
   * D2, `takeSecretEnv`), and what status reports about it, computed once
   * at start. Absent in tests: the secret box then reads `process.env`, and
   * status reports no key.
   */
  secrets?: { env: NodeJS.ProcessEnv; status: ServerKeyStatus };
}

export interface RunningServer {
  server: HostServer;
  stop(): Promise<void>;
}

/** Whether `pid` names a live process other than this one. */
function isOtherLiveProcess(pid: number): boolean {
  return pid !== process.pid && isAlive(pid);
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
    // The rest of the environment too: libsecret needs the session bus.
    env: opts.secrets ? { ...process.env, ...opts.secrets.env } : undefined,
  });
  console.info(
    `[host-server] ${opts.version} starting in ${paths.dataDir}; secrets: ${secretBox.backend()}`,
  );

  const server = createHostServer({
    dataDir: paths.dataDir,
    daemonNamespace: opts.daemonNamespace ?? "remote",
    secretBox,
    appVersion: opts.version,
    transport: opts.transport,
    relay: opts.relay,
    keyStatus: opts.secrets?.status,
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
