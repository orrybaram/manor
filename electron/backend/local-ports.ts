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

/** One listening socket, before listeners are collapsed to one per port. */
interface ListenSocket {
  port: number;
  processName: string;
  pid: number;
  /** The local address as printed, e.g. `127.0.0.1`, `[::1]`, `*`. */
  address: string;
}

/** An IPv6 loopback address as `ss` or `lsof` prints it. */
function isIpv6Loopback(address: string): boolean {
  return address === "[::1]" || address === "::1";
}

/**
 * One `ActivePort` per port, the first socket's pid winning (as lsof lists
 * them). A port every one of whose sockets is bound to `[::1]` only is
 * marked with `loopbackHost: "::1"`: a forward to the box's 127.0.0.1 would
 * not reach it (ADR-178 §5).
 */
function collapseListeners(sockets: ListenSocket[]): ActivePort[] {
  const byPort = new Map<number, { port: ActivePort; v6Only: boolean }>();
  for (const socket of sockets) {
    const v6 = isIpv6Loopback(socket.address);
    const seen = byPort.get(socket.port);
    if (seen) {
      seen.v6Only &&= v6;
      continue;
    }
    byPort.set(socket.port, {
      port: {
        port: socket.port,
        processName: socket.processName,
        pid: socket.pid,
        workspacePath: null,
        hostname: null,
      },
      v6Only: v6,
    });
  }
  return Array.from(byPort.values(), ({ port, v6Only }) => {
    if (v6Only) port.loopbackHost = "::1";
    return port;
  });
}

/**
 * Every listening socket `ss -ltnp` reports with a process, one entry per
 * socket (not yet one per port). The header line, if this `ss` prints one,
 * has no `addr:port` token and is skipped.
 */
function parseSsSockets(output: string): ListenSocket[] {
  const results: ListenSocket[] = [];
  const userRe = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const tokens = line.trim().split(/\s+/);
    // The local address is the first `addr:port` token (the peer's port is
    // `*` while listening). Matching by shape rather than column index keeps
    // this indifferent to whether this `ss` prints the State column.
    const local = tokens.find((t) => /:\d+$/.test(t));
    if (!local) continue;
    const colon = local.lastIndexOf(":");
    const port = parseInt(local.slice(colon + 1), 10);
    if (!Number.isInteger(port) || port <= 0) continue;

    // Without `users:(…)` this socket belongs to a process `ss` may not
    // look into (another user's) — never ours to report.
    userRe.lastIndex = 0;
    const user = userRe.exec(line);
    if (!user) continue;
    const pid = parseInt(user[2], 10);
    if (!pid) continue;

    results.push({
      port,
      processName: user[1].replace(/\\(.)/g, "$1"),
      pid,
      address: local.slice(0, colon),
    });
  }

  return results;
}

/** Listeners as `ss -ltnp` reports them, one per port, before workspace matching. */
export function parseSsListeners(output: string): ActivePort[] {
  return collapseListeners(parseSsSockets(output));
}

/**
 * Parse `stat -c "%n %u" /proc/<pid>…` output into uid by pid. `stat` is
 * used rather than `ps -o uid=`, which BusyBox's `ps` does not support.
 */
export function parseStatUids(output: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*\/proc\/(\d+)\s+(\d+)\s*$/.exec(line);
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

/**
 * An `ss` too old for the options given (e.g. iproute2 before 4.13 has no
 * `-H`) — no better than a missing one.
 */
function isUnusableSs(err: unknown): boolean {
  if (isMissingCommand(err)) return true;
  const { stderr } = (err ?? {}) as Partial<ExecError>;
  return (
    typeof stderr === "string" &&
    /invalid option|unrecognized option|illegal option/i.test(stderr)
  );
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
   * Set once `ss` turns out not to be installed (or too old) on a Linux host; from then
   * on that host is scanned with `lsof` on PATH. Per backend, i.e. per Exec.
   */
  private ssMissing = false;
  /** Set once "no ss, no lsof" has been logged, so it is logged once. */
  private warnedNoScanner = false;

  constructor(
    private readonly execImpl: Exec = localExec,
    private readonly host: PortsHost = localPortsHost,
    /** Names the scanned machine in warnings. */
    private readonly label: string = "this machine",
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
    } catch (err) {
      if (isMissingCommand(err) && !this.warnedNoScanner) {
        this.warnedNoScanner = true;
        console.warn(
          `[ports] neither ss nor lsof is available on ${this.label}; ` +
            "its dev servers will not be detected",
        );
      }
      return [];
    }
  }

  /**
   * Listeners owned by `uid`, by `ss`. `-H` (no header) is not passed:
   * iproute2 before 4.13 rejects it, and the parser skips the header
   * anyway. `"missing"` when `ss` is not installed or too old to run.
   *
   * Run as anyone but root, `ss` only names the processes of its own user
   * (it cannot look into anyone else's `/proc/<pid>/fd`), so every socket
   * with a process is ours. Run as root it names everyone's, so each pid's
   * uid is checked — before collapsing to one pid per port, so another
   * user's socket on the same port cannot hide ours.
   */
  private async scanSs(uid: number): Promise<ActivePort[] | "missing"> {
    let output: string;
    try {
      const { stdout } = await this.execImpl.file("ss", ["-ltnp"], {
        timeout: 5000,
      });
      output = stdout;
    } catch (err) {
      return isUnusableSs(err) ? "missing" : [];
    }
    let sockets = parseSsSockets(output);
    if (sockets.length === 0) return [];
    if (uid === 0) {
      const uids = await this.uidsByPid(sockets.map((s) => s.pid));
      sockets = sockets.filter((s) => uids.get(s.pid) === uid);
    }
    return collapseListeners(sockets);
  }

  /**
   * Each pid's uid, from its `/proc` entry's owner; a pid that is gone is
   * simply absent. `stat` rather than `ps -o uid=`, which BusyBox lacks.
   */
  private async uidsByPid(pids: number[]): Promise<Map<number, number>> {
    // `stat` exits non-zero when some pid has exited meanwhile, yet still
    // prints the rest.
    const stdout = await stdoutEvenOnFailure(
      this.execImpl.file(
        "stat",
        ["-c", "%n %u", ...Array.from(new Set(pids), (pid) => `/proc/${pid}`)],
        { timeout: 5000 },
      ),
    );
    return parseStatUids(stdout);
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
    const sockets: ListenSocket[] = [];
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
            if (!isNaN(port)) {
              sockets.push({
                port,
                processName: currentCmd,
                pid: currentPid,
                address: value.slice(0, colonIdx),
              });
            }
          }
          break;
        }
      }
    }

    return collapseListeners(sockets);
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
