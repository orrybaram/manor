/**
 * The opencode plugin Manor generates (`../opencode-plugin.ts`): where it is
 * installed, that installing is idempotent, and what hook events it sends
 * for opencode's events. The generated module is imported and driven with
 * opencode's event shapes, so its text is tested by running it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { OpencodeConnector } from "../agent-connectors";
import { parseAgentHookEvent } from "../agent-hook-events";
import { OPENCODE_PLUGIN_FILE, opencodePluginSource, opencodePluginsDir } from "../opencode-plugin";

type Hooks = {
  event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>;
  "tool.execute.before"?: (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
  "tool.execute.after"?: (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
};
type Plugin = (ctx: unknown) => Promise<Hooks>;

const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_DB",
  "MANOR_PANE_ID",
  "MANOR_HOOK_PORT_FILE",
  "MANOR_HOOK_PORT",
  "MANOR_HOOK_TOKEN",
] as const;

describe("opencode plugin", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-opencode-plugin-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = dir;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("install", () => {
    it("goes in opencode's global plugins directory, honouring XDG_CONFIG_HOME", () => {
      expect(opencodePluginsDir({}, "/h")).toBe("/h/.config/opencode/plugins");
      expect(opencodePluginsDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/opencode/plugins");
    });

    it("writes the plugin, and rewrites it only when its content changed", () => {
      const file = path.join(dir, ".config", "opencode", "plugins", OPENCODE_PLUGIN_FILE);
      const connector = new OpencodeConnector();
      expect(connector.registerHooks("/unused")).toEqual([]);
      expect(fs.readFileSync(file, "utf-8")).toBe(opencodePluginSource());

      const written = fs.statSync(file).mtimeMs;
      fs.utimesSync(file, new Date(0), new Date(0));
      connector.registerHooks("/unused");
      expect(fs.statSync(file).mtimeMs).toBe(0);
      expect(written).not.toBe(0);

      fs.writeFileSync(file, "// an older plugin\n");
      connector.registerHooks("/unused");
      expect(fs.readFileSync(file, "utf-8")).toBe(opencodePluginSource());
      // Nothing else is left beside it.
      expect(fs.readdirSync(path.dirname(file))).toEqual([OPENCODE_PLUGIN_FILE]);
    });

    it("warns rather than throws when it can't be written", () => {
      // A file where the config directory should be.
      fs.writeFileSync(path.join(dir, ".config"), "");
      const warnings = new OpencodeConnector().registerHooks("/unused");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("opencode plugin not installed");
    });
  });

  describe("events", () => {
    let urls: URL[];
    let headers: unknown[];
    let sessions: Record<string, { parentID?: string }>;

    async function load(): Promise<Plugin> {
      // A fresh copy each time: the module reads its environment as it loads.
      const file = path.join(dir, `plugin-${Math.random().toString(36).slice(2)}.mjs`);
      fs.writeFileSync(file, opencodePluginSource());
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      // opencode calls every export as a plugin: there must be only the one.
      expect(Object.keys(mod)).toEqual(["ManorHooks"]);
      return mod.ManorHooks as Plugin;
    }

    async function hooks(): Promise<Hooks> {
      const client = {
        session: {
          get: async ({ path: p }: { path: { id: string } }) => ({ data: sessions[p.id] ?? {} }),
        },
      };
      return (await load())({ client, directory: dir });
    }

    function sent(): Array<Record<string, string>> {
      return urls.map((u) => Object.fromEntries(u.searchParams));
    }

    beforeEach(() => {
      urls = [];
      headers = [];
      sessions = {};
      process.env.MANOR_PANE_ID = "pane-7";
      const portFile = path.join(dir, "hook-port");
      fs.writeFileSync(portFile, "4123\nsecret\n");
      process.env.MANOR_HOOK_PORT_FILE = portFile;
      vi.stubGlobal("fetch", async (url: string, init: { headers?: unknown }) => {
        urls.push(new URL(url));
        headers.push(init.headers);
        return new Response("ok");
      });
    });

    it("does nothing outside a Manor pane", async () => {
      delete process.env.MANOR_PANE_ID;
      expect(await (await load())({})).toEqual({});
    });

    it("maps a turn to SessionStart, UserPromptSubmit, tool hooks and Stop", async () => {
      const h = await hooks();
      const ev = (type: string, properties: Record<string, unknown>) => h.event!({ event: { type, properties } });
      await ev("session.created", { info: { id: "ses_a" } });
      await ev("session.status", { sessionID: "ses_a", status: { type: "busy" } });
      // Busy again mid-turn (a retry) is still the same turn.
      await ev("session.status", { sessionID: "ses_a", status: { type: "retry" } });
      await h["tool.execute.before"]!(
        { tool: "edit", sessionID: "ses_a", callID: "call_1" },
        { args: { filePath: "/repo/a.ts" } },
      );
      await h["tool.execute.after"]!({ tool: "edit", sessionID: "ses_a", callID: "call_1" }, {});
      await ev("permission.asked", { id: "per_1", sessionID: "ses_a" });
      await ev("permission.replied", { sessionID: "ses_a", requestID: "per_1" });
      await ev("session.status", { sessionID: "ses_a", status: { type: "idle" } });
      // The deprecated idle event follows the status one: not a second Stop.
      await ev("session.idle", { sessionID: "ses_a" });
      await ev("session.deleted", { info: { id: "ses_a" } });

      expect(sent().map((p) => [p.eventType, p.filePath])).toEqual([
        ["SessionStart", undefined],
        ["UserPromptSubmit", undefined],
        ["PreToolUse", undefined],
        ["PostToolUse", "/repo/a.ts"],
        ["PermissionRequest", undefined],
        ["PreToolUse", undefined],
        ["Stop", undefined],
        ["SessionEnd", undefined],
      ]);
      const db = path.join(dir, ".local", "share", "opencode", "opencode.db");
      for (const p of sent()) {
        expect(p).toMatchObject({ paneId: "pane-7", kind: "opencode", sessionId: "ses_a", transcriptPath: `${db}#ses_a` });
      }
      expect(urls[0].port).toBe("4123");
      expect(urls[0].pathname).toBe("/hook/event");
      expect(headers[0]).toEqual({ "x-manor-hook-token": "secret" });
    });

    it("sends what Manor's hook parser maps to each status", async () => {
      const h = await hooks();
      const ev = (type: string, properties: Record<string, unknown>) => h.event!({ event: { type, properties } });
      await ev("session.status", { sessionID: "ses_a", status: { type: "busy" } });
      await h["tool.execute.before"]!({ tool: "bash", sessionID: "ses_a", callID: "c" }, { args: {} });
      await ev("question.asked", { id: "que_1", sessionID: "ses_a" });
      await ev("session.idle", { sessionID: "ses_a" });
      const statuses = urls.map((u) => {
        const parsed = parseAgentHookEvent(u.searchParams);
        if (!parsed.ok) throw new Error(parsed.reason);
        expect(parsed.event.transcriptPath).toMatch(/opencode\.db#ses_a$/);
        return parsed.event.status;
      });
      // A session first seen prompted starts with SessionStart.
      expect(statuses).toEqual(["thinking", "thinking", "working", "requires_input", "responded"]);
    });

    it("ignores a subtask's session, known from its creation or asked of opencode", async () => {
      sessions.ses_asked = { parentID: "ses_a" };
      const h = await hooks();
      const ev = (type: string, properties: Record<string, unknown>) => h.event!({ event: { type, properties } });
      await ev("session.created", { info: { id: "ses_child", parentID: "ses_a" } });
      await ev("session.status", { sessionID: "ses_child", status: { type: "busy" } });
      await h["tool.execute.before"]!({ tool: "read", sessionID: "ses_asked", callID: "c" }, { args: {} });
      await ev("permission.asked", { sessionID: "ses_asked" });
      expect(urls).toEqual([]);
      // A session opencode resumed (no session.created) that has no parent is the root.
      await ev("session.status", { sessionID: "ses_resumed", status: { type: "busy" } });
      expect(sent().map((p) => [p.eventType, p.sessionId])).toEqual([
        ["SessionStart", "ses_resumed"],
        ["UserPromptSubmit", "ses_resumed"],
      ]);
    });

    it("starts the session the pane moved to and prompted, but never a subtask's", async () => {
      sessions.ses_sub = { parentID: "ses_b" };
      const h = await hooks();
      const ev = (type: string, properties: Record<string, unknown>) => h.event!({ event: { type, properties } });
      await ev("session.created", { info: { id: "ses_a" } });
      await ev("session.status", { sessionID: "ses_a", status: { type: "busy" } });
      await ev("session.idle", { sessionID: "ses_a" });
      // An existing session picked from opencode's list, then prompted.
      await ev("session.status", { sessionID: "ses_b", status: { type: "busy" } });
      await h["tool.execute.before"]!({ tool: "task", sessionID: "ses_b", callID: "c1" }, { args: {} });
      // Its subtask, created or not, never takes the pane.
      await ev("session.created", { info: { id: "ses_child", parentID: "ses_b" } });
      await ev("session.status", { sessionID: "ses_child", status: { type: "busy" } });
      await ev("session.status", { sessionID: "ses_sub", status: { type: "busy" } });
      await ev("session.idle", { sessionID: "ses_b" });
      // Back to the first: started again.
      await ev("session.status", { sessionID: "ses_a", status: { type: "busy" } });
      expect(sent().map((p) => [p.eventType, p.sessionId])).toEqual([
        ["SessionStart", "ses_a"],
        ["UserPromptSubmit", "ses_a"],
        ["Stop", "ses_a"],
        ["SessionStart", "ses_b"],
        ["UserPromptSubmit", "ses_b"],
        ["PreToolUse", "ses_b"],
        ["Stop", "ses_b"],
        ["SessionStart", "ses_a"],
        ["UserPromptSubmit", "ses_a"],
      ]);
    });

    it("names the database $OPENCODE_DB or $XDG_DATA_HOME says, and none in memory", async () => {
      process.env.XDG_DATA_HOME = path.join(dir, "data");
      process.env.OPENCODE_DB = "other.db";
      let h = await hooks();
      await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_x" } } } });
      expect(sent()[0].transcriptPath).toBe(`${path.join(dir, "data", "opencode", "other.db")}#ses_x`);

      urls = [];
      process.env.OPENCODE_DB = ":memory:";
      h = await hooks();
      await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_x" } } } });
      expect(sent()[0].transcriptPath).toBeUndefined();
    });

    it("falls back to MANOR_HOOK_PORT without a port file, and stays quiet with neither", async () => {
      process.env.MANOR_HOOK_PORT_FILE = path.join(dir, "missing");
      let h = await hooks();
      await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_x" } } } });
      expect(urls).toEqual([]);
      process.env.MANOR_HOOK_PORT = "5555";
      h = await hooks();
      await h.event!({ event: { type: "session.created", properties: { info: { id: "ses_x" } } } });
      expect(urls.map((u) => u.port)).toEqual(["5555"]);
      expect(headers[0]).toBeUndefined();
    });
  });
});
