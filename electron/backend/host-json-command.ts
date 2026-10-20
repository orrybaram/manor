/**
 * Running a `manor-host <command> --json` on a host through its transport's
 * `exec` (ssh, or a recipe's exec prefix), the protocol `supervisor` and `secrets` share: one JSON line on stdout,
 * `{"<resultKey>": …}` on success or `{"error": "…"}` with a non-zero exit.
 */

import { REMOTE_HOST_BIN } from "../terminal-host/ssh-config";
import type { HostTransport } from "../terminal-host/transport";

/**
 * Run `manor-host <args> --json` on the host `transport` reaches and answer
 * `read(value)` of its `resultKey`. `read` answers undefined for a value of
 * the wrong shape, which is reported as unreadable. Rejects when the host
 * can't run commands or be reached, or the command fails (with its own
 * message).
 */
export async function runHostJsonCommand<T>(
  transport: HostTransport,
  args: string,
  resultKey: string,
  timeoutMs: number,
  read: (value: unknown) => T | undefined,
): Promise<T> {
  if (!transport.exec) throw new Error("This host can't run commands.");
  const { code, stdout, stderr } = await transport.exec(`exec ${REMOTE_HOST_BIN} ${args} --json`, {
    timeoutMs,
  });
  if (stdout.trim() === "" && code !== 0) {
    const detail = stderr.trim().slice(-300);
    throw new Error(
      `manor-host ${args} exited (code ${code ?? "none"})${detail ? `: ${detail}` : ""}`,
    );
  }
  const line = stdout.trim().split("\n").pop() ?? "";
  const unreadable = () =>
    new Error(`manor-host ${args.split(" ")[0]} said something unreadable: ${line.slice(0, 200)}`);
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown> | null;
  } catch {
    throw unreadable();
  }
  if (!parsed || typeof parsed !== "object") throw unreadable();
  if (typeof parsed.error === "string") throw new Error(parsed.error);
  const value = read(parsed[resultKey]);
  if (value === undefined) throw unreadable();
  return value;
}
