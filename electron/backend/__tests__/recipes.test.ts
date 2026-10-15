import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseRecipe,
  parseStatusResult,
  parseUpResult,
  readRecipe,
  readRecipeHostState,
  resolveRecipeCommand,
  writeRecipe,
  writeRecipeHostState,
} from "../providers/recipes";

const DIR = "/home/me/.manor/host-recipes/k8s-dev";
const RECIPE = { schemaVersion: 1, id: "k8s-dev", name: "Dev pod", up: "./up.sh" };
const SSH_UP = {
  schemaVersion: 1,
  resource: { id: "vm-1" },
  connection: {
    type: "ssh",
    target: { host: "203.0.113.7", port: 22, username: "dev" },
  },
};

describe("recipe.json (ADR-229 D2)", () => {
  it("reads the full schema", () => {
    expect(
      parseRecipe(
        {
          ...RECIPE,
          template: "kubernetes",
          status: "./status.sh",
          stop: "./stop.sh",
          destroy: "/usr/local/bin/destroy-pod",
          idleStopMinutes: 30,
          env: { NAMESPACE: "manor" },
        },
        DIR,
      ),
    ).toEqual({
      ...RECIPE,
      template: "kubernetes",
      status: "./status.sh",
      stop: "./stop.sh",
      destroy: "/usr/local/bin/destroy-pod",
      idleStopMinutes: 30,
      env: { NAMESPACE: "manor" },
    });
  });

  it("refuses an unknown key", () => {
    expect(() => parseRecipe({ ...RECIPE, suspend: "./suspend.sh" }, DIR)).toThrow(/unknown key: suspend/);
  });

  it("refuses a wrong schemaVersion", () => {
    expect(() => parseRecipe({ ...RECIPE, schemaVersion: 2 }, DIR)).toThrow(/schemaVersion must be 1/);
  });

  it("requires up and name", () => {
    expect(() => parseRecipe({ ...RECIPE, up: undefined }, DIR)).toThrow(/up is required/);
    expect(() => parseRecipe({ ...RECIPE, name: undefined }, DIR)).toThrow(/name is required/);
  });

  it("refuses an id that isn't its directory", () => {
    expect(() => parseRecipe({ ...RECIPE, id: "other" }, DIR)).toThrow(/doesn't match its directory/);
  });

  it("refuses a command outside the recipe's directory, but takes an absolute one", () => {
    expect(() => parseRecipe({ ...RECIPE, up: "../../evil.sh" }, DIR)).toThrow(/inside the recipe's directory/);
    expect(resolveRecipeCommand(DIR, "/opt/bin/up")).toBe("/opt/bin/up");
    expect(resolveRecipeCommand(DIR, "./scripts/up.sh")).toBe(`${DIR}/scripts/up.sh`);
  });

  it("refuses env that isn't name → string", () => {
    expect(() => parseRecipe({ ...RECIPE, env: { "BAD NAME": "x" } }, DIR)).toThrow(/invalid name/);
    expect(() => parseRecipe({ ...RECIPE, env: { N: 3 } }, DIR)).toThrow(/must be a string/);
  });

  describe("on disk", () => {
    let base: string;
    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "recipes-test-"));
    });
    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("writes and reads back from <base>/<id>/recipe.json", () => {
      writeRecipe({ schemaVersion: 1, id: "k8s-dev", name: "Dev pod", up: "./up.sh" }, base);
      expect(fs.existsSync(path.join(base, "k8s-dev", "recipe.json"))).toBe(true);
      expect(readRecipe("k8s-dev", base).name).toBe("Dev pod");
    });

    it("refuses an id that could leave the recipes directory", () => {
      expect(() => readRecipe("../etc", base)).toThrow(/Invalid recipe id/);
    });

    it("says when there is no such recipe", () => {
      expect(() => readRecipe("nope", base)).toThrow(/No recipe "nope"/);
    });

    it("remembers the host's resource for that host only", () => {
      writeRecipeHostState(base, { hostId: "h1", resource: { id: "vm-1" }, last: "sleeping" });
      expect(readRecipeHostState(base, "h1")).toEqual({ hostId: "h1", resource: { id: "vm-1" }, last: "sleeping" });
      expect(readRecipeHostState(base, "h2")).toBeNull();
    });
  });
});

describe("up's result (ADR-229 D2)", () => {
  it("reads an ssh connection", () => {
    expect(parseUpResult(SSH_UP)).toEqual(SSH_UP);
  });

  it("reads an exec connection and autoSleep", () => {
    const up = { schemaVersion: 1, connection: { type: "exec", argv: ["docker", "exec", "-i", "box"] }, autoSleep: true };
    expect(parseUpResult(up)).toEqual(up);
  });

  it("refuses an unknown key, at any level", () => {
    expect(() => parseUpResult({ ...SSH_UP, extra: 1 })).toThrow(/unknown key: extra/);
    expect(() =>
      parseUpResult({ ...SSH_UP, connection: { ...SSH_UP.connection, label: "x" } }),
    ).toThrow(/unknown key: label/);
    expect(() =>
      parseUpResult({
        ...SSH_UP,
        connection: { type: "ssh", target: { ...SSH_UP.connection.target, password: "hunter2" } },
      }),
    ).toThrow(/unknown key: password/);
  });

  it("refuses jumpHost with proxyCommand", () => {
    expect(() =>
      parseUpResult({
        ...SSH_UP,
        connection: {
          type: "ssh",
          target: { ...SSH_UP.connection.target, jumpHost: "bastion", proxyCommand: "nc %h %p" },
        },
      }),
    ).toThrow(/both jumpHost and proxyCommand/);
  });

  it("refuses an empty argv", () => {
    expect(() => parseUpResult({ schemaVersion: 1, connection: { type: "exec", argv: [] } })).toThrow(
      /non-empty array/,
    );
  });

  it("refuses a wrong schemaVersion", () => {
    expect(() => parseUpResult({ ...SSH_UP, schemaVersion: 2 })).toThrow(/schemaVersion must be 1/);
  });

  it("refuses a host or user ssh could read as an option", () => {
    const target = SSH_UP.connection.target;
    expect(() =>
      parseUpResult({ ...SSH_UP, connection: { type: "ssh", target: { ...target, host: "-oProxyCommand=x" } } }),
    ).toThrow(/host/);
    expect(() =>
      parseUpResult({ ...SSH_UP, connection: { type: "ssh", target: { ...target, username: "a b" } } }),
    ).toThrow(/username/);
  });

  it("takes a host key as <type> <base64>, and nothing else", () => {
    const target = { ...SSH_UP.connection.target, hostKey: "ssh-ed25519 AAAAC3Nza1 root@vm" };
    expect(parseUpResult({ ...SSH_UP, connection: { type: "ssh", target } }).connection).toEqual({
      type: "ssh",
      target: { ...target, hostKey: "ssh-ed25519 AAAAC3Nza1" },
    });
    expect(() =>
      parseUpResult({
        ...SSH_UP,
        connection: { type: "ssh", target: { ...target, hostKey: "ssh-ed25519 AAAA\nevil * ssh-rsa BBBB" } },
      }),
    ).toThrow(/hostKey/);
  });
});

describe("status's result (ADR-229 D2)", () => {
  it("reads each state", () => {
    for (const state of ["up", "sleeping", "missing", "error"]) {
      expect(parseStatusResult({ state })).toEqual({ state });
    }
    expect(parseStatusResult({ state: "error", detail: "quota" })).toEqual({ state: "error", detail: "quota" });
  });

  it("refuses an unknown state or key", () => {
    expect(() => parseStatusResult({ state: "running" })).toThrow(/state must be/);
    expect(() => parseStatusResult({ state: "up", since: 3 })).toThrow(/unknown key: since/);
  });
});
