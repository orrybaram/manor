import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DETECT_COMMAND,
  HOST_VERSION_COMMAND,
  NODE_CHECK_COMMAND,
  NODE_SEARCH_COMMAND,
  TOOLCHAIN_CHECK_COMMAND,
  RemoteBootstrapError,
  bakedHostDir,
  bakedProbeCommand,
  buildInstallCommands,
  compareVersions,
  ensureRemoteHost,
  hostTarballPath,
  normalizeVersion,
  parseBakedProbe,
  parseRemotePlatform,
  parseNodeCandidates,
  parseVersion,
  pickNode,
  remoteHostEnsurer,
  renderCliShim,
  renderLauncherShim,
  type BootstrapProgress,
} from "../remote-bootstrap";
import type {
  RemoteExecOptions,
  RemoteExecResult,
} from "../../terminal-host/transport-ssh";
import { remoteShellCommand } from "../../terminal-host/ssh-config";

/** Login shells installed here, to run remote snippets the way sshd would. */
const LOGIN_SHELLS = ["sh", "bash", "zsh", "fish", "tcsh"].filter((sh) => {
  try {
    execFileSync("sh", ["-c", `command -v ${sh}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

const ok = (stdout = ""): RemoteExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr = ""): RemoteExecResult => ({ code, stdout: "", stderr });

interface Call {
  command: string;
  opts?: RemoteExecOptions;
}

/**
 * A fake ssh runner. `responses` maps a recognizable piece of the command to
 * its result; anything unmatched succeeds with no output.
 */
function fakeSsh(responses: Array<[match: string, result: RemoteExecResult]>) {
  const calls: Call[] = [];
  const exec = vi.fn(async (command: string, opts?: RemoteExecOptions) => {
    calls.push({ command, opts });
    for (const [match, result] of responses) {
      if (command.includes(match)) return result;
    }
    return ok();
  });
  return { exec, calls };
}

const HEALTHY: Array<[string, RemoteExecResult]> = [
  [DETECT_COMMAND, ok("Linux x86_64\n")],
  [NODE_CHECK_COMMAND, ok("/usr/local/bin/node\nv20.11.1\n")],
];

const TARBALL = Buffer.from("fake-tarball");
const baseOpts = { loadTarball: () => TARBALL, stagingId: () => "abc123" };

describe("parseRemotePlatform", () => {
  it.each([
    ["Linux x86_64", { os: "linux", arch: "x64" }],
    ["Linux amd64", { os: "linux", arch: "x64" }],
    ["Linux aarch64", { os: "linux", arch: "arm64" }],
    ["Darwin arm64", { os: "darwin", arch: "arm64" }],
    ["Darwin x86_64", { os: "darwin", arch: "x64" }],
  ])("accepts %s", (uname, expected) => {
    expect(parseRemotePlatform("box", uname + "\n")).toEqual(expected);
  });

  it("ignores login banners ahead of the uname line", () => {
    expect(parseRemotePlatform("box", "Welcome!\n\nLinux aarch64\n")).toEqual({
      os: "linux",
      arch: "arm64",
    });
  });

  it.each(["FreeBSD amd64", "Linux armv7l", "MINGW64_NT-10.0 x86_64", ""])(
    "rejects %j",
    (uname) => {
      expect(() => parseRemotePlatform("box", uname)).toThrow(
        /Remote platform not supported on box/,
      );
    },
  );
});

describe("version helpers", () => {
  it("parses node-style versions", () => {
    expect(parseVersion("v20.11.1")).toEqual({ major: 20, minor: 11, patch: 1 });
    expect(parseVersion("18.0.0-nightly")).toEqual({ major: 18, minor: 0, patch: 0 });
    expect(parseVersion("unknown")).toBeNull();
  });

  it("orders versions", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(compareVersions(v("1.2.3"), v("1.10.0"))).toBeLessThan(0);
    expect(compareVersions(v("2.0.0"), v("1.99.99"))).toBeGreaterThan(0);
  });

  it("normalizes", () => {
    expect(normalizeVersion(" v0.13.2\n")).toBe("0.13.2");
  });
});

describe("buildInstallCommands", () => {
  const cmds = buildInstallCommands("0.13.2", "/opt/node/bin/node", "abc123");
  const staging = '"$HOME/.manor/.host-staging-abc123"';

  it("stages into a sibling of the live install", () => {
    expect(cmds.prepare).toContain(`mkdir -p ${staging}`);
    expect(cmds.stream).toContain(`tar -xzf - -C ${staging} --strip-components=1`);
    expect(cmds.cleanup).toBe(`rm -rf ${staging}`);
    for (const cmd of [cmds.prepare, cmds.stream, cmds.install, cmds.cleanup]) {
      expect(cmd).not.toMatch(/mv .*"\$HOME\/\.manor\/host"/);
      expect(cmd).not.toContain("manor-host");
    }
  });

  it("keeps every snippet runnable through the login-shell wrapper", () => {
    for (const cmd of [
      cmds.prepare,
      cmds.stream,
      cmds.install,
      cmds.commit,
      cmds.cleanup,
      DETECT_COMMAND,
      NODE_CHECK_COMMAND,
      NODE_SEARCH_COMMAND,
      TOOLCHAIN_CHECK_COMMAND,
      HOST_VERSION_COMMAND,
    ]) {
      expect(() => remoteShellCommand(cmd)).not.toThrow();
    }
  });

  it("runs npm under a remote timeout when one is available", () => {
    expect(cmds.install).toContain('if command -v timeout >/dev/null 2>&1; then T="timeout 570"; fi');
    expect(cmds.install).toContain('$T "$NPM" install');
  });

  it("installs production deps with the checked node's npm and proves node-pty loads", () => {
    expect(cmds.install).toContain(`cd ${staging}`);
    expect(cmds.install).toContain("/opt/node/bin/npm");
    expect(cmds.install).toContain("install --omit=dev --no-audit --no-fund");
    expect(cmds.install).toContain(`/opt/node/bin/node -e 'require("node-pty")'`);
  });

  it("restores the exec bit on node-pty's prebuilt spawn-helper", () => {
    expect(cmds.install).toContain(
      'for f in node_modules/node-pty/prebuilds/*/spawn-helper; do if [ -f "$f" ]; then chmod 755 "$f"; fi; done',
    );
    expect(cmds.install.indexOf("spawn-helper")).toBeLessThan(
      cmds.install.indexOf('require("node-pty")'),
    );
  });

  it("commits by renaming staging into place and writing a 0755 shim", () => {
    expect(cmds.commit).toContain(`mv ${staging} "$HOME/.manor/host"`);
    expect(cmds.commit).toContain('chmod 0755 "$HOME/.manor/bin/manor-host".tmp.$$');
    expect(cmds.commit).toContain(
      'mv -f "$HOME/.manor/bin/manor-host".tmp.$$ "$HOME/.manor/bin/manor-host"',
    );
  });

  it("also writes the manor CLI shim, 0755, in the same commit", () => {
    expect(cmds.commit).toContain('chmod 0755 "$HOME/.manor/bin/manor".tmp.$$');
    expect(cmds.commit).toContain(
      'mv -f "$HOME/.manor/bin/manor".tmp.$$ "$HOME/.manor/bin/manor"',
    );
    // Written after the host dir lands, and after the manor-host shim.
    expect(cmds.commit.indexOf(`mv ${staging} "$HOME/.manor/host"`)).toBeLessThan(
      cmds.commit.indexOf('"$HOME/.manor/bin/manor".tmp.$$'),
    );
    expect(cmds.commit.indexOf('"$HOME/.manor/bin/manor-host".tmp.$$')).toBeLessThan(
      cmds.commit.indexOf('"$HOME/.manor/bin/manor".tmp.$$'),
    );
  });

  it("rejects staging ids that would need quoting", () => {
    expect(() => buildInstallCommands("1.0.0", "/n", "a b")).toThrow(/Invalid staging id/);
  });

  it("pins the version and node path in the shim", () => {
    const shim = renderLauncherShim("0.13.2", "/opt/node/bin/node");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain("MANOR_VERSION=0.13.2\nexport MANOR_VERSION");
    expect(shim).toContain(
      'exec /opt/node/bin/node "$HOME/.manor/host/terminal-host-index.js" "$@"',
    );
  });

  it("pins the node path in the CLI shim, without a version", () => {
    const shim = renderCliShim("/opt/node/bin/node");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).not.toContain("MANOR_VERSION");
    expect(shim).toContain('exec /opt/node/bin/node "$HOME/.manor/host/manor-cli.js" "$@"');
  });

  // Run the real snippets against a scratch $HOME with sh, so quoting and
  // the rename dance are exercised rather than just pattern-matched.
  it.each(LOGIN_SHELLS)("prepare → stream → commit produces a working layout (login shell %s)", (loginShell) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    try {
      const run = (cmd: string, input?: Buffer) =>
        execFileSync(loginShell, ["-c", remoteShellCommand(cmd)], {
          env: { ...process.env, HOME: home },
          input,
        });

      // A previous install that must be replaced.
      fs.mkdirSync(path.join(home, ".manor", "host"), { recursive: true });
      fs.writeFileSync(path.join(home, ".manor", "host", "old.txt"), "old");

      const src = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-pkg-"));
      fs.mkdirSync(path.join(src, "package"));
      fs.writeFileSync(path.join(src, "package", "terminal-host-index.js"), "// new");
      const tgz = execFileSync("tar", ["-czf", "-", "-C", src, "package"]);
      fs.rmSync(src, { recursive: true, force: true });

      const c = buildInstallCommands("1.2.3", process.execPath, "t1");
      run(c.prepare);
      run(c.stream, tgz);
      run(c.commit);

      const hostDir = path.join(home, ".manor", "host");
      expect(fs.readdirSync(hostDir)).toEqual(["terminal-host-index.js"]);
      expect(fs.existsSync(path.join(home, ".manor", "host.old"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".manor", ".host-staging-t1"))).toBe(false);

      const shimPath = path.join(home, ".manor", "bin", "manor-host");
      expect(fs.statSync(shimPath).mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(shimPath, "utf-8")).toBe(
        renderLauncherShim("1.2.3", process.execPath),
      );

      const cliShimPath = path.join(home, ".manor", "bin", "manor");
      expect(fs.statSync(cliShimPath).mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(cliShimPath, "utf-8")).toBe(renderCliShim(process.execPath));
      // The install lock is released.
      expect(fs.existsSync(path.join(home, ".manor", ".host-install.lock"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("commit refreshes an existing agent hook from the new package, and creates none", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    try {
      const run = (cmd: string, input?: Buffer) =>
        execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home }, input });
      const src = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-pkg-"));
      fs.mkdirSync(path.join(src, "package"));
      fs.writeFileSync(path.join(src, "package", "agent-hook.js"), "// new hook");
      const tgz = execFileSync("tar", ["-czf", "-", "-C", src, "package"]);
      fs.rmSync(src, { recursive: true, force: true });
      const install = (id: string) => {
        const c = buildInstallCommands("1.2.3", process.execPath, id);
        run(c.prepare);
        run(c.stream, tgz);
        run(c.commit);
      };

      // No daemon has bootstrapped this host yet: leave that to it.
      const hookJs = path.join(home, ".manor", "hooks", "notify.js");
      install("t4");
      expect(fs.existsSync(hookJs)).toBe(false);

      // A running daemon wrote the old hook; the update replaces it.
      fs.mkdirSync(path.dirname(hookJs), { recursive: true });
      fs.writeFileSync(hookJs, "// old hook");
      install("t5");
      expect(fs.readFileSync(hookJs, "utf-8")).toBe("// new hook");
      expect(fs.statSync(hookJs).mode & 0o777).toBe(0o755);
      expect(fs.readdirSync(path.dirname(hookJs))).toEqual(["notify.js"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("commit breaks a stale install lock", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    try {
      const run = (cmd: string) =>
        execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home } });
      const lock = path.join(home, ".manor", ".host-install.lock");
      fs.mkdirSync(lock, { recursive: true });
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(lock, old, old);

      const c = buildInstallCommands("1.2.3", process.execPath, "t2");
      run(c.prepare);
      run(c.commit);
      expect(fs.existsSync(path.join(home, ".manor", "host"))).toBe(true);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("commit fails rather than nest staging while another install holds the lock", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    try {
      const lock = path.join(home, ".manor", ".host-install.lock");
      fs.mkdirSync(lock, { recursive: true });
      // Shrink the wait so the test does not sit out the real 45s.
      const c = buildInstallCommands("1.2.3", process.execPath, "t3");
      const commit = c.commit.replace(/-ge \d+/, "-ge 1");
      execFileSync("sh", ["-c", c.prepare], { env: { ...process.env, HOME: home } });
      expect(() =>
        execFileSync("sh", ["-c", commit], {
          env: { ...process.env, HOME: home },
          stdio: "pipe",
        }),
      ).toThrow(/another Manor host install/);
      expect(fs.existsSync(path.join(home, ".manor", "host"))).toBe(false);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("baked host package (ADR-235 D10)", () => {
  const staging = '"$HOME/.manor/.host-staging-abc123"';
  const upload = buildInstallCommands("1.2.3", "/usr/local/bin/node", "abc123");
  const baked = buildInstallCommands("1.2.3", "/usr/local/bin/node", "abc123", "baked");

  it("names the baked dir only for strict versions", () => {
    expect(bakedHostDir("1.2.3")).toBe("/opt/manor/host-1.2.3");
    expect(bakedHostDir("0.14.0-beta.1")).toBe("/opt/manor/host-0.14.0-beta.1");
    for (const bad of [
      "",
      "1.2",
      "v1.2.3",
      "1.2.3 ",
      "1.2.3/../../etc",
      "1.2.3;rm -rf ~",
      "1.2.3'",
      '1.2.3"',
      "1.2.3$(id)",
      "1.2.3\n",
    ]) {
      expect(bakedHostDir(bad)).toBeNull();
      expect(bakedProbeCommand(bad, "/usr/local/bin/node")).toBeNull();
      expect(() => buildInstallCommands(bad, "/usr/local/bin/node", "abc123", "baked")).toThrow(
        /No baked host package/,
      );
    }
  });

  it("probes the dir and loads node-pty from it with the picked node", () => {
    expect(bakedProbeCommand("1.2.3", "/home/me/my node/bin/node")).toBe(
      "test -d /opt/manor/host-1.2.3" +
        " && '/home/me/my node/bin/node' -e 'require(\"/opt/manor/host-1.2.3/node_modules/node-pty\")' >/dev/null 2>&1" +
        " && echo __MANOR_BAKED_OK__",
    );
    expect(() => remoteShellCommand(bakedProbeCommand("1.2.3", "/usr/local/bin/node")!)).not.toThrow();
  });

  it("parses the probe: only exit 0 with the marker line counts", () => {
    expect(parseBakedProbe(ok("__MANOR_BAKED_OK__\n"))).toBe(true);
    expect(parseBakedProbe(ok("Welcome to the box\r\n__MANOR_BAKED_OK__\r\n"))).toBe(true);
    expect(parseBakedProbe(ok(""))).toBe(false);
    expect(parseBakedProbe(ok("motd mentions __MANOR_BAKED_OK__ inline\n"))).toBe(false);
    expect(parseBakedProbe({ code: 1, stdout: "__MANOR_BAKED_OK__\n", stderr: "" })).toBe(false);
    expect(parseBakedProbe(fail(127))).toBe(false);
  });

  it("copies the baked dir into staging instead of piping a tarball and running npm", () => {
    expect(upload.source).toBe("upload");
    expect(baked.source).toBe("baked");
    expect("stream" in baked).toBe(false);
    expect(baked.install).toContain(`cp -a /opt/manor/host-1.2.3/. ${staging}/`);
    expect(baked.install).toContain(`chmod -R u+w ${staging}`);
    expect(baked.install).toContain(`cd ${staging}; /usr/local/bin/node -e 'require("node-pty")'`);
    expect(baked.install).not.toContain("npm");
    expect(baked.install).not.toContain("tar ");
    expect(() => remoteShellCommand(baked.install)).not.toThrow();
  });

  it("shares prepare, commit and cleanup with the upload", () => {
    expect(baked.prepare).toBe(upload.prepare);
    expect(baked.commit).toBe(upload.commit);
    expect(baked.cleanup).toBe(upload.cleanup);
  });

  // The real snippet, pointed at a scratch "baked" dir that is read-only
  // like the image's root-owned one.
  it("prepare → copy → commit produces a working, writable layout", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-baked-"));
    try {
      fs.mkdirSync(path.join(src, "node_modules", "node-pty"), { recursive: true });
      fs.writeFileSync(path.join(src, "node_modules", "node-pty", "index.js"), "module.exports = {};");
      fs.writeFileSync(path.join(src, "terminal-host-index.js"), "// baked");
      execFileSync("chmod", ["-R", "a-w", src]);

      const c = buildInstallCommands("1.2.3", process.execPath, "t4", "baked");
      const install = c.install.replace("/opt/manor/host-1.2.3/.", `${src}/.`);
      expect(install).not.toBe(c.install);
      const run = (cmd: string) =>
        execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home }, stdio: "pipe" });
      run(c.prepare);
      run(install);
      run(c.commit);

      const hostDir = path.join(home, ".manor", "host");
      expect(fs.readdirSync(hostDir).sort()).toEqual(["node_modules", "terminal-host-index.js"]);
      expect(fs.statSync(path.join(hostDir, "terminal-host-index.js")).mode & 0o200).toBe(0o200);
      expect(fs.readFileSync(path.join(home, ".manor", "bin", "manor-host"), "utf-8")).toBe(
        renderLauncherShim("1.2.3", process.execPath),
      );
      // A later update can replace it.
      fs.rmSync(hostDir, { recursive: true });
    } finally {
      execFileSync("chmod", ["-R", "u+w", src]);
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("node discovery", () => {
  it("parses candidate lines and ignores rc noise", () => {
    const out = [
      "Welcome to box!",
      "__MANOR_NODE__ login v22.3.0 /home/me/.nvm/versions/node/v22.3.0/bin/node",
      "__MANOR_NODE__ nvm v22.3.0 /home/me/.nvm/versions/node/v22.3.0/bin/node",
      "__MANOR_NODE__ common  /usr/local/bin/node",
      "__MANOR_NODE__ fnm v20.1.0 /home/me/My Apps/fnm/node",
    ].join("\n");
    const found = parseNodeCandidates(out);
    expect(found.map((c) => [c.source, c.path])).toEqual([
      ["login", "/home/me/.nvm/versions/node/v22.3.0/bin/node"],
      ["common", "/usr/local/bin/node"],
      ["fnm", "/home/me/My Apps/fnm/node"],
    ]);
    expect(found[1].version).toBeNull();
  });

  it("prefers the login shell's node, else the newest new-enough one", () => {
    const c = (source: string, v: string, p: string) =>
      parseNodeCandidates(`__MANOR_NODE__ ${source} ${v} ${p}`)[0];
    expect(
      pickNode([c("nvm", "v24.0.0", "/a"), c("login", "v20.5.0", "/b")])?.path,
    ).toBe("/b");
    expect(
      pickNode([c("login", "v18.0.0", "/a"), c("nvm", "v20.0.0", "/b"), c("nvm", "v9.0.0", "/c"), c("nvm", "v22.1.0", "/d")])
        ?.path,
    ).toBe("/d");
    expect(pickNode([c("nvm", "v18.0.0", "/a")])).toBeNull();
  });

  it.each(LOGIN_SHELLS)("the search snippet runs and finds a node under login shell %s", (loginShell) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-home-"));
    try {
      const bin = path.join(home, ".nvm", "versions", "node", "v99.0.0", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\necho v99.0.0\n", { mode: 0o755 });
      const out = execFileSync(loginShell, ["-c", remoteShellCommand(NODE_SEARCH_COMMAND)], {
        encoding: "utf-8",
        env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
      });
      expect(parseNodeCandidates(out)).toContainEqual(
        expect.objectContaining({ source: "nvm", path: path.join(bin, "node") }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteHost", () => {
  it("returns early when the installed host matches", async () => {
    const { exec, calls } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, ok("0.13.2\n")]]);
    const loadTarball = vi.fn(() => TARBALL);
    const res = await ensureRemoteHost("me@box", "0.13.2", exec, { loadTarball });
    expect(res).toEqual({ installed: false, version: "0.13.2" });
    expect(calls.map((c) => c.command)).toEqual([
      DETECT_COMMAND,
      NODE_CHECK_COMMAND,
      HOST_VERSION_COMMAND,
    ]);
    expect(loadTarball).not.toHaveBeenCalled();
  });

  it("installs when the host is missing, in prepare → stream → install → commit order", async () => {
    const { exec, calls } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, fail(127)]]);
    const progress: BootstrapProgress[] = [];
    const res = await ensureRemoteHost("me@box", "0.13.2", exec, {
      ...baseOpts,
      onProgress: (p) => progress.push(p),
    });
    expect(res).toEqual({ installed: true, version: "0.13.2" });

    const cmds = buildInstallCommands("0.13.2", "/usr/local/bin/node", "abc123");
    expect(calls.map((c) => c.command)).toEqual([
      DETECT_COMMAND,
      NODE_CHECK_COMMAND,
      HOST_VERSION_COMMAND,
      bakedProbeCommand("0.13.2", "/usr/local/bin/node"),
      TOOLCHAIN_CHECK_COMMAND,
      cmds.prepare,
      cmds.stream,
      cmds.install,
      cmds.commit,
    ]);
    expect(calls[6].opts?.stdin).toBe(TARBALL);
    expect(progress.map((p) => p.phase)).toEqual([
      "detect",
      "check-node",
      "check-host",
      "install",
      "install",
      "done",
    ]);
    expect(progress[3].message).toBe("Installing Manor host 0.13.2 on me@box…");
    // Linux has no node-pty prebuild, so the npm path compiles it.
    expect(progress[4].message).toBe("Compiling node-pty on me@box (this can take a few minutes)…");
  });

  it("copies a baked package instead of uploading when the image has one (ADR-235 D10)", async () => {
    const probe = bakedProbeCommand("0.13.2", "/usr/local/bin/node")!;
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, ok("0.13.1\n")],
      [probe, ok("__MANOR_BAKED_OK__\n")],
    ]);
    const loadTarball = vi.fn(() => TARBALL);
    const progress: BootstrapProgress[] = [];
    const res = await ensureRemoteHost("me@box", "v0.13.2", exec, {
      ...baseOpts,
      loadTarball,
      onProgress: (p) => progress.push(p),
    });
    expect(res).toEqual({ installed: true, version: "0.13.2" });

    const cmds = buildInstallCommands("0.13.2", "/usr/local/bin/node", "abc123", "baked");
    expect(calls.map((c) => c.command)).toEqual([
      DETECT_COMMAND,
      NODE_CHECK_COMMAND,
      HOST_VERSION_COMMAND,
      probe,
      cmds.prepare,
      cmds.install,
      cmds.commit,
    ]);
    // No upload, no toolchain check, no npm.
    expect(loadTarball).not.toHaveBeenCalled();
    expect(calls.some((c) => c.opts?.stdin)).toBe(false);
    expect(calls.some((c) => c.command.includes("--omit=dev"))).toBe(false);
    expect(progress.map((p) => p.phase)).toEqual([
      "detect",
      "check-node",
      "check-host",
      "install",
      "done",
    ]);
    expect(progress[3].message).toBe("Installing Manor host 0.13.2 on me@box…");
    expect(progress.some((p) => p.message.includes("Compiling"))).toBe(false);
  });

  it("falls back to the upload when the baked probe fails", async () => {
    const probe = bakedProbeCommand("0.13.2", "/usr/local/bin/node")!;
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      [probe, fail(1)],
    ]);
    await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts);
    const upload = buildInstallCommands("0.13.2", "/usr/local/bin/node", "abc123");
    expect(calls.map((c) => c.command)).toContain(upload.stream);
    expect(calls.map((c) => c.command)).toContain(upload.install);
  });

  it("skips the baked probe for a version that cannot name a baked dir", async () => {
    const { exec, calls } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, fail(127)]]);
    await ensureRemoteHost("me@box", "dev build", exec, baseOpts);
    expect(calls.some((c) => c.command.includes("/opt/manor"))).toBe(false);
    expect(calls.some((c) => c.command.includes("tar -xzf"))).toBe(true);
  });

  it("does not commit when copying the baked package fails, and cleans up staging", async () => {
    const probe = bakedProbeCommand("0.13.2", "/usr/local/bin/node")!;
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      [probe, ok("__MANOR_BAKED_OK__\n")],
      ["cp -a", fail(1, "cp: No space left on device")],
    ]);
    await expect(ensureRemoteHost("me@box", "0.13.2", exec, baseOpts)).rejects.toThrow(
      /during copy.*No space left/,
    );
    const commands = calls.map((c) => c.command);
    expect(commands.some((c) => c.includes('mv -f "$HOME/.manor/bin/manor-host"'))).toBe(false);
    expect(commands[commands.length - 1]).toBe('rm -rf "$HOME/.manor/.host-staging-abc123"');
  });

  it("reinstalls over a mismatched version", async () => {
    const { exec, calls } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, ok("0.13.1\n")]]);
    const res = await ensureRemoteHost("me@box", "v0.13.2", exec, baseOpts);
    expect(res.installed).toBe(true);
    expect(calls[calls.length - 1].command).toContain('mv -f "$HOME/.manor/bin/manor-host"');
  });

  it("does not commit when the transfer fails, and cleans up staging", async () => {
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      ["tar -xzf", fail(2, "tar: unexpected EOF")],
    ]);
    const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteBootstrapError);
    expect(err.code).toBe("install-failed");
    expect(err.message).toMatch(/during transfer.*unexpected EOF/);

    const commands = calls.map((c) => c.command);
    expect(commands.some((c) => c.includes('mv -f "$HOME/.manor/bin/manor-host"'))).toBe(false);
    expect(commands[commands.length - 1]).toBe('rm -rf "$HOME/.manor/.host-staging-abc123"');
  });

  it("does not commit when npm install fails", async () => {
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      ["--omit=dev", fail(1, "gyp ERR! stack Error: not found: make")],
    ]);
    await expect(ensureRemoteHost("me@box", "0.13.2", exec, baseOpts)).rejects.toThrow(
      /during npm install.*not found: make/,
    );
    expect(calls.some((c) => c.command.includes("manor-host\".tmp"))).toBe(false);
  });

  it("does not stream when prepare fails", async () => {
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      ["mkdir -p", fail(1, "No space left on device")],
    ]);
    await expect(ensureRemoteHost("me@box", "0.13.2", exec, baseOpts)).rejects.toThrow(
      /during prepare/,
    );
    expect(calls.some((c) => c.command.includes("tar -xzf"))).toBe(false);
  });

  it("rejects unsupported platforms before touching anything else", async () => {
    const { exec, calls } = fakeSsh([[DETECT_COMMAND, ok("FreeBSD amd64\n")]]);
    const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
    expect(err.code).toBe("unsupported-platform");
    expect(err.message).toContain("Remote platform not supported on me@box");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["detecting the platform", [[DETECT_COMMAND, fail(255, "Connection reset by peer")]]],
    ["checking node", [[DETECT_COMMAND, ok("Linux x86_64\n")], [NODE_CHECK_COMMAND, fail(255)]]],
    [
      "searching for node",
      [
        [DETECT_COMMAND, ok("Linux x86_64\n")],
        [NODE_CHECK_COMMAND, fail(127)],
        [NODE_SEARCH_COMMAND, fail(255, "Broken pipe")],
      ],
    ],
    ["installing", [...HEALTHY, [HOST_VERSION_COMMAND, fail(127)], ["mkdir -p", fail(255)]]],
  ] as Array<[string, Array<[string, RemoteExecResult]>]>)(
    "treats ssh exiting 255 while %s as a lost connection, not a host problem",
    async (_label, responses) => {
      const { exec } = fakeSsh(responses);
      const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RemoteBootstrapError);
      expect(err.message).toMatch(/ssh to me@box failed while bootstrapping \(exit 255/);
    },
  );

  it("names the exec program, not ssh, when the channel is an exec prefix (ADR-229 D3)", async () => {
    const { exec } = fakeSsh([[DETECT_COMMAND, fail(255, "error: unable to upgrade connection")]]);
    const err = await ensureRemoteHost("Dev pod", "0.13.2", exec, { ...baseOpts, via: "kubectl" }).catch(
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(RemoteBootstrapError);
    expect(err.message).toMatch(/^kubectl for Dev pod failed while bootstrapping \(exit 255/);
    expect(err.message).not.toContain("ssh");
  });

  it("names the Node requirement when node is missing", async () => {
    const { exec } = fakeSsh([
      [DETECT_COMMAND, ok("Linux x86_64\n")],
      [NODE_CHECK_COMMAND, fail(1)],
    ]);
    const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
    expect(err.code).toBe("node-missing");
    expect(err.message).toMatch(/Node\.js 20 or newer is required on me@box/);
  });

  it("names the Node requirement when node is too old everywhere", async () => {
    const { exec, calls } = fakeSsh([
      [DETECT_COMMAND, ok("Darwin arm64\n")],
      [NODE_CHECK_COMMAND, ok("/usr/bin/node\nv18.19.0\n")],
      [NODE_SEARCH_COMMAND, ok("__MANOR_NODE__ nvm v16.0.0 /home/me/.nvm/versions/node/v16.0.0/bin/node\n")],
    ]);
    const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
    expect(err.code).toBe("node-too-old");
    expect(err.message).toMatch(/Node\.js 20 or newer is required on me@box; found 18\.19\.0/);
    expect(calls.map((c) => c.command)).toEqual([
      DETECT_COMMAND,
      NODE_CHECK_COMMAND,
      NODE_SEARCH_COMMAND,
    ]);
  });

  it("falls back to the login shell / version managers when node is not on the ssh PATH", async () => {
    const nvmNode = "/home/me/.nvm/versions/node/v22.1.0/bin/node";
    const { exec, calls } = fakeSsh([
      [DETECT_COMMAND, ok("Linux x86_64\n")],
      [NODE_CHECK_COMMAND, fail(127)],
      [NODE_SEARCH_COMMAND, ok(`rc noise\n__MANOR_NODE__ login v22.1.0 ${nvmNode}\n`)],
      [HOST_VERSION_COMMAND, fail(127)],
    ]);
    await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts);
    const commit = calls.find((c) => c.command.includes("mv -f"))!.command;
    // The shim pins the node that was found.
    expect(commit).toContain(`exec ${nvmNode}`);
  });

  it("fails with toolchain-missing before touching anything when node-pty cannot build", async () => {
    const { exec, calls } = fakeSsh([
      ...HEALTHY,
      [HOST_VERSION_COMMAND, fail(127)],
      [TOOLCHAIN_CHECK_COMMAND, ok("__MANOR_MISSING__ make\n__MANOR_MISSING__ c++\n")],
    ]);
    const err = await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteBootstrapError);
    expect(err.code).toBe("toolchain-missing");
    expect(err.message).toContain("make, c++ are missing");
    expect(calls.some((c) => c.command.includes("mkdir -p"))).toBe(false);
  });

  it("skips the toolchain check where node-pty ships a prebuild", async () => {
    const { exec, calls } = fakeSsh([
      [DETECT_COMMAND, ok("Darwin arm64\n")],
      [NODE_CHECK_COMMAND, ok("/opt/homebrew/bin/node\nv22.0.0\n")],
      [HOST_VERSION_COMMAND, fail(127)],
    ]);
    await ensureRemoteHost("me@box", "0.13.2", exec, baseOpts);
    expect(calls.some((c) => c.command === TOOLCHAIN_CHECK_COMMAND)).toBe(false);
  });

  it("reports a missing tarball clearly", async () => {
    const { exec } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, fail(127)]]);
    const err = await ensureRemoteHost("me@box", "0.0.0-nope", exec).catch((e) => e);
    expect(err.code).toBe("tarball-missing");
    expect(err.message).toContain("build-host-tarball");
  });

  it("the SshTransport adapter skips without a version and runs otherwise", async () => {
    const { exec, calls } = fakeSsh([...HEALTHY, [HOST_VERSION_COMMAND, ok("1.0.0")]]);
    const ensure = remoteHostEnsurer(baseOpts);
    await ensure("me@box", undefined, exec);
    expect(calls).toHaveLength(0);
    await ensure("me@box", "1.0.0", exec);
    expect(calls).toHaveLength(3);
  });

  it("locates the tarball by version", () => {
    expect(hostTarballPath("1.2.3", "/app/dist-electron")).toBe(
      "/app/dist-electron/manor-host-1.2.3.tgz",
    );
  });
});
