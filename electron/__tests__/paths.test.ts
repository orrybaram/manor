import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import * as paths from "../paths";

describe("electron/paths", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let platformSpy: ReturnType<typeof vi.spyOn> | null;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "manor-paths-test-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    platformSpy = null;
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    if (platformSpy) platformSpy.mockRestore();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function mockPlatform(value: NodeJS.Platform): void {
    platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue(value);
  }

  describe("manorDataDir()", () => {
    it("on darwin resolves to ~/Library/Application Support/Manor", () => {
      mockPlatform("darwin");
      expect(paths.manorDataDir()).toBe(
        path.join(tmpHome, "Library", "Application Support", "Manor"),
      );
    });

    it("on linux resolves to ~/.local/share/Manor", () => {
      mockPlatform("linux");
      expect(paths.manorDataDir()).toBe(
        path.join(tmpHome, ".local", "share", "Manor"),
      );
    });

    it("picks up homedir changes between calls (no module-load caching)", () => {
      mockPlatform("darwin");
      const first = paths.manorDataDir();
      const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "manor-other-"));
      try {
        homedirSpy.mockReturnValue(otherHome);
        const second = paths.manorDataDir();
        expect(second).not.toBe(first);
        expect(second).toBe(
          path.join(otherHome, "Library", "Application Support", "Manor"),
        );
      } finally {
        fs.rmSync(otherHome, { recursive: true, force: true });
      }
    });
  });

  describe("manorHomeDir()", () => {
    it("resolves to ~/.manor on darwin", () => {
      mockPlatform("darwin");
      expect(paths.manorHomeDir()).toBe(path.join(tmpHome, ".manor"));
    });

    it("resolves to ~/.manor on linux", () => {
      mockPlatform("linux");
      expect(paths.manorHomeDir()).toBe(path.join(tmpHome, ".manor"));
    });
  });

  describe("data-dir getters (darwin)", () => {
    beforeEach(() => mockPlatform("darwin"));

    const dataRoot = () =>
      path.join(tmpHome, "Library", "Application Support", "Manor");

    it("projectsFile", () => {
      expect(paths.projectsFile()).toBe(path.join(dataRoot(), "projects.json"));
    });

    it("tasksFile", () => {
      expect(paths.tasksFile()).toBe(path.join(dataRoot(), "tasks.json"));
    });

    it("preferencesFile", () => {
      expect(paths.preferencesFile()).toBe(
        path.join(dataRoot(), "preferences.json"),
      );
    });

    it("keybindingsFile", () => {
      expect(paths.keybindingsFile()).toBe(
        path.join(dataRoot(), "keybindings.json"),
      );
    });

    it("windowBoundsFile", () => {
      expect(paths.windowBoundsFile()).toBe(
        path.join(dataRoot(), "window-bounds.json"),
      );
    });

    it("zoomLevelFile", () => {
      expect(paths.zoomLevelFile()).toBe(
        path.join(dataRoot(), "zoom-level.json"),
      );
    });

    it("linearTokenFile", () => {
      expect(paths.linearTokenFile()).toBe(
        path.join(dataRoot(), "linear-token.enc"),
      );
    });

    it("shellSessionsDir", () => {
      expect(paths.shellSessionsDir()).toBe(path.join(dataRoot(), "sessions"));
    });

    it("shellZdotdir", () => {
      expect(paths.shellZdotdir()).toBe(path.join(dataRoot(), "zdotdir"));
    });
  });

  describe("data-dir getters (linux)", () => {
    beforeEach(() => mockPlatform("linux"));

    const dataRoot = () => path.join(tmpHome, ".local", "share", "Manor");

    it("projectsFile", () => {
      expect(paths.projectsFile()).toBe(path.join(dataRoot(), "projects.json"));
    });

    it("tasksFile", () => {
      expect(paths.tasksFile()).toBe(path.join(dataRoot(), "tasks.json"));
    });

    it("preferencesFile", () => {
      expect(paths.preferencesFile()).toBe(
        path.join(dataRoot(), "preferences.json"),
      );
    });

    it("keybindingsFile", () => {
      expect(paths.keybindingsFile()).toBe(
        path.join(dataRoot(), "keybindings.json"),
      );
    });

    it("windowBoundsFile", () => {
      expect(paths.windowBoundsFile()).toBe(
        path.join(dataRoot(), "window-bounds.json"),
      );
    });

    it("zoomLevelFile", () => {
      expect(paths.zoomLevelFile()).toBe(
        path.join(dataRoot(), "zoom-level.json"),
      );
    });

    it("linearTokenFile", () => {
      expect(paths.linearTokenFile()).toBe(
        path.join(dataRoot(), "linear-token.enc"),
      );
    });

    it("shellSessionsDir", () => {
      expect(paths.shellSessionsDir()).toBe(path.join(dataRoot(), "sessions"));
    });

    it("shellZdotdir", () => {
      expect(paths.shellZdotdir()).toBe(path.join(dataRoot(), "zdotdir"));
    });
  });

  describe("home-dir getters", () => {
    // The home-dir root (~/.manor) is platform-agnostic; test once.
    beforeEach(() => mockPlatform("darwin"));

    const homeRoot = () => path.join(tmpHome, ".manor");

    it("daemonDir", () => {
      expect(paths.daemonDir()).toBe(path.join(homeRoot(), "daemon"));
    });

    it("daemonSocketFile", () => {
      expect(paths.daemonSocketFile()).toBe(
        path.join(homeRoot(), "daemon", "terminal-host.sock"),
      );
    });

    it("daemonPidFile", () => {
      expect(paths.daemonPidFile()).toBe(
        path.join(homeRoot(), "daemon", "terminal-host.pid"),
      );
    });

    it("daemonTokenFile", () => {
      expect(paths.daemonTokenFile()).toBe(
        path.join(homeRoot(), "daemon", "terminal-host.token"),
      );
    });

    it("hookPortFile", () => {
      expect(paths.hookPortFile()).toBe(path.join(homeRoot(), "hook-port"));
    });

    it("hooksDir", () => {
      expect(paths.hooksDir()).toBe(path.join(homeRoot(), "hooks"));
    });

    it("hookScriptPath", () => {
      expect(paths.hookScriptPath()).toBe(
        path.join(homeRoot(), "hooks", "notify.sh"),
      );
    });

    it("webviewServerPortFile", () => {
      expect(paths.webviewServerPortFile()).toBe(
        path.join(homeRoot(), "webview-server-port"),
      );
    });

    it("portlessProxyPortFile", () => {
      expect(paths.portlessProxyPortFile()).toBe(
        path.join(homeRoot(), "portless-proxy-port"),
      );
    });

    it("scrollbackSessionsDir", () => {
      expect(paths.scrollbackSessionsDir()).toBe(
        path.join(homeRoot(), "sessions"),
      );
    });

    it("layoutFile", () => {
      expect(paths.layoutFile()).toBe(path.join(homeRoot(), "layout.json"));
    });

    it("worktreesDir", () => {
      expect(paths.worktreesDir()).toBe(path.join(homeRoot(), "worktrees"));
    });

    it("home-dir getters work identically on linux", () => {
      mockPlatform("linux");
      expect(paths.daemonSocketFile()).toBe(
        path.join(homeRoot(), "daemon", "terminal-host.sock"),
      );
      expect(paths.layoutFile()).toBe(path.join(homeRoot(), "layout.json"));
      expect(paths.worktreesDir()).toBe(path.join(homeRoot(), "worktrees"));
    });
  });

  describe("every path is absolute", () => {
    beforeEach(() => mockPlatform("darwin"));

    it("all getters return absolute paths", () => {
      const getters: Array<() => string> = [
        paths.manorDataDir,
        paths.manorHomeDir,
        paths.projectsFile,
        paths.tasksFile,
        paths.preferencesFile,
        paths.keybindingsFile,
        paths.windowBoundsFile,
        paths.zoomLevelFile,
        paths.linearTokenFile,
        paths.shellSessionsDir,
        paths.shellZdotdir,
        paths.daemonDir,
        paths.daemonSocketFile,
        paths.daemonPidFile,
        paths.daemonTokenFile,
        paths.hookPortFile,
        paths.hooksDir,
        paths.hookScriptPath,
        paths.webviewServerPortFile,
        paths.portlessProxyPortFile,
        paths.scrollbackSessionsDir,
        paths.layoutFile,
        paths.worktreesDir,
      ];
      for (const getter of getters) {
        expect(path.isAbsolute(getter())).toBe(true);
      }
    });
  });
});
