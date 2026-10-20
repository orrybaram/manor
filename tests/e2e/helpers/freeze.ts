import { spawnSync } from "child_process";

import type { ElectronApplication } from "@playwright/test";

/**
 * A closed lid, as the process table sees it: every process of
 * the app stops where it is — timers, sockets, the renderer — and later
 * carries on as if nothing happened, its timers firing late and its sockets
 * whatever the world left of them.
 *
 * Only this test's app is touched: the tree under its own main pid, never a
 * match by name, so a second app another run has open keeps going.
 */

/** Every descendant of `root` (not `root` itself), parents before children. */
function descendants(root: number): { pid: number; comm: string }[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf-8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr}`);
  const children = new Map<number, { pid: number; comm: string }[]>();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const entry = { pid: Number(m[1]), comm: m[3].trim() };
    const list = children.get(Number(m[2])) ?? [];
    list.push(entry);
    children.set(Number(m[2]), list);
  }
  const out: { pid: number; comm: string }[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * SIGSTOP the app's main process and every descendant except `ssh`: the
 * network side of a sleep is the test's to cut (`killAppSsh`), as the
 * kernel's sockets outlive a frozen process. Returns the pids it stopped,
 * for `thawApp`. Call `thawApp` in a `finally`, or a failed test leaves a
 * stopped app behind.
 */
export function freezeApp(app: ElectronApplication): number[] {
  const main = app.process().pid;
  if (main === undefined) throw new Error("the app has no main pid");
  const stopped: number[] = [];
  const stop = (pid: number) => {
    try {
      process.kill(pid, "SIGSTOP");
      stopped.push(pid);
    } catch {
      // Gone between `ps` and the signal.
    }
  };
  // The main process first, so it starts nothing new while the tree is walked.
  stop(main);
  for (const { pid, comm } of descendants(main)) {
    if (comm === "ssh") continue;
    stop(pid);
  }
  return stopped;
}

/** SIGCONT the pids `freezeApp` stopped, children before their parents. */
export function thawApp(pids: readonly number[]): void {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // Already gone.
    }
  }
}
