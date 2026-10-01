import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { localExec, type Exec, type ExecError } from "./exec";
import { execFacts, localFacts, memoRetry, posixJoin } from "./machine-facts";
import { worktreesDir } from "../paths";

type Call = { cmd: string; args: string[] };
type Answer = string | ExecError;

function execError(fields: Partial<ExecError>): ExecError {
  return Object.assign(new Error("Command failed"), {
    stdout: "",
    stderr: "",
    code: 1,
    ...fields,
  }) as ExecError;
}

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
    async writeFile() {
      throw new Error("not used");
    },
  };
  return { exec, calls };
}

describe("memoRetry", () => {
  it("caches a success and retries after a failure", async () => {
    let n = 0;
    const get = memoRetry(async () => {
      n++;
      if (n === 1) throw new Error("first fails");
      return n;
    });
    await expect(get()).rejects.toThrow("first fails");
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
    expect(n).toBe(2);
  });
});

describe("posixJoin", () => {
  it("joins with / and keeps an absolute root", () => {
    expect(posixJoin("/home/me/", "/.manor/", "worktrees")).toBe("/home/me/.manor/worktrees");
    expect(posixJoin("/", "srv")).toBe("/srv");
    expect(posixJoin("rel", "a")).toBe("rel/a");
  });
});

describe("execFacts", () => {
  describe("homeDir", () => {
    it("resolves and caches a valid absolute home directory", async () => {
      const { exec, calls } = fakeExec(() => "/home/orry");
      const facts = execFacts(exec);
      expect(await facts.homeDir()).toBe("/home/orry");
      expect(await facts.homeDir()).toBe("/home/orry");
      expect(calls).toEqual([{ cmd: "sh", args: ["-c", 'printf %s "$HOME"'] }]);
    });

    it("rejects an empty $HOME and does not cache the failure", async () => {
      const { exec, calls } = fakeExec(() => "");
      const facts = execFacts(exec);
      await expect(facts.homeDir()).rejects.toThrow(/absolute path/);
      // A retry re-runs the command instead of replaying a cached rejection.
      await expect(facts.homeDir()).rejects.toThrow(/absolute path/);
      expect(calls).toHaveLength(2);
    });

    it('rejects a $HOME of exactly "/" and does not cache the failure', async () => {
      const { exec, calls } = fakeExec(() => "/");
      const facts = execFacts(exec);
      await expect(facts.homeDir()).rejects.toThrow(/absolute path/);
      await expect(facts.homeDir()).rejects.toThrow(/absolute path/);
      expect(calls).toHaveLength(2);
    });

    it("rejects a relative $HOME", async () => {
      const { exec } = fakeExec(() => "relative/path");
      await expect(execFacts(exec).homeDir()).rejects.toThrow(/absolute path/);
    });
  });

  describe("platform", () => {
    it("asks uname once and caches the answer", async () => {
      const { exec, calls } = fakeExec(() => "Linux\n");
      const facts = execFacts(exec);
      expect(await facts.platform()).toBe("linux");
      expect(await facts.platform()).toBe("linux");
      expect(calls).toEqual([{ cmd: "uname", args: ["-s"] }]);
    });

    it("asks again after a failure", async () => {
      let fail = true;
      const { exec, calls } = fakeExec(() => (fail ? execError({ code: null }) : "Darwin\n"));
      const facts = execFacts(exec);
      await expect(facts.platform()).rejects.toThrow();
      fail = false;
      expect(await facts.platform()).toBe("darwin");
      expect(calls).toHaveLength(2);
    });
  });

  describe("uid", () => {
    it("parses `id -u` and caches it", async () => {
      const { exec, calls } = fakeExec(() => "1000\n");
      const facts = execFacts(exec);
      expect(await facts.uid()).toBe(1000);
      expect(await facts.uid()).toBe(1000);
      expect(calls).toHaveLength(1);
    });

    it("never falls back to 0 on garbage, and asks again", async () => {
      const { exec, calls } = fakeExec(() => "nope");
      const facts = execFacts(exec);
      await expect(facts.uid()).rejects.toThrow(/unparseable uid/);
      await expect(facts.uid()).rejects.toThrow(/unparseable uid/);
      expect(calls).toHaveLength(2);
    });
  });

  it("kills a pid on the host, by signal name", async () => {
    const { exec, calls } = fakeExec(() => "");
    await execFacts(exec).kill(42, "SIGTERM");
    expect(calls).toEqual([{ cmd: "kill", args: ["-TERM", "42"] }]);
  });

  it("checks existence with test -e, false on any failure", async () => {
    const { exec, calls } = fakeExec((_cmd, args) =>
      args[1] === "/yes" ? "" : execError({ code: 1 }),
    );
    const facts = execFacts(exec);
    expect(await facts.exists("/yes")).toBe(true);
    expect(await facts.exists("/no")).toBe(false);
    expect(calls[0]).toEqual({ cmd: "test", args: ["-e", "/yes"] });
  });

  it("reads a file with cat", async () => {
    const { exec, calls } = fakeExec(() => "{}\n");
    expect(await execFacts(exec).readFile("/p/package.json")).toBe("{}\n");
    expect(calls).toEqual([{ cmd: "cat", args: ["/p/package.json"] }]);
  });

  it("reads every link in one command, skipping unreadable ones", async () => {
    const { exec, calls } = fakeExec(() => "/proc/1/cwd\t/home/me/a b\n/proc/9/cwd\t/x\nnoise\n");
    const links = await execFacts(exec).readlinks(["/proc/1/cwd", "/proc/2/cwd", "/proc/1/cwd"]);
    expect(links).toEqual(new Map([["/proc/1/cwd", "/home/me/a b"]]));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("sh");
    expect(calls[0].args.slice(2)).toEqual(["sh", "/proc/1/cwd", "/proc/2/cwd"]);
  });

  it("runs no command for no links, and reads none when the command fails", async () => {
    const { exec, calls } = fakeExec(() => execError({ code: 1 }));
    const facts = execFacts(exec);
    expect(await facts.readlinks([])).toEqual(new Map());
    expect(calls).toHaveLength(0);
    expect(await facts.readlinks(["/a"])).toEqual(new Map());
  });

  it("reads real links through a real shell", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlinks-"));
    try {
      await fs.symlink("/some where/else", path.join(dir, "link"));
      await fs.writeFile(path.join(dir, "file"), "");
      const asked = ["link", "file", "missing"].map((n) => path.join(dir, n));
      expect(await execFacts(localExec).readlinks(asked)).toEqual(
        new Map([[asked[0], "/some where/else"]]),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("puts default worktrees under the host's ~/.manor", async () => {
    const { exec } = fakeExec(() => "/home/me");
    const facts = execFacts(exec);
    expect(await facts.defaultWorktreeRoot("My App")).toMatch(/^\/home\/me\/\.manor\/worktrees\//);
    expect(facts.join("/a", "b")).toBe("/a/b");
  });
});

describe("localFacts", () => {
  const facts = localFacts();

  it("answers about this machine", async () => {
    expect(await facts.platform()).toBe(process.platform);
    expect(await facts.homeDir()).toBe(os.homedir());
    expect(await facts.exists(os.homedir())).toBe(true);
    expect(await facts.exists(path.join(os.tmpdir(), "definitely-not-here-xyz"))).toBe(false);
    expect(facts.join("/a", "b")).toBe(path.join("/a", "b"));
  });

  it("reads links in-process, skipping unreadable ones", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlinks-"));
    try {
      await fs.symlink("/target", path.join(dir, "link"));
      const asked = [path.join(dir, "link"), path.join(dir, "missing")];
      expect(await facts.readlinks(asked)).toEqual(new Map([[asked[0], "/target"]]));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("puts default worktrees under this machine's worktrees dir", async () => {
    expect(path.dirname(await facts.defaultWorktreeRoot("proj"))).toBe(worktreesDir());
  });
});
