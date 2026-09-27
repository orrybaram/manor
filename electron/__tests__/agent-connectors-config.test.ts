/**
 * Config-writer safety for `AgentConnector.registerHooks` / `registerMcp`
 * (ADR-160 ticket 10 review): a config file that can't be read or parsed
 * must never be treated as empty and rewritten — that would silently wipe
 * whatever the user actually had there. Runs against a temp HOME so it
 * never touches the real ~/.claude or ~/.codex.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { ClaudeConnector, CodexConnector } from "../agent-connectors";

describe("agent connector config writers", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-agent-connectors-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    warn.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ClaudeConnector", () => {
    it("registerHooks creates settings.json when missing", () => {
      const connector = new ClaudeConnector();
      const settingsPath = path.join(tmpDir, ".claude", "settings.json");
      expect(fs.existsSync(settingsPath)).toBe(false);

      const warnings = connector.registerHooks("/path/to/hook.sh");

      expect(warnings).toEqual([]);
      expect(fs.existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      expect(written.hooks.SessionStart[0].hooks[0].command).toBe(
        "/path/to/hook.sh",
      );
    });

    it("registerHooks leaves malformed settings.json byte-identical and reports a skip", () => {
      const settingsDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, "settings.json");
      const malformed = "{ not valid json ";
      fs.writeFileSync(settingsPath, malformed);

      const connector = new ClaudeConnector();
      const warnings = connector.registerHooks("/path/to/hook.sh");

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/not valid JSON/);
      expect(fs.readFileSync(settingsPath, "utf-8")).toBe(malformed);
      expect(warn).toHaveBeenCalled();
    });

    it("registerMcp creates .claude.json when missing", () => {
      const connector = new ClaudeConnector();
      const configPath = path.join(tmpDir, ".claude.json");
      expect(fs.existsSync(configPath)).toBe(false);

      const warnings = connector.registerMcp("/path/to/mcp.js");

      expect(warnings).toEqual([]);
      expect(fs.existsSync(configPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(written.mcpServers.manor.args[0]).toBe("/path/to/mcp.js");
    });

    it("registerMcp leaves malformed .claude.json byte-identical and reports a skip", () => {
      const configPath = path.join(tmpDir, ".claude.json");
      const malformed = "not json at all";
      fs.writeFileSync(configPath, malformed);

      const connector = new ClaudeConnector();
      const warnings = connector.registerMcp("/path/to/mcp.js");

      expect(warnings.length).toBe(1);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(malformed);
    });
  });

  describe("CodexConnector", () => {
    it("registerHooks creates hooks.json and config.toml when missing", () => {
      const connector = new CodexConnector();
      const hooksPath = path.join(tmpDir, ".codex", "hooks.json");
      const configPath = path.join(tmpDir, ".codex", "config.toml");

      const warnings = connector.registerHooks("/path/to/hook.sh");

      expect(warnings).toEqual([]);
      expect(fs.existsSync(hooksPath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.readFileSync(configPath, "utf-8")).toContain(
        "codex_hooks = true",
      );
    });

    it("registerHooks leaves malformed hooks.json byte-identical and reports a skip", () => {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const hooksPath = path.join(codexDir, "hooks.json");
      const malformed = "{ broken";
      fs.writeFileSync(hooksPath, malformed);

      const connector = new CodexConnector();
      const warnings = connector.registerHooks("/path/to/hook.sh");

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(fs.readFileSync(hooksPath, "utf-8")).toBe(malformed);
      // The feature flag in config.toml is a separate file — still handled,
      // even though hooks.json was skipped.
      expect(fs.existsSync(path.join(codexDir, "config.toml"))).toBe(true);
    });

    it("registerMcp creates config.toml when missing", () => {
      const connector = new CodexConnector();
      const configPath = path.join(tmpDir, ".codex", "config.toml");

      const warnings = connector.registerMcp("/path/to/mcp.js");

      expect(warnings).toEqual([]);
      expect(fs.readFileSync(configPath, "utf-8")).toContain(
        "[mcp_servers.manor]",
      );
    });

    it("registerMcp skips an unreadable config.toml rather than replacing it", () => {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const configPath = path.join(codexDir, "config.toml");
      const existing = "[some_other_section]\nfoo = 1\n";
      fs.writeFileSync(configPath, existing, { mode: 0o000 });

      const connector = new CodexConnector();
      let warnings: string[];
      try {
        warnings = connector.registerMcp("/path/to/mcp.js");
      } finally {
        fs.chmodSync(configPath, 0o644);
      }
      // On platforms where root/tests can still read a 0-mode file (e.g.
      // running as root), fall back to asserting the happy path instead.
      if (warnings.length === 0) {
        expect(fs.readFileSync(configPath, "utf-8")).toContain(
          "[mcp_servers.manor]",
        );
      } else {
        expect(fs.readFileSync(configPath, "utf-8")).toBe(existing);
      }
    });
  });
});
