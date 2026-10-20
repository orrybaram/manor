/**
 * The desktop's side of key encryption: running
 * `manor-host secrets encrypt|status --json` on a host, through its
 * transport's `exec` (ssh, or a recipe's exec prefix).
 *
 * `hosts.encryptKeys` calls it with `encrypt`.
 */

import type { SecretsFacts } from "../host-server/secrets-command";
import type { HostTransport } from "../terminal-host/transport";
import { runHostJsonCommand } from "./host-json-command";

export type SecretsAction = "encrypt" | "status";

/** Encrypting restarts the server; give the command room on a slow link. */
const SECRETS_EXEC_TIMEOUT_MS = 60_000;

const BACKENDS: readonly string[] = ["safeStorage", "systemd-creds", "libsecret", "key-file", "plaintext"];
const PLACES: readonly string[] = ["data-dir", "home", "elsewhere"];

/** `secrets … --json`'s facts, checked field by field; undefined when malformed. */
function readSecretsFacts(value: unknown): SecretsFacts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const facts = value as { backend?: unknown; keyFile?: unknown; place?: unknown };
  const { backend, keyFile, place } = facts;
  if (backend !== null && !(typeof backend === "string" && BACKENDS.includes(backend))) return undefined;
  if (keyFile !== null && typeof keyFile !== "string") return undefined;
  if (place !== null && !(typeof place === "string" && PLACES.includes(place))) return undefined;
  return {
    backend: backend as SecretsFacts["backend"],
    keyFile,
    place: place as SecretsFacts["place"],
  };
}

/**
 * Run `secrets <action> --json` on the host `transport` reaches. Answers the
 * host's key facts afterwards; rejects when the host cannot be reached, or
 * the command fails (with its own message).
 */
export function runHostSecrets(transport: HostTransport, action: SecretsAction): Promise<SecretsFacts> {
  return runHostJsonCommand(
    transport,
    `secrets ${action}`,
    "secrets",
    SECRETS_EXEC_TIMEOUT_MS,
    readSecretsFacts,
  );
}
