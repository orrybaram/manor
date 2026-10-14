/**
 * Runs one recipe command (ADR-229 D2) the way Orca runs its environment
 * recipes: on this machine, in the recipe's directory, with the lifecycle
 * payload on stdin.
 *
 * - **Environment.** The user's own, plus the recipe's `env`, plus
 *   `MANOR_HOST_ID`, `MANOR_RECIPE_DIR` and `MANOR_INSTANCE_ID` (D6).
 * - **Stdin.** `{hostId, resource}`, `resource` being whatever the last `up`
 *   returned.
 * - **Stdout is one JSON object and nothing else** (capped at 64 KB). One
 *   stray `echo` is an error that quotes it, rather than a result read wrong.
 * - **Stderr is progress,** one line at a time, and its tail (2 KB) is
 *   quoted when the command fails.
 * - **Timeouts** per command; one that runs out kills the command's whole
 *   process group, so a script's own children don't outlive it.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { resolveRecipeCommand, type Recipe, type RecipeCommandName } from "./recipes";

/** How long each command may run (ADR-229 D2). */
export const RECIPE_TIMEOUTS_MS: Readonly<Record<RecipeCommandName, number>> = Object.freeze({
  up: 15 * 60_000,
  status: 2 * 60_000,
  stop: 2 * 60_000,
  destroy: 10 * 60_000,
});

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_TAIL = 2 * 1024;
/** After SIGTERM to a timed-out group, how long before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/**
 * After the command exits, how long to wait for its stdout to close. A
 * background child it left behind may hold the pipe open; what was printed
 * by then is the result.
 */
const STDIO_DRAIN_MS = 1_000;

/** A recipe command that failed: it would not run, exited non-zero, timed out, or printed no one JSON object. */
export class RecipeCommandError extends Error {
  constructor(
    readonly command: RecipeCommandName,
    message: string,
    readonly code: number | null,
    /** The last 2 KB of what it printed on stderr. */
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "RecipeCommandError";
  }
}

export type RecipeSpawn = (
  file: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

/** Its own process group (`detached`), so a timeout can kill everything it started. */
const defaultSpawn: RecipeSpawn = (file, opts) =>
  nodeSpawn(file, [], { ...opts, detached: true, stdio: ["pipe", "pipe", "pipe"] });

export interface RunRecipeOptions {
  recipe: Recipe;
  /** The recipe's directory: the command's cwd, and where a relative command is. */
  dir: string;
  hostId: string;
  /** `MANOR_INSTANCE_ID` (ADR-229 D6). */
  instanceId: string;
  /** What the last `up` returned, handed back on stdin. */
  resource?: unknown;
  /** One stderr line at a time. */
  onProgress?: (line: string) => void;
  /** Replaces the command's own timeout. For tests. */
  timeoutMs?: number;
  /** Replaces `child_process.spawn`. For tests. */
  spawn?: RecipeSpawn;
}

/** Kill `child`'s whole process group with `signal`; just the child where there are no groups. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** The tail of `text`, at most `max` characters. */
function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Parse `stdout` as exactly one JSON object, or say what else it held. A
 * result that isn't one names its first line, which is usually a stray
 * `echo` meant for stderr.
 */
export function parseRecipeStdout(command: RecipeCommandName, stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  if (text === "") {
    throw new Error(`\`${command}\` printed nothing on stdout; it must print one JSON object`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const first = text.split(/\r?\n/, 1)[0].slice(0, 200);
    throw new Error(
      `\`${command}\` must print exactly one JSON object on stdout, and nothing else; ` +
        `it printed ${JSON.stringify(first)}${text.includes("\n") ? " (and more)" : ""}. ` +
        "Send progress to stderr (>&2).",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`\`${command}\` must print one JSON object on stdout, not ${JSON.stringify(text.slice(0, 200))}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Run `recipe`'s `command` and resolve with the one JSON object it printed.
 * Rejects with a `RecipeCommandError` — naming the command, its exit code and
 * its stderr's tail — when it is not declared, cannot start, exits non-zero,
 * runs out of time, or prints anything but one JSON object.
 */
export function runRecipeCommand(
  command: RecipeCommandName,
  opts: RunRecipeOptions,
): Promise<Record<string, unknown>> {
  const { recipe, dir } = opts;
  const declared = recipe[command];
  if (declared === undefined) {
    return Promise.reject(
      new RecipeCommandError(command, `Recipe "${recipe.name}" has no \`${command}\` command`, null, ""),
    );
  }
  let file: string;
  try {
    file = resolveRecipeCommand(dir, declared);
  } catch (err) {
    return Promise.reject(new RecipeCommandError(command, (err as Error).message, null, ""));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...recipe.env,
    MANOR_HOST_ID: opts.hostId,
    MANOR_RECIPE_DIR: dir,
    MANOR_INSTANCE_ID: opts.instanceId,
  };
  const timeoutMs = opts.timeoutMs ?? RECIPE_TIMEOUTS_MS[command];
  const label = `${recipe.name}'s \`${command}\``;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? defaultSpawn)(file, { cwd: dir, env });
    } catch (err) {
      reject(new RecipeCommandError(command, `${label} could not start: ${(err as Error).message}`, null, ""));
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let overflow = false;
    let stderrTail = "";
    let partial = "";
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (message: string): RecipeCommandError =>
      new RecipeCommandError(
        command,
        message + (stderrTail.trim() ? `\n${stderrTail.trim()}` : ""),
        exitCode,
        stderrTail,
      );

    const emitLine = (line: string): void => {
      const trimmed = line.replace(/\r$/, "").trimEnd();
      if (trimmed !== "") opts.onProgress?.(trimmed);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (partial) emitLine(partial);
      partial = "";
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        reject(fail(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      if (exitCode !== 0) {
        reject(fail(`${label} failed (${exitCode === null ? `signal ${exitSignal ?? "unknown"}` : `exit ${exitCode}`})`));
        return;
      }
      if (overflow) {
        reject(fail(`${label} printed more than ${MAX_STDOUT_BYTES / 1024} KB on stdout`));
        return;
      }
      try {
        resolve(parseRecipeStdout(command, stdout));
      } catch (err) {
        reject(fail((err as Error).message));
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killGroup(child, "SIGKILL");
        // Its group is gone whether or not anything still holds the pipes.
        finish();
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) overflow = true;
      else stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrTail = tail(stderrTail + text, MAX_STDERR_TAIL);
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) emitLine(line);
    });
    child.stdin?.on("error", () => {
      // A command that never reads stdin may exit before it is written.
    });
    child.stdin?.end(`${JSON.stringify({ hostId: opts.hostId, resource: opts.resource ?? null })}\n`);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new RecipeCommandError(command, `${label} could not start: ${err.message}`, null, stderrTail));
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Timed out: the rest of its group may still hold the pipes; the kill
      // timer finishes then.
      if (timedOut) return;
      drainTimer = setTimeout(finish, STDIO_DRAIN_MS);
    });
    child.on("close", () => {
      // Timed out: whatever of its group ignored SIGTERM goes now.
      if (timedOut) killGroup(child, "SIGKILL");
      finish();
    });
  });
}
