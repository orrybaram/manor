import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { REAL_HOME } from "./setup-isolated-home";
import {
  manorHomeDir,
  manorDataDir,
  daemonPidFile,
  daemonSocketFile,
  scrollbackSessionsDir,
} from "../paths";
import { SESSIONS_DIR, ScrollbackWriter } from "../terminal-host/scrollback";

/**
 * Guard for ADR-169: the suite must never reach the developer's real home.
 * If this fails, `electron/__tests__/setup-isolated-home.ts` is no longer the
 * first entry in `vitest.config.ts` setupFiles, or something restored $HOME.
 */
describe("test home isolation (ADR-169)", () => {
  const isolatedHome = process.env.HOME!;
  const under = (p: string, root: string) =>
    p === root || p.startsWith(root + path.sep);

  it("runs with a throwaway $HOME", () => {
    expect(isolatedHome).not.toBe(REAL_HOME);
    expect(path.basename(isolatedHome)).toMatch(/^manor-vitest-home-/);
    expect(fs.existsSync(isolatedHome)).toBe(true);
  });

  it("points ~/.manor at the throwaway home, not the real one", () => {
    expect(under(manorHomeDir(), isolatedHome)).toBe(true);
    expect(under(manorHomeDir(), REAL_HOME)).toBe(false);
  });

  it("points the app data dir at the throwaway home, not the real one", () => {
    expect(under(manorDataDir(), isolatedHome)).toBe(true);
    expect(under(manorDataDir(), REAL_HOME)).toBe(false);
  });

  it("sees no live daemon files, so nothing can be signalled by accident", () => {
    expect(fs.existsSync(daemonPidFile())).toBe(false);
    expect(fs.existsSync(daemonSocketFile())).toBe(false);
  });

  it("points the default sessions dir at the throwaway home (#310)", () => {
    expect(SESSIONS_DIR).toBe(scrollbackSessionsDir());
    expect(under(SESSIONS_DIR, isolatedHome)).toBe(true);
    expect(under(SESSIONS_DIR, REAL_HOME)).toBe(false);
  });

  it("fails fast when a test writes to the default sessions dir (#310)", () => {
    expect(fs.statSync(SESSIONS_DIR).isFile()).toBe(true);
    const writer = new ScrollbackWriter("s1");
    expect(() =>
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" }),
    ).toThrow(/ENOTDIR|ENOENT|EEXIST/);
  });

  it("fails fast when a test reads the default sessions dir (#310)", () => {
    expect(() => ScrollbackWriter.readMeta("s1")).toThrow(/#310/);
    expect(() => ScrollbackWriter.readScrollback("s1")).toThrow(/#310/);
    expect(() => ScrollbackWriter.isUncleanShutdown("s1")).toThrow(/#310/);
    expect(() => ScrollbackWriter.listPersistedSessions()).toThrow(/#310/);
    expect(() =>
      ScrollbackWriter.readMeta("s1", SESSIONS_DIR + path.sep),
    ).toThrow(/#310/);
  });
});
