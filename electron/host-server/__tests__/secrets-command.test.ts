import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSupervisorEnv } from "../supervisor";
import {
  encryptKeyPlan,
  runSecretsCommand,
  serverKeyStatus,
  type SecretsCommandDeps,
} from "../secrets-command";

/**
 * `manor-host secrets` (ADR-236 D1) against a temp home. The "restart"
 * stands in for a server start: it reads `supervisor.env` and records the
 * backend that start would pick, the way `pickHostSecretBox` does.
 */
describe("runSecretsCommand", () => {
  let home: string;
  let serverDir: string;
  let choiceFile: string;
  let envFile: string;
  let keyFile: string;
  let markerFile: string;
  let restarts: number;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "manor-secrets-"));
    serverDir = path.join(home, ".manor", "remote", "server");
    fs.mkdirSync(serverDir, { recursive: true });
    choiceFile = path.join(serverDir, "secret-backend");
    envFile = path.join(home, ".manor", "remote", "supervisor.env");
    keyFile = path.join(home, ".config", "manor", "secret.key");
    markerFile = path.join(home, ".manor", "remote", "supervisor.json");
    restarts = 0;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function setBackend(backend: string): void {
    fs.writeFileSync(choiceFile, JSON.stringify({ backend }));
  }

  /** A restart that moves to key-file when supervisor.env names a key, as a real start would. */
  function upgradingRestart(): Promise<void> {
    restarts++;
    if (/MANOR_SECRET_KEY(_FILE)?=/.test(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "")) {
      setBackend("key-file");
    }
    return Promise.resolve();
  }

  function makeDeps(over: Partial<SecretsCommandDeps> = {}): SecretsCommandDeps {
    return {
      choiceFile,
      envFile,
      keyFile,
      markerFile,
      restart: upgradingRestart,
      randomBytes: (n) => crypto.randomBytes(n),
      env: {},
      home,
      ...over,
    };
  }

  async function run(argv: string[], deps: SecretsCommandDeps) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    stdout.on("data", (d) => (out += String(d)));
    const code = await runSecretsCommand(argv, { stdout, stderr }, deps);
    return { code, out: out.trim(), json: out ? (JSON.parse(out) as Record<string, unknown>) : null };
  }

  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  it("makes a key outside ~/.manor, names it in supervisor.env, restarts once, and reports key-file", async () => {
    setBackend("plaintext");
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect(json).toEqual({
      secrets: { backend: "key-file", keyFile: "~/.config/manor/secret.key", place: "home" },
    });
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
    expect(mode(keyFile)).toBe(0o600);
    expect(mode(path.dirname(keyFile))).toBe(0o700);
    expect(fs.readFileSync(envFile, "utf8")).toContain(`MANOR_SECRET_KEY_FILE='${keyFile}'`);
    expect(mode(envFile)).toBe(0o600);
    expect(restarts).toBe(1);
  });

  it("works before any server has recorded a backend", async () => {
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect((json?.secrets as { backend: string }).backend).toBe("key-file");
  });

  it.each(["key-file", "systemd-creds"])("is a no-op when already on %s", async (backend) => {
    setBackend(backend);
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect((json?.secrets as { backend: string }).backend).toBe(backend);
    expect(restarts).toBe(0);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("reuses an existing valid key file", async () => {
    setBackend("plaintext");
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    const { code } = await run(["encrypt", "--json"], makeDeps({ randomBytes: () => Buffer.alloc(32, 1) }));
    expect(code).toBe(0);
    expect(fs.readFileSync(keyFile).equals(key)).toBe(true);
    expect(restarts).toBe(1);
  });

  it("refuses an invalid key file and never overwrites it", async () => {
    setBackend("plaintext");
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, "not a key");
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(1);
    expect(String(json?.error)).toContain(keyFile);
    expect(fs.readFileSync(keyFile, "utf8")).toBe("not a key");
    expect(fs.existsSync(envFile)).toBe(false);
    expect(restarts).toBe(0);
  });

  it("refuses an invalid key named in supervisor.env, leaving it be", async () => {
    setBackend("plaintext");
    const elsewhere = path.join(home, "missing.key");
    const text = `MANOR_SECRET_KEY_FILE='${elsewhere}'\n`;
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, text);
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(1);
    expect(String(json?.error)).toContain(envFile);
    expect(fs.readFileSync(envFile, "utf8")).toBe(text);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(restarts).toBe(0);
  });

  it("uses a valid key already named in supervisor.env without making another", async () => {
    setBackend("plaintext");
    const theirs = path.join(home, "theirs.key");
    fs.writeFileSync(theirs, crypto.randomBytes(32));
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, `MANOR_SECRET_KEY_FILE='${theirs}'\n`);
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect(json).toEqual({ secrets: { backend: "key-file", keyFile: "~/theirs.key", place: "home" } });
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(restarts).toBe(1);
  });

  it("replaces a key file kept inside ~/.manor while the keys are still plaintext", async () => {
    setBackend("plaintext");
    const inData = path.join(home, ".manor", "secret.key");
    fs.writeFileSync(inData, crypto.randomBytes(32));
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, `MANOR_SECRET_KEY_FILE='${inData}'\nMANOR_INSTANCE_ID='vm-1'\n`);
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect(json).toEqual({
      secrets: { backend: "key-file", keyFile: "~/.config/manor/secret.key", place: "home" },
    });
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
    expect(parseSupervisorEnv(fs.readFileSync(envFile, "utf8"))).toEqual({
      MANOR_SECRET_KEY_FILE: keyFile,
      MANOR_INSTANCE_ID: "vm-1",
    });
    // Left on disk: never deleted, only no longer named.
    expect(fs.existsSync(inData)).toBe(true);
  });

  it("replaces an inline key in supervisor.env while the keys are still plaintext", async () => {
    setBackend("plaintext");
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, `MANOR_SECRET_KEY='${crypto.randomBytes(32).toString("base64")}'\n`);
    const { code } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(0);
    expect(parseSupervisorEnv(fs.readFileSync(envFile, "utf8"))).toEqual({ MANOR_SECRET_KEY_FILE: keyFile });
  });

  describe("encryptKeyPlan and serverKeyStatus agree with the command", () => {
    it("names Manor's key file when supervisor.env names none", () => {
      expect(encryptKeyPlan(envFile, keyFile, home)).toEqual({ action: "create", keyFile });
      expect(serverKeyStatus({}, { envFile, defaultKeyFile: keyFile, home })).toEqual({
        place: null,
        keyFile: null,
        encryptKeyFile: "~/.config/manor/secret.key",
      });
    });

    it("names Manor's key file when supervisor.env's key is inside ~/.manor", () => {
      const inData = path.join(home, ".manor", "secret.key");
      fs.writeFileSync(inData, crypto.randomBytes(32));
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      fs.writeFileSync(envFile, `MANOR_SECRET_KEY_FILE='${inData}'\n`);
      expect(encryptKeyPlan(envFile, keyFile, home)).toEqual({ action: "replace", keyFile });
      const status = serverKeyStatus({ MANOR_SECRET_KEY_FILE: inData }, { envFile, defaultKeyFile: keyFile, home });
      expect(status).toEqual({
        place: "data-dir",
        keyFile: "~/.manor/secret.key",
        encryptKeyFile: "~/.config/manor/secret.key",
      });
    });

    it("names the user's key file when supervisor.env's key is outside ~/.manor", () => {
      const theirs = path.join(home, "theirs.key");
      fs.writeFileSync(theirs, crypto.randomBytes(32));
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      fs.writeFileSync(envFile, `MANOR_SECRET_KEY_FILE='${theirs}'\n`);
      expect(encryptKeyPlan(envFile, keyFile, home)).toEqual({ action: "reuse", keyFile: theirs });
      expect(serverKeyStatus({}, { envFile, defaultKeyFile: keyFile, home }).encryptKeyFile).toBe("~/theirs.key");
    });
  });

  it("refuses in a container", async () => {
    setBackend("plaintext");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ kind: "container" }));
    const { code, json } = await run(["encrypt", "--json"], makeDeps());
    expect(code).toBe(1);
    expect(String(json?.error)).toMatch(/container/);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(restarts).toBe(0);
  });

  it("errors when the server stays on plaintext, keeping the key and env line for the next try", async () => {
    setBackend("plaintext");
    const deps = makeDeps({
      restart: async () => {
        restarts++;
      },
    });
    const { code, json } = await run(["encrypt", "--json"], deps);
    expect(code).toBe(1);
    expect(String(json?.error)).toMatch(/still plaintext.*host-server\.log/);
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.readFileSync(envFile, "utf8")).toContain("MANOR_SECRET_KEY_FILE=");
    const key = fs.readFileSync(keyFile);

    // The retry reuses both.
    const retry = await run(["encrypt", "--json"], makeDeps());
    expect(retry.code).toBe(0);
    expect(fs.readFileSync(keyFile).equals(key)).toBe(true);
  });

  it("errors when the restart fails, keeping the key", async () => {
    setBackend("plaintext");
    const { code, json } = await run(
      ["encrypt", "--json"],
      makeDeps({
        restart: () => Promise.reject(new Error("did not start listening")),
      }),
    );
    expect(code).toBe(1);
    expect(String(json?.error)).toMatch(/did not restart.*did not start listening/);
    expect(fs.existsSync(keyFile)).toBe(true);
  });

  describe("status", () => {
    it("reports plaintext with no side effects", async () => {
      setBackend("plaintext");
      const { code, json } = await run(["status", "--json"], makeDeps());
      expect(code).toBe(0);
      expect(json).toEqual({ secrets: { backend: "plaintext", keyFile: null, place: null } });
      expect(fs.existsSync(keyFile)).toBe(false);
      expect(fs.existsSync(envFile)).toBe(false);
      expect(restarts).toBe(0);
    });

    it("reports where a key-file key lives", async () => {
      setBackend("key-file");
      const inData = path.join(home, ".manor", "secret.key");
      fs.writeFileSync(inData, crypto.randomBytes(32));
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      fs.writeFileSync(envFile, `MANOR_SECRET_KEY_FILE='${inData}'\n`);
      const { json } = await run(["status", "--json"], makeDeps());
      expect(json).toEqual({
        secrets: { backend: "key-file", keyFile: "~/.manor/secret.key", place: "data-dir" },
      });
    });

    it("reports null before any server has started", async () => {
      const { json } = await run(["status", "--json"], makeDeps());
      expect(json).toEqual({ secrets: { backend: null, keyFile: null, place: null } });
    });
  });

  it("rejects an unknown action", async () => {
    const { code, json } = await run(["frobnicate", "--json"], makeDeps());
    expect(code).toBe(1);
    expect(String(json?.error)).toMatch(/usage/);
  });
});
