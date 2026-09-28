/**
 * An `Exec` that runs commands on a terminal-host daemon's machine instead
 * of this one (ADR-160). `file` maps to the daemon's `exec` control request,
 * `stream` to `execStream`/`execCancel` on the stream socket, and `readFile`
 * and `writeFile` to the requests of the same name — all through a `TerminalHostClient`, which for a remote host
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
 * - `writeFile` against a daemon too old to have the request (ADR-187) falls
 *   back to a chunked upload through `exec`: slower, and a reader may see
 *   the temp file `<path>.upload.tmp` while it is written, but the target
 *   itself only appears once complete.
 */

import { errorMessage } from "../lib/errors";
import type { TerminalHostClient } from "../terminal-host/client";
import type { Exec, ExecError } from "./exec";

/** The slice of `TerminalHostClient` a remote `Exec` needs. */
export type RemoteExecClient = Pick<
  TerminalHostClient,
  "exec" | "execStream" | "readFile" | "writeFile"
>;

/**
 * Base64 characters per chunk of the `exec` fallback for `writeFile`. A
 * multiple of 4, so each chunk decodes on its own, and well under Linux's
 * 128 KiB per-argument limit (`MAX_ARG_STRLEN`).
 */
export const WRITE_FILE_CHUNK_CHARS = 64 * 1024;

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
  // Set once the daemon answers `writeFile` with "unknown request type" (it
  // predates ADR-187), so later writes go straight to the fallback.
  let daemonLacksWriteFile = false;

  /** Run a fallback step; a non-zero exit rejects with an `ExecError`. */
  async function run(cmd: string, args: string[]): Promise<void> {
    const { stdout, stderr, exitCode } = await client.exec(cmd, args, {});
    if (exitCode !== 0) {
      throw execError(cmd, args, { stdout, stderr, code: exitCode });
    }
  }

  /** Upload `data` in base64 chunks through `exec`, then move it into place. */
  async function writeFileByExec(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.upload.tmp`;
    const base64 = data.toString("base64");
    try {
      await run("sh", ["-c", 'mkdir -p "$(dirname "$1")" && : > "$1"', "sh", tmp]);
      for (let i = 0; i < base64.length; i += WRITE_FILE_CHUNK_CHARS) {
        const chunk = base64.slice(i, i + WRITE_FILE_CHUNK_CHARS);
        await run("sh", ["-c", 'printf %s "$1" | base64 -d >> "$2"', "sh", chunk, tmp]);
      }
      await run("mv", ["-f", tmp, path]);
    } catch (err) {
      await client.exec("rm", ["-f", tmp], {}).catch(() => {
        /* best effort; the original error is what matters */
      });
      throw err;
    }
  }

  return {
    async file(cmd, args, opts) {
      let result: Awaited<ReturnType<RemoteExecClient["exec"]>>;
      try {
        result = await client.exec(cmd, args, opts ?? {});
      } catch (err) {
        // The daemon could not be asked (connection lost, request timed out):
        // no output, and no exit code to report.
        const message = errorMessage(err);
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

    async writeFile(path, data) {
      if (!daemonLacksWriteFile) {
        try {
          await client.writeFile(path, data);
          return;
        } catch (err) {
          if (!errorMessage(err).includes("unknown request type")) throw err;
          daemonLacksWriteFile = true;
        }
      }
      await writeFileByExec(path, data);
    },
  };
}
