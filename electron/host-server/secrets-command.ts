/**
 * `manor-host secrets encrypt|status [--json]` (ADR-236 D1).
 *
 * `encrypt` moves a host server whose pairing keys sit in plaintext onto the
 * `key-file` backend in one go: it makes a key outside `~/.manor`
 * (`hostSecretKeyFile()`), names it in `supervisor.env`, and restarts the
 * server, whose fresh start re-seals every `*.enc` file with it
 * (`upgradeFromPlaintext`), so phones stay paired. Every step is idempotent,
 * so a retry after a failed restart picks up where the last run stopped. The
 * desktop runs it through the host transport's `exec`.
 *
 * What this buys is narrow, and the UI says so: a copy of `~/.manor` can no
 * longer read the pairing keys; a copy of the whole home directory or disk
 * still can.
 *
 * `status` prints the same facts with no side effects.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorMessage } from "../lib/errors";
import {
  hostSecretKeyFile,
  hostServerPaths,
  supervisorEnvFile,
  supervisorMarkerFile,
} from "../paths";
import {
  readSecretBackendChoice,
  secretKeyPlace,
  shownSecretKeyFile,
  validateSecretKey,
  type SecretBackend,
  type SecretKeyPlace,
} from "../platform/secret-box";
import { restartServer } from "./lifecycle";
import {
  applySupervisorEnv,
  parseSupervisorEnv,
  readSupervisorMarker,
  writeSupervisorEnv,
} from "./supervisor";

const KEY_BYTES = 32;

/** What `secrets … --json` prints under `secrets`. */
export interface SecretsFacts {
  /** What `secret-backend` records; null before a server has ever started. */
  backend: SecretBackend | null;
  /** The key file sealing the keys, home shortened to `~`; null unless `key-file` with a file. */
  keyFile: string | null;
  /** Where that key lives (`secretKeyPlace`); null unless `key-file`. */
  place: SecretKeyPlace | null;
}

export interface SecretsCommandDeps {
  /** The server's `secret-backend` file. */
  choiceFile: string;
  /** `supervisor.env`. */
  envFile: string;
  /** Where Manor makes the key (`hostSecretKeyFile()`). */
  keyFile: string;
  /** `supervisor.json`. */
  markerFile: string;
  /** Restart the host server and wait for one of this version to listen. */
  restart(): Promise<void>;
  randomBytes(size: number): Buffer;
  /** This process's environment; it wins over `supervisor.env`, as for `serve`. */
  env: NodeJS.ProcessEnv;
  /** For `place` and the shortened `keyFile`. Defaults to `os.homedir()`. */
  home?: string;
}

function defaultDeps(): SecretsCommandDeps {
  return {
    choiceFile: hostServerPaths().secretBackend,
    envFile: supervisorEnvFile(),
    keyFile: hostSecretKeyFile(),
    markerFile: supervisorMarkerFile(),
    restart: () => restartServer(),
    randomBytes: (size) => crypto.randomBytes(size),
    env: process.env,
  };
}

/** The key variables the server would start with: `env`'s, else `supervisor.env`'s. */
function serverKeyEnv(deps: SecretsCommandDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["MANOR_SECRET_KEY_FILE", "MANOR_SECRET_KEY"] as const) {
    if (deps.env[key]) env[key] = deps.env[key];
  }
  applySupervisorEnv(env, deps.envFile);
  return env;
}

export function readSecretsFacts(deps: SecretsCommandDeps): SecretsFacts {
  const backend = readSecretBackendChoice(deps.choiceFile);
  if (backend !== "key-file") return { backend, keyFile: null, place: null };
  const home = deps.home ?? os.homedir();
  const env = serverKeyEnv(deps);
  return {
    backend,
    keyFile: shownSecretKeyFile(env, home),
    place: secretKeyPlace(env, home, [deps.envFile]),
  };
}

function readEnvFile(file: string): Partial<Record<string, string>> {
  try {
    return parseSupervisorEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Make sure `file` holds a usable key: reuse a valid one, refuse an invalid
 * one (never overwritten: it may be what sealed the keys), else write
 * `KEY_BYTES` random bytes, file 0600 in a 0700 directory.
 */
function ensureKeyFile(file: string, randomBytes: (size: number) => Buffer): void {
  const check = () => {
    const result = validateSecretKey({ MANOR_SECRET_KEY_FILE: file });
    if (!result.ok) throw new Error(`${file} exists but is not a usable key: ${result.error}. Manor won't overwrite it.`);
  };
  if (fs.existsSync(file)) {
    check();
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Another run made it in between: use it if it is good.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    check();
  }
}

function logHint(choiceFile: string): string {
  return path.join(path.dirname(choiceFile), "logs", "host-server.log");
}

/** ADR-236 D1, steps 1–7. Throws with a message for the user on failure. */
export async function encryptSecrets(deps: SecretsCommandDeps): Promise<SecretsFacts> {
  // 1. A container's environment gives it a key; nothing here would persist.
  if (readSupervisorMarker(deps.markerFile) === "container") {
    throw new Error(
      "This host runs in a container: give it a key through the container's environment (MANOR_SECRET_KEY_FILE naming a mounted secret)",
    );
  }

  // 2. Already sealed with something stronger.
  const before = readSecretBackendChoice(deps.choiceFile);
  if (before !== null && before !== "plaintext") return readSecretsFacts(deps);

  // 3. A key already named in supervisor.env: use it if valid, never replace it.
  const fromFile = readEnvFile(deps.envFile);
  if (fromFile.MANOR_SECRET_KEY_FILE || fromFile.MANOR_SECRET_KEY) {
    const result = validateSecretKey({
      MANOR_SECRET_KEY_FILE: fromFile.MANOR_SECRET_KEY_FILE,
      MANOR_SECRET_KEY: fromFile.MANOR_SECRET_KEY,
    });
    if (!result.ok) {
      throw new Error(`${deps.envFile} names a key that can't be used: ${result.error}`);
    }
  } else {
    // 4. Make (or reuse) the key file.
    ensureKeyFile(deps.keyFile, deps.randomBytes);
    // 5. Name it in supervisor.env.
    writeSupervisorEnv(deps.envFile, { MANOR_SECRET_KEY_FILE: deps.keyFile });
  }

  // 6. Restart, so the server re-seals its keys with it.
  try {
    await deps.restart();
  } catch (err) {
    throw new Error(
      `The host server did not restart (${errorMessage(err)}); see ${logHint(deps.choiceFile)}. The key is kept for the next try.`,
      { cause: err },
    );
  }

  // 7. Did it take?
  const facts = readSecretsFacts(deps);
  if (facts.backend !== "key-file") {
    throw new Error(
      `The host server restarted but its pairing keys are still ${facts.backend ?? "unrecorded"}; see ${logHint(deps.choiceFile)}. The key is kept for the next try.`,
    );
  }
  return facts;
}

function describe(facts: SecretsFacts): string {
  if (facts.backend === null) return "No host server has started here yet.";
  if (facts.backend === "plaintext") return "Pairing keys are stored unencrypted.";
  if (facts.backend !== "key-file") return `Pairing keys are encrypted with ${facts.backend}.`;
  const where = facts.keyFile ? `the key at ${facts.keyFile}` : "a key from the environment";
  return `Pairing keys are encrypted with ${where} (${facts.place ?? "unknown place"}).`;
}

/**
 * `manor-host secrets encrypt|status [--json]`. With `--json`, one line on
 * stdout: `{"secrets": {backend, keyFile, place}}`, or `{"error": "…"}` with
 * a non-zero exit, mirroring `supervisor --json`. Answers the exit code.
 */
export async function runSecretsCommand(
  argv: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  deps: SecretsCommandDeps = defaultDeps(),
): Promise<number> {
  const [action] = argv;
  const json = argv.includes("--json");
  const report = (facts: SecretsFacts) => {
    io.stdout.write(json ? `${JSON.stringify({ secrets: facts })}\n` : `${describe(facts)}\n`);
  };
  try {
    switch (action) {
      case "encrypt":
        report(await encryptSecrets(deps));
        return 0;
      case "status":
        report(readSecretsFacts(deps));
        return 0;
      default:
        throw new Error("usage: manor-host secrets encrypt|status [--json]");
    }
  } catch (err) {
    const message = errorMessage(err);
    if (json) io.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else io.stderr.write(`${message}\n`);
    return 1;
  }
}
