import os from "node:os";
import type { ActivePort, PortsBackend } from "./types";
import { localExec, type Exec, type ExecError } from "./exec";

/**
 * The OS family of a scanned machine, as far as picking a scanner goes:
 * macOS scans with `/usr/sbin/lsof`; Linux with `ss` + `/proc` (ADR-178 §5),
 * falling back to `lsof` on PATH; anything else with `lsof` on PATH.
 */
export type PortsPlatform = "darwin" | "linux" | "other";

/** Map `uname -s` (or `process.platform`) to a `PortsPlatform`. */
export function parsePlatform(name: string): PortsPlatform {
  const lower = name.trim().toLowerCase();
  if (lower === "darwin") return "darwin";
  if (lower === "linux") return "linux";
  return "other";
}

/**
 * Facts about the machine being scanned that are not commands. Split out so
 * a remote host answers them about *its* machine: the uid whose listeners
 * count, the home directory never attributed to a workspace, and how to
 * signal a pid (a pid from a remote scan must never be killed locally), and
 * which OS it runs (which picks the scanner).
 */
export interface PortsHost {
  platform(): Promise<PortsPlatform>;
  uid(): Promise<number>;
  homeDir(): Promise<string>;
  kill(pid: number): Promise<void>;
}

const localPortsHost: PortsHost = {
  async platform() {
    return parsePlatform(process.platform);
  },
  async uid() {
    return process.getuid?.() ?? 0;
  },
  async homeDir() {
    return os.homedir();
  },
  async kill(pid) {
    process.kill(pid, "SIGTERM");
  },
};

/**
 * A `PortsHost` answered through an `Exec` — for a machine this process is
 * not running on. `platform`, `uid` and `homeDir` are asked once and
 * cached (a failed answer is asked again next scan).
 */
export function execPortsHost(execImpl: Exec): PortsHost {
  let platform: Promise<PortsPlatform> | null = null;
  let uid: Promise<number> | null = null;
  let home: Promise<string> | null = null;
  return {
    platform() {
      platform ??= execImpl.file("uname", ["-s"], { timeout: 5000 }).then(
        ({ stdout }) => parsePlatform(stdout),
        (err: unknown) => {
          platform = null; // retry next scan
          throw err;
        },
      );
      return platform;
    },
    uid() {
      uid ??= execImpl.file("id", ["-u"], { timeout: 5000 }).then(
        ({ stdout }) => {
          // Never fall back to 0: that would scan root's listeners.
          const text = stdout.trim();
          const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
          if (!Number.isSafeInteger(parsed)) {
            uid = null; // retry next scan
            throw new Error(`\`id -u\` printed an unparseable uid: ${JSON.stringify(text)}`);
          }
          return parsed;
        },
        (err: unknown) => {
          uid = null; // retry next scan
          throw err;
        },
      );
      return uid;
    },
    homeDir() {
      home ??= execImpl
        .file("printenv", ["HOME"], { timeout: 5000 })
        .then(
          ({ stdout }) => stdout.trim(),
          (err: unknown) => {
            home = null;
            throw err;
          },
        );
      return home;
    },
    async kill(pid) {
      await execImpl.file("kill", ["-TERM", String(pid)], { timeout: 5000 });
    },
  };
}

/** macOS ships lsof here; the path is fixed so a PATH shim cannot stand in. */
const DARWIN_LSOF = "/usr/sbin/lsof";
/** Anywhere else lsof lives wherever the distro put it. */
const PATH_LSOF = "lsof";

/** One listener as `ss -ltnp` reports it, before workspace matching. */
export function parseSsListeners(output: string): ActivePort[] {
  const results: ActivePort[] = [];
  const seenPorts = new Set<number>();
  const userRe = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const tokens = line.trim().split(/\s+/);
    // The local address is the first `addr:port` token (the peer's port is
    // `*` while listening). Matching by shape rather than column index keeps
    // this indifferent to whether this `ss` prints the State column.
    const local = tokens.find((t) => /:\d+$/.test(t));
    if (!local) continue;
    const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 10);
    if (!Number.isInteger(port) || port <= 0 || seenPorts.has(port)) continue;

    // Without `users:(…)` this socket belongs to a process `ss` may not
    // look into (another user's) — never ours to report.
    userRe.lastIndex = 0;
    const user = userRe.exec(line);
    if (!user) continue;
    const pid = parseInt(user[2], 10);
    if (!pid) continue;

    seenPorts.add(port);
    results.push({
      port,
      processName: user[1].replace(/\\(.)/g, "$1"),
      pid,
      workspacePath: null,
      hostname: null,
    });
  }

  return results;
}

/** Parse `ps -o pid=,uid=` output into uid by pid. */
export function parsePsUids(output: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) result.set(Number(match[1]), Number(match[2]));
  }
  return result;
}

/** A command that is not installed, locally (`ENOENT`) or on a remote host. */
function isMissingCommand(err: unknown): boolean {
  const { code, stderr } = (err ?? {}) as Partial<ExecError>;
  if (code === "ENOENT" || code === 127) return true;
  // The remote daemon reports a spawn failure as a null exit code with
  // the spawn error in stderr (see `remote-exec.ts`).
  return code === null && typeof stderr === "string" && /ENOENT/.test(stderr);
}

/** The stdout a command produced, even when it exited non-zero. */
async function stdoutEvenOnFailure(
  run: Promise<{ stdout: string }>,
): Promise<string> {
  try {
    return (await run).stdout;
  } catch (err) {
    const stdout = (err as Partial<ExecError>)?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

export class LocalPortsBackend implements PortsBackend {
  /**
   * Set once `ss` turns out not to be installed on a Linux host; from then
   * on that host is scanned with `lsof` on PATH. Per backend, i.e. per Exec.
   */
  private ssMissing = false;

  constructor(
    private readonly execImpl: Exec = localExec,
    private readonly host: PortsHost = localPortsHost,
  ) {}

  async scan(workspacePaths: string[]): Promise<ActivePort[]> {
    let uid: number;
    let platform: PortsPlatform;
    try {
      uid = await this.host.uid();
      platform = await this.host.platform();
    } catch {
      return [];
    }

    let results: ActivePort[];
    let cwdsByPid: (pids: number[]) => Promise<Map<number, string>>;
    if (platform === "linux" && !this.ssMissing) {
      const ss = await this.scanSs(uid);
      if (ss === "missing") {
        this.ssMissing = true;
        results = await this.scanLsof(PATH_LSOF, uid);
        cwdsByPid = (pids) => this.cwdsByPid(pids, PATH_LSOF);
      } else {
        results = ss;
        cwdsByPid = (pids) => this.cwdsByProcfs(pids);
      }
    } else {
      const lsof = platform === "darwin" ? DARWIN_LSOF : PATH_LSOF;
      results = await this.scanLsof(lsof, uid);
      cwdsByPid = (pids) => this.cwdsByPid(pids, lsof);
    }

    if (workspacePaths.length > 0 && results.length > 0) {
      const pids = results.map((p) => p.pid);
      const cwds = await cwdsByPid(pids);
      const home = await this.host.homeDir().catch(() => null);

      for (const port of results) {
        const cwd = cwds.get(port.pid);
        if (cwd) {
          const best = workspacePaths
            .filter((ws) => cwd.startsWith(ws))
            .sort((a, b) => b.length - a.length)[0];
          if (best && best !== home) {
            port.workspacePath = best;
          }
        }
      }
    }

    return results
      .filter((p) => p.workspacePath !== null)
      .sort((a, b) => a.port - b.port);
  }

  async kill(pid: number): Promise<void> {
    await this.host.kill(pid);
  }

  /** Listeners owned by `uid`, by lsof (which filters by uid itself). */
  private async scanLsof(lsof: string, uid: number): Promise<ActivePort[]> {
    try {
      const { stdout } = await this.execImpl.file(
        lsof,
        ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", String(uid)],
        { timeout: 5000 },
      );
      return this.parseLsofPorts(stdout);
    } catch {
      return [];
    }
  }

  /**
   * Listeners owned by `uid`, by `ss`. `ss` has no uid filter and, run as
   * root, shows every user's processes, so pids are checked against `uid`.
   * `"missing"` when `ss` is not installed.
   */
  private async scanSs(uid: number): Promise<ActivePort[] | "missing"> {
    let output: string;
    try {
      const { stdout } = await this.execImpl.file("ss", ["-ltnpH"], {
        timeout: 5000,
      });
      output = stdout;
    } catch (err) {
      return isMissingCommand(err) ? "missing" : [];
    }
    const listeners = parseSsListeners(output);
    if (listeners.length === 0) return [];
    const uids = await this.uidsByPid(listeners.map((p) => p.pid));
    return listeners.filter((p) => uids.get(p.pid) === uid);
  }

  /** Each pid's effective uid; a pid that is gone is simply absent. */
  private async uidsByPid(pids: number[]): Promise<Map<number, number>> {
    // `ps` exits non-zero when some pid has exited meanwhile, yet still
    // prints the rest.
    const stdout = await stdoutEvenOnFailure(
      this.execImpl.file("ps", ["-o", "pid=,uid=", "-p", pids.join(",")], {
        timeout: 5000,
      }),
    );
    return parsePsUids(stdout);
  }

  /** Each pid's cwd from `/proc/<pid>/cwd`; unreadable ones are skipped. */
  private async cwdsByProcfs(pids: number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    await Promise.all(
      Array.from(new Set(pids), async (pid) => {
        try {
          const { stdout } = await this.execImpl.file(
            "readlink",
            [`/proc/${pid}/cwd`],
            { timeout: 5000 },
          );
          const cwd = stdout.replace(/\n$/, "");
          if (cwd) result.set(pid, cwd);
        } catch {
          // Exited, or not ours to read.
        }
      }),
    );
    return result;
  }

  private parseLsofPorts(output: string): ActivePort[] {
    const results: ActivePort[] = [];
    const seenPorts = new Set<number>();
    let currentPid = 0;
    let currentCmd = "";

    for (const line of output.split("\n")) {
      if (!line) continue;
      const prefix = line[0];
      const value = line.slice(1);

      switch (prefix) {
        case "p":
          currentPid = parseInt(value, 10) || 0;
          break;
        case "c":
          currentCmd = value;
          break;
        case "n": {
          const colonIdx = value.lastIndexOf(":");
          if (colonIdx >= 0) {
            const port = parseInt(value.slice(colonIdx + 1), 10);
            if (!isNaN(port) && !seenPorts.has(port)) {
              seenPorts.add(port);
              results.push({
                port,
                processName: currentCmd,
                pid: currentPid,
                workspacePath: null,
                hostname: null,
              });
            }
          }
          break;
        }
      }
    }

    return results;
  }

  private async cwdsByPid(
    pids: number[],
    lsof: string = DARWIN_LSOF,
  ): Promise<Map<number, string>> {
    if (pids.length === 0) return new Map();

    const pidList = pids.join(",");
    let output: string;
    try {
      const { stdout } = await this.execImpl.file(
        lsof,
        ["-a", "-p", pidList, "-d", "cwd", "-nP", "-F", "pn"],
        { timeout: 5000 },
      );
      output = stdout;
    } catch {
      return new Map();
    }

    const result = new Map<number, string>();
    let currentPid = 0;

    for (const line of output.split("\n")) {
      if (!line) continue;
      const prefix = line[0];
      const value = line.slice(1);

      if (prefix === "p") {
        currentPid = parseInt(value, 10) || 0;
      } else if (prefix === "n" && currentPid !== 0) {
        result.set(currentPid, value);
      }
    }

    return result;
  }
}
