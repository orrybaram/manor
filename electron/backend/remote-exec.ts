/**
 * An `Exec` that runs commands on a terminal-host daemon's machine instead
 * of this one (ADR-160). `file` maps to the daemon's `exec` control request,
 * `stream` to `execStream`/`execCancel` on the stream socket, and `readFile`
 * to `readFile` — all through a `TerminalHostClient`, which for a remote host
 * rides an `SshTransport`.
 *
 * The local git/shell/ports backends take this in place of `localExec` and
 * are otherwise unchanged; that is the whole point of the `Exec` seam.
 *
 * Differences from `localExec` a caller may notice:
 * - `file` with no `timeout` gets the daemon's default (30s), not "none";
 *   pass `0` for no timeout.
 * - Output past `maxBuffer` is truncated by the daemon rather than failing.
 * - A command the daemon could not spawn is reported by `stream` as a stderr
 *   chunk plus a `null` exit code, not as `error` — the wire does not tell
 *   the two apart. `error` is set only when the client itself could not run
 *   the command or lost the connection mid-run.
 */

import type { TerminalHostClient } from "../terminal-host/client";
import type { Exec, ExecError } from "./exec";

/** The slice of `TerminalHostClient` a remote `Exec` needs. */
export type RemoteExecClient = Pick<
  TerminalHostClient,
  "exec" | "execStream" | "readFile"
>;

/** Build the rejection `Exec.file` promises, shaped like Node's execFile error. */
function execError(
  cmd: string,
  args: string[],
  fields: { stdout: string; stderr: string; code: number | string | null },
  cause?: unknown,
): ExecError {
  const command = [cmd, ...args].join(" ");
  const err = new Error(
    `Command failed: ${command}\n${fields.stderr}`,
    cause === undefined ? undefined : { cause },
  ) as ExecError;
  err.stdout = fields.stdout;
  err.stderr = fields.stderr;
  err.code = fields.code;
  return err;
}

export function createRemoteExec(client: RemoteExecClient): Exec {
  return {
    async file(cmd, args, opts) {
      let result: Awaited<ReturnType<RemoteExecClient["exec"]>>;
      try {
        result = await client.exec(cmd, args, opts ?? {});
      } catch (err) {
        // The daemon could not be asked (connection lost, request timed out):
        // no output, and no exit code to report.
        const message = err instanceof Error ? err.message : String(err);
        throw execError(
          cmd,
          args,
          { stdout: "", stderr: message, code: null },
          err,
        );
      }
      const { stdout, stderr, exitCode } = result;
      if (exitCode !== 0) {
        throw execError(cmd, args, { stdout, stderr, code: exitCode });
      }
      return { stdout, stderr };
    },

    stream(cmd, args, opts, cb) {
      return client.execStream(cmd, args, opts, cb);
    },

    readFile(path, _encoding) {
      return client.readFile(path);
    },
  };
}
