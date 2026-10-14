import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecipeCommandError, runRecipeCommand } from "../providers/recipe-runner";
import type { Recipe } from "../providers/recipes";

/** Whether `pid` is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` until it holds, or fail after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(process.platform === "win32")("runRecipeCommand (ADR-229 D2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A recipe whose `up` is `body`, a POSIX sh script. */
  function recipeWith(body: string, extra: Partial<Recipe> = {}): Recipe {
    const file = path.join(dir, "up.sh");
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { schemaVersion: 1, id: path.basename(dir), name: "Dev pod", up: "./up.sh", ...extra };
  }

  const run = (recipe: Recipe, more: Partial<Parameters<typeof runRecipeCommand>[1]> = {}) =>
    runRecipeCommand("up", { recipe, dir, hostId: "host-1", instanceId: "host-1", ...more });

  it("resolves with the one JSON object stdout carries", async () => {
    const recipe = recipeWith(`echo '{"schemaVersion":1,"ok":true}'`);
    await expect(run(recipe)).resolves.toEqual({ schemaVersion: 1, ok: true });
  });

  it("refuses a stray echo on stdout, naming it", async () => {
    const recipe = recipeWith(`echo "creating pod"\necho '{"schemaVersion":1}'`);
    const err = await run(recipe).catch((e) => e);
    expect(err).toBeInstanceOf(RecipeCommandError);
    expect(err.message).toContain('"creating pod"');
    expect(err.message).toMatch(/exactly one JSON object/);
  });

  it("refuses two JSON objects", async () => {
    const recipe = recipeWith(`echo '{"a":1}'\necho '{"b":2}'`);
    await expect(run(recipe)).rejects.toThrow(/exactly one JSON object/);
  });

  it("refuses a JSON value that isn't an object", async () => {
    await expect(run(recipeWith(`echo '[1,2]'`))).rejects.toThrow(/one JSON object/);
  });

  it("streams stderr line by line as progress", async () => {
    const recipe = recipeWith(`echo "pulling image" >&2\necho "  starting  " >&2\necho '{}'`);
    const lines: string[] = [];
    await run(recipe, { onProgress: (line) => lines.push(line) });
    expect(lines).toEqual(["pulling image", "  starting"]);
  });

  it("hands {hostId, resource} over stdin, and the environment the recipe asks for", async () => {
    const recipe = recipeWith(
      `input=$(cat)\nprintf '{"stdin":%s,"ns":"%s","host":"%s","dir":"%s","instance":"%s"}' "$input" "$NAMESPACE" "$MANOR_HOST_ID" "$MANOR_RECIPE_DIR" "$MANOR_INSTANCE_ID"`,
      { env: { NAMESPACE: "manor" } },
    );
    const out = await run(recipe, { resource: { id: "pod-7" }, instanceId: "pod-7" });
    expect(out).toEqual({
      stdin: { hostId: "host-1", resource: { id: "pod-7" } },
      ns: "manor",
      host: "host-1",
      dir,
      instance: "pod-7",
    });
  });

  it("runs in the recipe's directory", async () => {
    const recipe = recipeWith(`printf '{"cwd":"%s"}' "$(pwd -P)"`);
    const out = await run(recipe);
    expect(out.cwd).toBe(fs.realpathSync(dir));
  });

  it("fails a non-zero exit with its code and stderr's tail", async () => {
    const recipe = recipeWith(`echo "quota exceeded" >&2\nexit 3`);
    const err = await run(recipe).catch((e) => e);
    expect(err).toBeInstanceOf(RecipeCommandError);
    expect(err.command).toBe("up");
    expect(err.code).toBe(3);
    expect(err.stderrTail).toContain("quota exceeded");
    expect(err.message).toMatch(/Dev pod's `up` failed \(exit 3\)/);
    expect(err.message).toContain("quota exceeded");
  });

  it("keeps only the last 2 KB of stderr", async () => {
    const recipe = recipeWith(`i=0; while [ $i -lt 400 ]; do echo "line $i of noise" >&2; i=$((i+1)); done; echo END >&2; exit 1`);
    const err = await run(recipe).catch((e) => e);
    expect(err.stderrTail.length).toBeLessThanOrEqual(2048);
    expect(err.stderrTail).toContain("END");
  });

  it("refuses more than 64 KB on stdout", async () => {
    const recipe = recipeWith(`head -c 70000 /dev/zero | tr '\\0' 'x'`);
    await expect(run(recipe)).rejects.toThrow(/more than 64 KB/);
  });

  it("kills the command's whole process group when it times out", async () => {
    const pidFile = path.join(dir, "child.pid");
    // A child of its own, in the background, that would outlive a kill of the script alone.
    const recipe = recipeWith(`sleep 30 &\necho $! > "${pidFile}"\nwait`);
    const err = await run(recipe, { timeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(RecipeCommandError);
    expect(err.message).toMatch(/timed out/);
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !alive(pid));
  });

  it("refuses a command the recipe doesn't declare", async () => {
    const recipe = recipeWith(`echo '{}'`);
    await expect(
      runRecipeCommand("stop", { recipe, dir, hostId: "host-1", instanceId: "host-1" }),
    ).rejects.toThrow(/has no `stop` command/);
  });

  it("says when the command can't start", async () => {
    const recipe: Recipe = { schemaVersion: 1, id: "x", name: "Dev pod", up: "./missing.sh" };
    await expect(run(recipe)).rejects.toThrow(/could not start/);
  });
});
