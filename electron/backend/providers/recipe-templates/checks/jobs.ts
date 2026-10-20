/**
 * The templates' background jobs: pulling Manor's host
 * image, or building it on this computer when the pull failed. A fix starts
 * one (`hosts.runTemplateFix`); the next `checkTemplate` reads its progress,
 * or its failure, from here. They live in main, so they outlive the dialog
 * that started them; one per key (`jobKey`: the daemon's context and the
 * image), and every one is killed when the app quits (`stopTemplateJobs`).
 */

import { spawn as nodeSpawn } from "node:child_process";

export type JobKind = "pull" | "build";

export interface JobState {
  kind: JobKind;
  status: "running" | "failed";
  /** While running, once known: "3 of 7 layers", "Step 2 of 6". */
  progress?: string;
  /** When failed: the last lines it printed. */
  output?: string;
}

/** What a job needs of a child process: its output, its end, and a kill. */
export interface JobChild {
  stdout: {
    on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  stderr: {
    on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(): unknown;
}

/** Starts `file` with `args`, no shell. A seam, so tests fake it. */
export type JobSpawn = (file: string, args: string[]) => JobChild;

const defaultSpawn: JobSpawn = (file, args) =>
  nodeSpawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

/** How many of a job's last lines are kept for its failure. */
const TAIL_LINES = 20;

/** The key a job is held under: one per daemon and image. */
export function jobKey(context: string, image: string): string {
  return `${context}|${image}`;
}

/**
 * Layer progress from `docker pull`'s lines. Without a terminal docker
 * prints each layer's status changes ("Pulling fs layer", "Downloading",
 * "Pull complete", "Already exists") but no byte counts, so this counts
 * layers.
 */
export function pullProgress(): {
  line: (line: string) => void;
  text: () => string | undefined;
} {
  const layers = new Map<string, boolean>();
  return {
    line(line) {
      const m = /^([0-9a-f]{12,64}): (.+)$/.exec(line.trim());
      if (!m) return;
      const [, id, status] = m;
      const done = /^(Pull complete|Already exists)/.test(status);
      layers.set(id, done || (layers.get(id) ?? false));
    },
    text() {
      if (layers.size === 0) return undefined;
      const done = [...layers.values()].filter(Boolean).length;
      return `${done} of ${layers.size} layers`;
    },
  };
}

/** Step progress from `docker build`'s lines: BuildKit's "[2/6]" or the classic "Step 2/6". */
export function buildProgress(): {
  line: (line: string) => void;
  text: () => string | undefined;
} {
  let step: { n: number; of: number } | undefined;
  return {
    line(line) {
      const m =
        /\[\s*(\d+)\/(\d+)\]/.exec(line) ??
        /^Step (\d+)\/(\d+)/.exec(line.trim());
      if (!m) return;
      const n = Number(m[1]);
      const of = Number(m[2]);
      if (!step || n >= step.n || of !== step.of) step = { n, of };
    },
    text: () => (step ? `Step ${step.n} of ${step.of}` : undefined),
  };
}

interface Job {
  state: JobState;
  child: JobChild;
}

export class TemplateJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly spawn: JobSpawn = defaultSpawn) {}

  /**
   * Start `file args` as job `kind` under `key`, unless one is already
   * running there (then this does nothing). A finished job's failure is
   * replaced; a success leaves nothing behind (the next check finds the image).
   */
  start(key: string, kind: JobKind, file: string, args: string[]): void {
    if (this.jobs.get(key)?.state.status === "running") return;
    const parser = kind === "pull" ? pullProgress() : buildProgress();
    const tail: string[] = [];
    let child: JobChild;
    try {
      child = this.spawn(file, args);
    } catch (err) {
      this.jobs.set(key, {
        state: {
          kind,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
        },
        child: {
          stdout: null,
          stderr: null,
          on: () => undefined,
          kill: () => undefined,
        },
      });
      return;
    }
    const job: Job = { state: { kind, status: "running" }, child };
    this.jobs.set(key, job);

    const onLine = (line: string) => {
      if (line.trim() === "") return;
      tail.push(line.trimEnd());
      if (tail.length > TAIL_LINES) tail.shift();
      parser.line(line);
      const progress = parser.text();
      if (progress !== undefined) job.state.progress = progress;
    };
    const reader = () => {
      let partial = "";
      return (chunk: Buffer | string) => {
        const lines = (partial + chunk.toString()).split(/\r?\n|\r/);
        partial = lines.pop() ?? "";
        lines.forEach(onLine);
      };
    };
    child.stdout?.on("data", reader());
    child.stderr?.on("data", reader());

    let ended = false;
    const end = (failure: string | null) => {
      if (ended) return;
      ended = true;
      // Stopped (`stopAll`) or replaced: nothing to record.
      if (this.jobs.get(key) !== job) return;
      if (failure === null) this.jobs.delete(key);
      else job.state = { kind, status: "failed", output: failure };
    };
    child.on("error", (err: Error) =>
      end(tail.length > 0 ? `${tail.join("\n")}\n${err.message}` : err.message),
    );
    child.on("close", (code: number | null) =>
      end(
        code === 0
          ? null
          : tail.join("\n") || `${file} exited with code ${String(code)}`,
      ),
    );
  }

  /** Job `key`'s state: running, or how it last failed; undefined when there is neither. */
  get(key: string): JobState | undefined {
    const state = this.jobs.get(key)?.state;
    return state ? { ...state } : undefined;
  }

  /** Forget job `key`'s failure (the image turned up some other way). A running job stays. */
  clear(key: string): void {
    if (this.jobs.get(key)?.state.status !== "running") this.jobs.delete(key);
  }

  /** Kill every running job and forget them all. */
  stopAll(): void {
    for (const { state, child } of this.jobs.values()) {
      if (state.status === "running") child.kill();
    }
    this.jobs.clear();
  }
}

/** The app's jobs, which `checkTemplate` and `runTemplateFix` share. */
export const templateJobs = new TemplateJobs();

/** Kill the app's background pulls and builds. Called on quit. */
export function stopTemplateJobs(): void {
  templateJobs.stopAll();
}
