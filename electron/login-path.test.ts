import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginPathReady,
  readCachedLoginPath,
  resolveLoginPath,
  startLoginPathResolution,
  withCommonPaths,
  type LoginPathDeps,
} from "./login-path";

const SHELL = "/bin/zsh";

function makeDeps(opts: {
  cache?: string;
  exec?: (cb: (err: Error | null, stdout: string) => void) => void;
}) {
  const writeFile = vi.fn();
  const mkdir = vi.fn();
  const deps: LoginPathDeps = {
    readFile: () => {
      if (opts.cache === undefined) throw new Error("ENOENT");
      return opts.cache;
    },
    writeFile,
    mkdir,
    execFile: (_s, _a, _o, cb) => (opts.exec ?? (() => {}))(cb),
    cacheFilePath: () => "/data/login-path.json",
  };
  return { deps, writeFile, mkdir };
}

const cacheJson = (p: string, shell = SHELL) =>
  JSON.stringify({ path: p, shell });

describe("login-path", () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    process.env.SHELL = SHELL;
    process.env.PATH = "/usr/bin:/bin";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.SHELL = originalShell;
    vi.restoreAllMocks();
  });

  it("withCommonPaths prepends only missing entries", () => {
    expect(withCommonPaths("/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
    );
    expect(withCommonPaths("/opt/homebrew/bin:/usr/local/bin")).toBe(
      "/opt/homebrew/bin:/usr/local/bin",
    );
  });

  it("ignores a cache written for another shell", () => {
    const { deps } = makeDeps({ cache: cacheJson("/x", "/bin/fish") });
    expect(readCachedLoginPath(deps)).toBeNull();
  });

  it("applies the cache synchronously and loginPathReady is immediate", async () => {
    const { deps } = makeDeps({ cache: cacheJson("/cached/bin") });
    startLoginPathResolution(deps);
    expect(process.env.PATH).toBe("/cached/bin");
    await expect(loginPathReady()).resolves.toBeUndefined();
  });

  it("falls back to common paths, then applies and caches the resolved PATH", async () => {
    let finish!: (err: Error | null, out: string) => void;
    const { deps, writeFile, mkdir } = makeDeps({
      exec: (cb) => (finish = cb),
    });
    startLoginPathResolution(deps);
    expect(process.env.PATH).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    );

    let settled = false;
    const ready = loginPathReady().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    finish(null, "/real/bin:/usr/bin\n");
    await ready;
    expect(process.env.PATH).toBe("/real/bin:/usr/bin");
    expect(mkdir).toHaveBeenCalledWith("/data");
    expect(JSON.parse(writeFile.mock.calls[0][1])).toMatchObject({
      path: "/real/bin:/usr/bin",
      shell: SHELL,
    });
  });

  it("does not rewrite the cache when the PATH is unchanged", async () => {
    const { deps, writeFile } = makeDeps({
      cache: cacheJson("/same/bin"),
      exec: (cb) => cb(null, "/same/bin\n"),
    });
    startLoginPathResolution(deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("updates PATH and cache when the resolved PATH differs from the cache", async () => {
    const { deps, writeFile } = makeDeps({
      cache: cacheJson("/old/bin"),
      exec: (cb) => cb(null, "/new/bin\n"),
    });
    startLoginPathResolution(deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(process.env.PATH).toBe("/new/bin");
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("keeps the fallback and still settles when resolve fails", async () => {
    const { deps, writeFile } = makeDeps({
      exec: (cb) => cb(new Error("boom"), ""),
    });
    startLoginPathResolution(deps);
    await expect(loginPathReady()).resolves.toBeUndefined();
    expect(process.env.PATH).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("swallows cache write errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps({ exec: (cb) => cb(null, "/real/bin") });
    deps.writeFile = () => {
      throw new Error("EACCES");
    };
    startLoginPathResolution(deps);
    await expect(loginPathReady()).resolves.toBeUndefined();
    expect(process.env.PATH).toBe("/real/bin");
    expect(warn).toHaveBeenCalled();
  });

  it("resolveLoginPath resolves null on empty output", async () => {
    await expect(
      resolveLoginPath(SHELL, (_s, _a, _o, cb) => cb(null, "  \n")),
    ).resolves.toBeNull();
  });
});
