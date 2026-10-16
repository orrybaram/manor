/**
 * The desktop's side of key encryption (ADR-236 D7): running
 * `manor-host secrets encrypt|status --json` on a host, through its
 * transport's `exec` (ssh, or a recipe's exec prefix).
 *
 * `hosts.encryptKeys` calls it with `encrypt`.
 */

import type { SecretsFacts } from "../host-server/secrets-command";
import { REMOTE_HOST_BIN } from "../terminal-host/ssh-config";
import type { HostTransport } from "../terminal-host/transport";

export type SecretsAction = "encrypt" | "status";

/** Encrypting restarts the server; give the command room on a slow link. */
const SECRETS_EXEC_TIMEOUT_MS = 60_000;

/** Read `secrets … --json`'s one line: the facts, or its error. */
function parseSecretsOutput(stdout: string): SecretsFacts {
  const line = stdout.trim().split("\n").pop() ?? "";
  let parsed: { secrets?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    throw new Error(`manor-host secrets said something unreadable: ${line.slice(0, 200)}`);
  }
  if (typeof parsed.error === "string") throw new Error(parsed.error);
  const facts = parsed.secrets as Partial<SecretsFacts> | null | undefined;
  if (!facts || typeof facts !== "object") {
    throw new Error(`manor-host secrets said something unreadable: ${line.slice(0, 200)}`);
  }
  return facts as SecretsFacts;
}

/**
 * Run `secrets <action> --json` on the host `transport` reaches. Answers the
 * host's key facts afterwards; rejects when the host cannot be reached, or
 * the command fails (with its own message).
 */
export async function runHostSecrets(
  transport: HostTransport,
  action: SecretsAction,
): Promise<SecretsFacts> {
  if (!transport.exec) throw new Error("This host can't run commands.");
  const { code, stdout, stderr } = await transport.exec(
    `exec ${REMOTE_HOST_BIN} secrets ${action} --json`,
    { timeoutMs: SECRETS_EXEC_TIMEOUT_MS },
  );
  if (stdout.trim() === "" && code !== 0) {
    const detail = stderr.trim().slice(-300);
    throw new Error(
      `manor-host secrets ${action} exited (code ${code ?? "none"})${detail ? `: ${detail}` : ""}`,
    );
  }
  return parseSecretsOutput(stdout);
}
