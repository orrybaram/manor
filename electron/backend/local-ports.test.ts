import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LocalPortsBackend,
  execPortsHost,
  parsePlatform,
  parseStatUids,
  parseSsListeners,
  type PortsHost,
  type PortsPlatform,
} from "./local-ports";
import type { Exec, ExecError } from "./exec";

// Access private methods for unit testing the parsers
function getParseLsofPorts(backend: LocalPortsBackend) {
  return (backend as any).parseLsofPorts.bind(backend) as (
    output: string,
  ) => ReturnType<LocalPortsBackend["scan"]> extends Promise<infer T> ? T : never;
}

function getCwdsByPid(backend: LocalPortsBackend) {
  return (backend as any).cwdsByPid.bind(backend) as (
    pids: number[],
  ) => Promise<Map<number, string>>;
}

describe("LocalPortsBackend", () => {
  let backend: LocalPortsBackend;

  beforeEach(() => {
    backend = new LocalPortsBackend();
  });

  describe("parseLsofPorts", () => {
    const parse = () => getParseLsofPorts(backend);

    it("parses standard lsof -F pcn output", () => {
      const output = [
        "p1234",
        "cnode",
        "n*:3000",
        "",
      ].join("\n");

      const result = parse()(output);
      expect(result).toEqual([
        {
          port: 3000,
          processName: "node",
          pid: 1234,
          workspacePath: null,
          hostname: null,
        },
      ]);
    });

    it("parses multiple processes", () => {
      const output = [
        "p100",
        "cnode",
        "n127.0.0.1:3000",
        "p200",
        "cpython3",
        "n*:8000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(2);
      expect(result[0].port).toBe(3000);
      expect(result[0].processName).toBe("node");
      expect(result[0].pid).toBe(100);
      expect(result[1].port).toBe(8000);
      expect(result[1].processName).toBe("python3");
      expect(result[1].pid).toBe(200);
    });

    it("marks a port lsof shows only at [::1]", () => {
      const output = ["p100", "cnode", "n[::1]:3000", "n[::1]:3000", "n*:4000"].join("\n");
      const result = parse()(output);
      expect(result.map((p) => [p.port, p.loopbackHost])).toEqual([
        [3000, "::1"],
        [4000, undefined],
      ]);
    });

    it("deduplicates ports", () => {
      const output = [
        "p100",
        "cnode",
        "n*:3000",
        "n127.0.0.1:3000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(1);
    });

    it("handles IPv6 addresses", () => {
      const output = [
        "p100",
        "cnode",
        "n[::1]:4000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(1);
      expect(result[0].port).toBe(4000);
    });

    it("returns empty array for empty output", () => {
      expect(parse()("")).toEqual([]);
    });

    it("skips lines without port info", () => {
      const output = [
        "p100",
        "cnode",
        "n*:",
      ].join("\n");

      const result = parse()(output);
      expect(result).toEqual([]);
    });
  });

  describe("cwdsByPid", () => {
    it("returns empty map for empty pid list", async () => {
      const cwds = getCwdsByPid(backend);
      const result = await cwds([]);
      expect(result.size).toBe(0);
    });
  });
});

// ── Platform scanners (ADR-178 §5) ──

type Call = { cmd: string; args: string[] };
type Answer = string | ExecError;

/** An `Exec` answering `file` from `respond`, recording every call. */
function fakeExec(respond: (cmd: string, args: string[]) => Answer): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = {
    async file(cmd, args) {
      calls.push({ cmd, args });
      const answer = respond(cmd, args);
      if (typeof answer === "string") return { stdout: answer, stderr: "" };
      throw answer;
    },
    stream() {
      throw new Error("not used");
    },
    async readFile() {
      throw new Error("not used");
    },
  };
  return { exec, calls };
}

function execError(fields: Partial<ExecError>): ExecError {
  return Object.assign(new Error("Command failed"), {
    stdout: "",
    stderr: "",
    code: 1,
    ...fields,
  }) as ExecError;
}

function fakeHost(platform: PortsPlatform, uid = 1000, home = "/home/me"): PortsHost {
  return {
    platform: async () => platform,
    uid: async () => uid,
    homeDir: async () => home,
    kill: async () => {},
  };
}

/** Real `ss -ltnpH` output: IPv4, IPv6, wildcard, scoped, multi-pid. */
const SS_FIXTURE = [
  'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=1234,fd=19))',
  'LISTEN 0      511             [::]:3000          [::]:*    users:(("node",pid=1234,fd=20))',
  'LISTEN 0      511                *:5173             *:*    users:(("node",pid=2000,fd=24),("node",pid=2001,fd=24))',
  'LISTEN 0      128        127.0.0.1:8000       0.0.0.0:*    users:(("python3",pid=3000,fd=3))',
  'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      128             [::1]:6006          [::]:*    users:(("vite dev",pid=4000,fd=7))',
  'LISTEN 0      128   [fe80::1%eth0]:7000          [::]:*    users:(("sshd",pid=1,fd=3))',
  "",
].join("\n");

describe("parseSsListeners", () => {
  it("parses IPv4, IPv6, wildcard and scoped listeners, one entry per port", () => {
    const ports = parseSsListeners(SS_FIXTURE);
    expect(ports.map((p) => [p.port, p.pid, p.processName])).toEqual([
      [3000, 1234, "node"],
      [5173, 2000, "node"],
      [8000, 3000, "python3"],
      [6006, 4000, "vite dev"],
      [7000, 1, "sshd"],
    ]);
    expect(ports[0]).toEqual({
      port: 3000,
      processName: "node",
      pid: 1234,
      workspacePath: null,
      hostname: null,
    });
  });

  it("marks a port listened on only at [::1], and only such a port", () => {
    const ports = parseSsListeners(SS_FIXTURE);
    expect(ports.find((p) => p.port === 6006)?.loopbackHost).toBe("::1");
    expect(ports.filter((p) => p.loopbackHost).map((p) => p.port)).toEqual([6006]);
    const both = [
      'LISTEN 0 511 [::1]:3000 [::]:* users:(("node",pid=9,fd=19))',
      'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=9,fd=20))',
    ].join("\n");
    expect(parseSsListeners(both)[0].loopbackHost).toBeUndefined();
  });

  it("skips the header line of an ss run without -H", () => {
    const out =
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n" +
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=9,fd=19))\n';
    expect(parseSsListeners(out).map((p) => p.port)).toEqual([3000]);
  });

  it("skips sockets whose process ss could not see (no users field)", () => {
    const ports = parseSsListeners(SS_FIXTURE);
    expect(ports.some((p) => p.port === 53)).toBe(false);
  });

  it("does not depend on the State column", () => {
    const line = '0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=9,fd=19))';
    expect(parseSsListeners(line).map((p) => p.port)).toEqual([3000]);
  });

  it("returns nothing for empty output", () => {
    expect(parseSsListeners("")).toEqual([]);
  });
});

describe("parseStatUids", () => {
  it("maps pid to uid, ignoring noise", () => {
    expect(parseStatUids("/proc/1234 1000\n/proc/2000 0\ngarbage\n")).toEqual(
      new Map([
        [1234, 1000],
        [2000, 0],
      ]),
    );
  });
});

describe("parsePlatform", () => {
  it("maps uname -s and process.platform names", () => {
    expect(parsePlatform("Darwin\n")).toBe("darwin");
    expect(parsePlatform("Linux\n")).toBe("linux");
    expect(parsePlatform("linux")).toBe("linux");
    expect(parsePlatform("FreeBSD")).toBe("other");
  });
});

describe("execPortsHost platform detection", () => {
  it("asks uname once and caches the answer", async () => {
    const { exec, calls } = fakeExec(() => "Linux\n");
    const host = execPortsHost(exec);
    expect(await host.platform()).toBe("linux");
    expect(await host.platform()).toBe("linux");
    expect(calls).toEqual([{ cmd: "uname", args: ["-s"] }]);
  });

  it("asks again after a failure", async () => {
    let fail = true;
    const { exec, calls } = fakeExec(() => (fail ? execError({ code: null }) : "Darwin\n"));
    const host = execPortsHost(exec);
    await expect(host.platform()).rejects.toThrow();
    fail = false;
    expect(await host.platform()).toBe("darwin");
    expect(calls).toHaveLength(2);
  });
});

describe("LocalPortsBackend scanner selection", () => {
  const WS = "/home/me/proj";

  it("scans macOS with /usr/sbin/lsof, exactly as before", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (args.includes("-iTCP")) return "p100\ncnode\nn*:3000\n";
      return "p100\nn/home/me/proj/app\n";
    });
    const backend = new LocalPortsBackend(exec, fakeHost("darwin", 501));
    const ports = await backend.scan([WS]);
    expect(ports).toEqual([
      { port: 3000, processName: "node", pid: 100, workspacePath: WS, hostname: null },
    ]);
    expect(calls).toEqual([
      {
        cmd: "/usr/sbin/lsof",
        args: ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", "501"],
      },
      { cmd: "/usr/sbin/lsof", args: ["-a", "-p", "100", "-d", "cwd", "-nP", "-F", "pn"] },
    ]);
  });

  it("scans Linux with ss (no -H), trusts its users field as non-root, and reads cwds from /proc", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "ss") return SS_FIXTURE;
      if (cmd === "readlink") {
        const pid = args[0].split("/")[2];
        if (pid === "1234") return "/home/me/proj/web\n";
        if (pid === "2000") return "/home/me/proj\n";
        return execError({ code: 1 });
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux", 1000));
    const ports = await backend.scan([WS]);

    expect(ports.map((p) => [p.port, p.pid, p.workspacePath])).toEqual([
      [3000, 1234, WS],
      [5173, 2000, WS],
    ]);
    expect(calls[0]).toEqual({ cmd: "ss", args: ["-ltnp"] });
    // Non-root ss only names our own processes: no uid lookup at all.
    expect(calls.some((c) => c.cmd === "stat" || c.cmd === "ps")).toBe(false);
  });

  it("as root, keeps only root's pids by /proc owner, before collapsing to one per port", async () => {
    const ss = [
      // Another user's listener on 3000 is listed first; ours must still win.
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=3000,fd=3))',
      'LISTEN 0 511    [::]:3000    [::]:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("vite",pid=2000,fd=24))',
      'LISTEN 0 511 127.0.0.1:8000 0.0.0.0:* users:(("py",pid=4000,fd=3))',
    ].join("\n");
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd === "ss") return ss;
      if (cmd === "stat") {
        // 4000 has exited since the scan: stat complains yet prints the rest.
        return execError({
          code: 1,
          stdout: "/proc/3000 1001\n/proc/1234 0\n/proc/2000 0\n",
        });
      }
      if (cmd === "readlink") return "/root/proj\n";
      throw new Error(`unexpected ${cmd}`);
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux", 0, "/root"));
    const ports = await backend.scan(["/root/proj"]);

    expect(ports.map((p) => [p.port, p.pid])).toEqual([
      [3000, 1234],
      [5173, 2000],
    ]);
    expect(calls[1]).toEqual({
      cmd: "stat",
      args: ["-c", "%n %u", "/proc/3000", "/proc/1234", "/proc/2000", "/proc/4000"],
    });
  });

  it("never attributes a port to the home directory", async () => {
    const { exec } = fakeExec((cmd) => {
      if (cmd === "ss") return 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=5,fd=1))';
      return "/home/me\n";
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux", 1000, "/home/me"));
    expect(await backend.scan(["/home/me"])).toEqual([]);
  });

  it("falls back to lsof on PATH when ss is missing, and remembers that", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "ss") return execError({ code: "ENOENT" });
      if (cmd === "lsof" && args.includes("-iTCP")) return "p7\ncnode\nn*:3000\n";
      if (cmd === "lsof") return "p7\nn/home/me/proj\n";
      throw new Error(`unexpected ${cmd}`);
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux", 1000));
    expect((await backend.scan([WS])).map((p) => p.port)).toEqual([3000]);
    expect((await backend.scan([WS])).map((p) => p.port)).toEqual([3000]);
    expect(calls.filter((c) => c.cmd === "ss")).toHaveLength(1);
    expect(calls.find((c) => c.args.includes("-iTCP"))!.args).toContain("1000");
  });

  it("treats a remote spawn failure (null code, ENOENT in stderr) as ss missing", async () => {
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd === "ss") return execError({ code: null, stderr: "spawn ss ENOENT" });
      return "";
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux"));
    await backend.scan([WS]);
    await backend.scan([WS]);
    expect(calls.filter((c) => c.cmd === "ss")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "lsof")).toHaveLength(2);
  });

  it("falls back to lsof when ss is too old for its options", async () => {
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd === "ss") return execError({ code: 255, stderr: "ss: invalid option -- 'H'" });
      return "";
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux"));
    await backend.scan([WS]);
    await backend.scan([WS]);
    expect(calls.filter((c) => c.cmd === "ss")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "lsof")).toHaveLength(2);
  });

  it("warns once per host when neither ss nor lsof is installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exec } = fakeExec(() => execError({ code: "ENOENT" }));
      const backend = new LocalPortsBackend(exec, fakeHost("linux"), "me@box");
      expect(await backend.scan([WS])).toEqual([]);
      expect(await backend.scan([WS])).toEqual([]);
      expect(await backend.scan([WS])).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("me@box");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps using ss after an ordinary ss failure", async () => {
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd === "ss") return execError({ code: 1, stderr: "Cannot open netlink socket" });
      return "";
    });
    const backend = new LocalPortsBackend(exec, fakeHost("linux"));
    expect(await backend.scan([WS])).toEqual([]);
    await backend.scan([WS]);
    expect(calls.map((c) => c.cmd)).toEqual(["ss", "ss"]);
  });

  it("scans other platforms with lsof on PATH", async () => {
    const { exec, calls } = fakeExec(() => "");
    const backend = new LocalPortsBackend(exec, fakeHost("other"));
    await backend.scan([WS]);
    expect(calls[0].cmd).toBe("lsof");
  });

  it("returns nothing when the platform cannot be told", async () => {
    const { exec, calls } = fakeExec(() => "");
    const host = { ...fakeHost("linux"), platform: async () => Promise.reject(new Error("down")) };
    const backend = new LocalPortsBackend(exec, host);
    expect(await backend.scan([WS])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
