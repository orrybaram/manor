import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecipeHostProvider, recipeInstanceId, stageProgress } from "../providers/recipe-provider";
import { createProvider } from "../providers";
import { classifyHostFailure } from "../remote-backend";
import type { Recipe } from "../providers/recipes";
import type { BridgeChildProcess, EnsureRemoteHost } from "../../terminal-host/bridge-spawner";

const HOST_ID = "11111111-2222-3333-4444-555555555555";
const ALIAS = `manor-${HOST_ID}`;

/** An exec child that prints `stdout` and exits 0. */
class FakeExecChild extends EventEmitter implements BridgeChildProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly argv: string[]) {
    super();
    setImmediate(() => {
      this.stdout.end("hi\n");
      this.stderr.end();
      setImmediate(() => {
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    });
  }
  kill(): boolean {
    return true;
  }
}

describe.skipIf(process.platform === "win32")("RecipeHostProvider", () => {
  let root: string;
  let recipesDir: string;
  let dir: string;
  let knownHostsDir: string;
  let configBaseDir: string;
  let ensureRemoteHost: ReturnType<typeof vi.fn<EnsureRemoteHost>>;
  let execArgv: string[][];

  /** Write `recipe.json`, and each script as `<name>.sh` printing `<name>-result.json`. */
  function writeRecipe(extra: Partial<Recipe> = {}): void {
    const recipe: Recipe = { schemaVersion: 1, id: "k8s-dev", name: "Dev pod", up: "./up.sh", ...extra };
    fs.writeFileSync(path.join(dir, "recipe.json"), JSON.stringify(recipe));
    for (const name of ["up", "status", "stop", "destroy"]) {
      fs.writeFileSync(
        path.join(dir, `${name}.sh`),
        [
          "#!/bin/sh",
          `cat > "$MANOR_RECIPE_DIR/${name}-stdin.json"`,
          `echo "${name} running" >&2`,
          `[ -f "$MANOR_RECIPE_DIR/${name}-result.json" ] && cat "$MANOR_RECIPE_DIR/${name}-result.json" || echo '{}'`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
  }

  function result(name: string, value: unknown): void {
    fs.writeFileSync(path.join(dir, `${name}-result.json`), JSON.stringify(value));
  }

  function stdinOf(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(dir, `${name}-stdin.json`), "utf-8"));
  }

  function sshUp(target: Record<string, unknown> = {}, resource: unknown = { id: "vm-1" }): void {
    result("up", {
      schemaVersion: 1,
      resource,
      connection: { type: "ssh", target: { host: "203.0.113.7", port: 2222, username: "dev", ...target } },
    });
  }

  const makeProvider = () =>
    new RecipeHostProvider(HOST_ID, "k8s-dev", {
      recipesDir,
      knownHostsDir,
      configBaseDir,
      ensureRemoteHost,
      execSpawn: (command, args) => {
        execArgv.push([command, ...args]);
        return new FakeExecChild([command, ...args]);
      },
    });

  /** The managed ssh config the inner transport wrote. */
  function managedConfig(): string {
    const [entry] = fs.readdirSync(configBaseDir).filter((d) => d.startsWith("manor-ssh-"));
    return fs.readFileSync(path.join(configBaseDir, entry, "config"), "utf-8");
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-provider-test-"));
    recipesDir = path.join(root, "host-recipes");
    dir = path.join(recipesDir, "k8s-dev");
    knownHostsDir = path.join(root, "known_hosts.d");
    configBaseDir = path.join(root, "ssh");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(configBaseDir);
    ensureRemoteHost = vi.fn<EnsureRemoteHost>(async () => {});
    execArgv = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is a recipe provider, built from a recipe spec", () => {
    writeRecipe();
    const provider = createProvider({ kind: "recipe", recipeId: "k8s-dev" }, { hostId: HOST_ID });
    expect(provider.kind).toBe("recipe");
    expect(() => createProvider({ kind: "recipe", recipeId: "k8s-dev" })).toThrow(/host id/);
  });

  it("has no transport to reach before up has run", async () => {
    writeRecipe();
    const provider = makeProvider();
    await expect(provider.transport().ensureRunning("1.0.0")).rejects.toThrow(/Dev pod isn't up yet/);
    await expect(provider.openServerChannel()).rejects.toThrow(/isn't up yet/);
  });

  describe("up → ssh", () => {
    it("writes a Host manor-<hostId> stanza with its own known_hosts, taking the first key", async () => {
      writeRecipe();
      sshUp({ identityFile: "~/.ssh/id_ed25519", identitiesOnly: true, jumpHost: "me@bastion:2200" });
      const provider = makeProvider();
      const lines: string[] = [];
      await provider.ensureUp((line) => lines.push(line));
      expect(lines).toContain("up running");
      expect(stdinOf("up")).toEqual({ hostId: HOST_ID, resource: null });

      // The backend's transport, built before up, now reaches the box.
      await provider.transport().ensureRunning("1.0.0");
      expect(ensureRemoteHost).toHaveBeenCalledWith("Dev pod", "1.0.0", expect.any(Function));
      const config = managedConfig();
      const knownHosts = path.join(knownHostsDir, HOST_ID);
      expect(config.indexOf(`Host ${ALIAS}`)).toBeLessThan(config.indexOf("Host *"));
      expect(config).toContain("  HostName 203.0.113.7\n");
      expect(config).toContain("  Port 2222\n");
      expect(config).toContain("  User dev\n");
      expect(config).toContain("  IdentityFile ~/.ssh/id_ed25519\n");
      expect(config).toContain("  IdentitiesOnly yes\n");
      expect(config).toContain("  ProxyJump me@bastion:2200\n");
      expect(config).toContain(`  HostKeyAlias ${ALIAS}\n`);
      expect(config).toContain(`  UserKnownHostsFile ${knownHosts}\n`);
      expect(config).toContain("  StrictHostKeyChecking accept-new\n");
      expect(fs.existsSync(knownHosts)).toBe(false);
    });

    it("trusts the key up returns, alone, and checks strictly", async () => {
      writeRecipe();
      const knownHosts = path.join(knownHostsDir, HOST_ID);
      fs.mkdirSync(knownHostsDir, { recursive: true });
      fs.writeFileSync(knownHosts, `${ALIAS} ssh-ed25519 OLDKEY\n`);
      sshUp({ hostKey: "ssh-ed25519 NEWKEY root@vm" });
      const provider = makeProvider();
      await provider.ensureUp();
      expect(fs.readFileSync(knownHosts, "utf-8")).toBe(`${ALIAS} ssh-ed25519 NEWKEY\n`);
      await provider.transport().ensureRunning("1.0.0");
      expect(managedConfig()).toContain("  StrictHostKeyChecking yes\n");
    });

    it("checks strictly once the file holds a key, even when up returns none", async () => {
      writeRecipe();
      fs.mkdirSync(knownHostsDir, { recursive: true });
      fs.writeFileSync(path.join(knownHostsDir, HOST_ID), `${ALIAS} ssh-ed25519 TAKEN\n`);
      sshUp();
      const provider = makeProvider();
      await provider.ensureUp();
      await provider.transport().ensureRunning("1.0.0");
      expect(managedConfig()).toContain("  StrictHostKeyChecking yes\n");
    });

    it("hands the last resource back on stdin, and its id as MANOR_INSTANCE_ID", async () => {
      writeRecipe({ stop: "./stop.sh" });
      sshUp({}, { id: "vm-9" });
      const provider = makeProvider();
      await provider.ensureUp();
      await provider.stop();
      expect(stdinOf("stop")).toEqual({ hostId: HOST_ID, resource: { id: "vm-9" } });
      expect(recipeInstanceId(HOST_ID, { id: "vm-9" })).toBe("vm-9");
      expect(recipeInstanceId(HOST_ID, "pod-3")).toBe("pod-3");
      expect(recipeInstanceId(HOST_ID, undefined)).toBe(HOST_ID);
    });
  });

  describe("up → exec", () => {
    it("builds a command provider on the argv prefix, named by the recipe", async () => {
      writeRecipe();
      result("up", {
        schemaVersion: 1,
        connection: { type: "exec", argv: ["docker", "exec", "-i", "manor-box"] },
        autoSleep: true,
      });
      const provider = makeProvider();
      await provider.ensureUp();
      expect(provider.capabilities.autoSleep).toBe(true);
      await provider.transport().ensureRunning("1.0.0");
      expect(ensureRemoteHost).toHaveBeenCalledWith("Dev pod", "1.0.0", expect.any(Function));
      const exec = ensureRemoteHost.mock.calls[0][2];
      await exec("echo hi");
      expect(execArgv).toEqual([["docker", "exec", "-i", "manor-box", "sh", "-c", "echo hi"]]);
    });

    it("rebuilds the way in only when up says something different", async () => {
      writeRecipe();
      result("up", { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "a"] } });
      const provider = makeProvider();
      await provider.ensureUp();
      const first = provider.transport();
      await provider.ensureUp();
      result("up", { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "b"] } });
      await provider.ensureUp();
      expect(provider.transport()).toBe(first);
      await provider.transport().ensureRunning("1.0.0");
      await ensureRemoteHost.mock.calls[0][2]("true");
      expect(execArgv[0].slice(0, 4)).toEqual(["docker", "exec", "-i", "b"]);
    });
  });

  describe("running up again", () => {
    /** Make `up.sh` count its runs, and take a moment so runs can overlap. */
    function countUps(): () => number {
      const counter = path.join(dir, "up-count");
      fs.writeFileSync(
        path.join(dir, "up.sh"),
        [
          "#!/bin/sh",
          `echo run >> "$MANOR_RECIPE_DIR/up-count"`,
          "sleep 0.2",
          `cat "$MANOR_RECIPE_DIR/up-result.json"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return () =>
        fs.existsSync(counter) ? fs.readFileSync(counter, "utf-8").trim().split("\n").length : 0;
    }

    const execUp = (autoSleep?: boolean) =>
      result("up", {
        schemaVersion: 1,
        connection: { type: "exec", argv: ["docker", "exec", "-i", "a"] },
        ...(autoSleep !== undefined ? { autoSleep } : {}),
      });

    it("runs up once for concurrent ensureUp calls", async () => {
      writeRecipe();
      execUp();
      const ups = countUps();
      const provider = makeProvider();

      await Promise.all([provider.ensureUp(), provider.ensureUp()]);

      expect(ups()).toBe(1);
      // Once settled, the next call runs up again.
      await provider.ensureUp();
      expect(ups()).toBe(2);
    });

    it("refresh runs up again for a box that does not sleep itself", async () => {
      writeRecipe();
      execUp();
      const ups = countUps();
      const provider = makeProvider();
      await provider.ensureUp();
      const lines: string[] = [];

      await expect(provider.refresh((line) => lines.push(line))).resolves.toBe(true);

      expect(ups()).toBe(2);
    });

    it("refresh declines for an autoSleep box without a status command", async () => {
      writeRecipe();
      execUp(true);
      const ups = countUps();
      const provider = makeProvider();
      await provider.ensureUp();

      await expect(provider.refresh()).resolves.toBe(false);

      expect(ups()).toBe(1);
    });

    it("refresh runs up for an autoSleep box whose status said it is awake", async () => {
      writeRecipe({ status: "./status.sh" });
      execUp(true);
      const ups = countUps();
      const provider = makeProvider();
      await provider.ensureUp();

      await expect(provider.refresh()).resolves.toBe(true);

      expect(ups()).toBe(2);
    });
  });

  it("fails up that prints a bad result as a recipe failure", async () => {
    writeRecipe();
    result("up", { schemaVersion: 1, connection: { type: "exec", argv: [] } });
    const err = await makeProvider().ensureUp().catch((e) => e);
    expect(err.message).toMatch(/non-empty array/);
    expect(classifyHostFailure(err)?.reason).toBe("recipe");
  });

  describe("named stages", () => {
    /** An `up.sh` that prints `lines` on stderr, then `up-result.json`, or exits 1 when `fail`. */
    function writeUp(lines: string[], fail = false): void {
      fs.writeFileSync(
        path.join(dir, "up.sh"),
        [
          "#!/bin/sh",
          "cat >/dev/null",
          ...lines.map((l) => `echo '${l}' >&2`),
          fail ? "exit 1" : `cat "$MANOR_RECIPE_DIR/up-result.json"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    it("shows the latest stage, not the lines after it", async () => {
      writeRecipe();
      result("up", { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "a"] } });
      writeUp(["Checking things", "manor-stage: Getting a disk", "noise", "manor-stage:   Starting  ", "more noise"]);
      const progress: string[] = [];
      await makeProvider().ensureUp((line) => progress.push(line));
      expect(progress).toEqual(["Checking things", "Getting a disk", "Starting"]);
    });

    it("starts each run without a stage", async () => {
      writeRecipe();
      result("up", { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "a"] } });
      const provider = makeProvider();
      writeUp(["manor-stage: Getting a disk", "noise"]);
      await provider.ensureUp(() => {});
      writeUp(["plain line"]);
      const progress: string[] = [];
      await provider.ensureUp((line) => progress.push(line));
      expect(progress).toEqual(["plain line"]);
    });

    it("keeps the stage lines in a failed run's output", async () => {
      writeRecipe();
      writeUp(["manor-stage: Getting a disk", "storageclass not found"], true);
      const err = await makeProvider().ensureUp(() => {}).catch((e) => e);
      expect(err.stderrTail).toBe("manor-stage: Getting a disk\nstorageclass not found\n");
    });

    it("parses stage lines on their own", () => {
      const seen: string[] = [];
      const onLine = stageProgress((l) => seen.push(l))!;
      for (const l of ["a", "  manor-stage: One", "b", "manor-stage:", "manor-stage:    ", "manor-stage: Two"]) onLine(l);
      expect(seen).toEqual(["a", "One", "Two"]);
      expect(stageProgress(undefined)).toBeUndefined();
    });
  });

  it("fails up whose recipe is missing, saying so", async () => {
    const err = await makeProvider().ensureUp().catch((e) => e);
    expect(err.message).toMatch(/No recipe "k8s-dev"/);
    expect(classifyHostFailure(err)?.reason).toBe("recipe");
  });

  describe("status", () => {
    it.each([
      [{ state: "up" }, { state: "up" }],
      [{ state: "sleeping" }, { state: "sleeping" }],
      [{ state: "error", detail: "quota" }, { state: "error", detail: "quota" }],
      [{ state: "missing" }, { state: "error", detail: "Dev pod no longer exists", missing: true }],
    ])("maps %j to %j", async (printed, expected) => {
      writeRecipe({ status: "./status.sh" });
      result("status", printed);
      await expect(makeProvider().status()).resolves.toEqual(expected);
    });

    it("never rejects: a status that fails is an error state", async () => {
      writeRecipe({ status: "./status.sh" });
      result("status", { state: "running" });
      await expect(makeProvider().status()).resolves.toMatchObject({ state: "error" });
    });

    it("without a status command, is how Manor last left the box — across restarts", async () => {
      writeRecipe({ stop: "./stop.sh" });
      result("up", { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "a"] } });
      const provider = makeProvider();
      await expect(provider.status()).resolves.toEqual({ state: "up" });
      await provider.ensureUp();
      await provider.stop();
      await expect(provider.status()).resolves.toEqual({ state: "sleeping" });
      await expect(makeProvider().status()).resolves.toEqual({ state: "sleeping" });
    });
  });

  describe("stop and destroy", () => {
    it("are offered only when the recipe declares them", async () => {
      writeRecipe();
      const provider = makeProvider();
      expect(provider.capabilities).toEqual({ canStop: false, canDestroy: false, autoSleep: false });
      await expect(provider.stop()).rejects.toThrow(/has no `stop` command/);
      await expect(provider.destroy()).rejects.toThrow(/has no `destroy` command/);
    });

    it("run their commands when declared", async () => {
      writeRecipe({ stop: "./stop.sh", destroy: "./destroy.sh" });
      const provider = makeProvider();
      expect(provider.capabilities).toEqual({ canStop: true, canDestroy: true, autoSleep: false });
      await provider.stop();
      expect(stdinOf("stop")).toEqual({ hostId: HOST_ID, resource: null });
      await provider.destroy();
      expect(stdinOf("destroy")).toEqual({ hostId: HOST_ID, resource: null });
      await expect(provider.status()).resolves.toMatchObject({ state: "error", missing: true });
      // The recipe's directory is the caller's to remove.
      expect(fs.existsSync(path.join(dir, "recipe.json"))).toBe(true);
    });
  });

  it("remembers whether the host is busy", () => {
    writeRecipe();
    const provider = makeProvider();
    provider.setBusy(true);
    expect(provider.busy).toBe(true);
  });
});
