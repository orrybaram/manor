/**
 * What `hosts.remove` deletes of a removed host (ADR-229 D8): its cache, a
 * recipe host's `known_hosts`, and its recipe's directory when the box was
 * destroyed, or only the recipe's record of it when it was not.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetHostFiles } from "../host-removal";

describe("forgetHostFiles", () => {
  let root: string;
  let dirs: { cacheDir: string; knownHostsDir: string; recipesDir: string };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-host-removal-"));
    dirs = {
      cacheDir: path.join(root, "host-cache"),
      knownHostsDir: path.join(root, "known_hosts.d"),
      recipesDir: path.join(root, "host-recipes"),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dirs.cacheDir, "box.json"), "{}");
    fs.writeFileSync(path.join(dirs.cacheDir, "other.json"), "{}");
    fs.writeFileSync(path.join(dirs.knownHostsDir, "box"), "manor-box ssh-ed25519 AAAA\n");
    const recipe = path.join(dirs.recipesDir, "dev-pod");
    fs.mkdirSync(recipe);
    fs.writeFileSync(path.join(recipe, "recipe.json"), "{}");
    fs.writeFileSync(path.join(recipe, "host.json"), JSON.stringify({ hostId: "box", last: "up" }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

  it("deletes an ssh host's cache, and nothing else", () => {
    forgetHostFiles("box", { kind: "ssh", target: "me@box" }, { destroyed: false }, dirs);
    expect(exists(dirs.cacheDir, "box.json")).toBe(false);
    expect(exists(dirs.cacheDir, "other.json")).toBe(true);
    // Not a recipe host: its known_hosts entry (were there one) is not Manor's.
    expect(exists(dirs.knownHostsDir, "box")).toBe(true);
    expect(exists(dirs.recipesDir, "dev-pod", "host.json")).toBe(true);
  });

  it("keeps a kept box's recipe, without its record of the host", () => {
    forgetHostFiles("box", { kind: "recipe", recipeId: "dev-pod" }, { destroyed: false }, dirs);
    expect(exists(dirs.cacheDir, "box.json")).toBe(false);
    expect(exists(dirs.knownHostsDir, "box")).toBe(false);
    expect(exists(dirs.recipesDir, "dev-pod", "recipe.json")).toBe(true);
    expect(exists(dirs.recipesDir, "dev-pod", "host.json")).toBe(false);
  });

  it("leaves a record that is another host's", () => {
    forgetHostFiles("other", { kind: "recipe", recipeId: "dev-pod" }, { destroyed: false }, dirs);
    expect(exists(dirs.recipesDir, "dev-pod", "host.json")).toBe(true);
  });

  it("deletes a destroyed box's whole recipe directory", () => {
    forgetHostFiles("box", { kind: "recipe", recipeId: "dev-pod" }, { destroyed: true }, dirs);
    expect(exists(dirs.recipesDir, "dev-pod")).toBe(false);
    expect(exists(dirs.recipesDir)).toBe(true);
  });

  it("never reaches outside the recipes directory", () => {
    forgetHostFiles("box", { kind: "recipe", recipeId: ".." }, { destroyed: true }, dirs);
    expect(exists(dirs.recipesDir)).toBe(true);
  });
});
