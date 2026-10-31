/**
 * The pi extension Manor writes (`PiConnector.registerHooks`), run against a
 * fake pi: what each hook sends to Manor's hook server. Runs against a temp
 * HOME so it never touches the real ~/.pi.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiConnector } from "../agent-connectors";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

describe("pi extension", () => {
  let tmpDir: string;
  const saved = { home: process.env.HOME, pane: process.env.MANOR_PANE_ID, portFile: process.env.MANOR_HOOK_PORT_FILE };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-pi-ext-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    process.env.MANOR_PANE_ID = "pane-7";
    const portFile = path.join(tmpDir, "hook-port");
    fs.writeFileSync(portFile, "4567\ntok-1\n");
    process.env.MANOR_HOOK_PORT_FILE = portFile;
    fetchMock = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of [
      ["HOME", saved.home],
      ["MANOR_PANE_ID", saved.pane],
      ["MANOR_HOOK_PORT_FILE", saved.portFile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write the extension, load it as pi would, and return its handlers. */
  async function loadExtension(): Promise<Map<string, Handler>> {
    expect(new PiConnector().registerHooks("/unused")).toEqual([]);
    const source = fs.readFileSync(path.join(tmpDir, ".pi", "agent", "extensions", "manor-hooks.ts"), "utf-8");
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const file = path.join(tmpDir, "manor-hooks.mjs");
    fs.writeFileSync(file, js);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      default: (pi: unknown) => void;
    };
    const handlers = new Map<string, Handler>();
    mod.default({ on: (name: string, fn: Handler) => handlers.set(name, fn), getSessionName: () => null });
    return handlers;
  }

  function ctx(sessionFile: string | undefined) {
    return {
      sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => sessionFile },
      ui: { setTitle: () => {} },
    };
  }

  function sent(): URL[] {
    return fetchMock.mock.calls.map(([url]) => new URL(String(url)));
  }

  it("sends the session file as the transcript path with each hook", async () => {
    const handlers = await loadExtension();
    const file = "/home/d1/.pi/agent/sessions/--work-repo--/2026-01-01T10-00-00-000Z_sess-1.jsonl";
    await handlers.get("session_start")!({}, ctx(file));
    await handlers.get("agent_end")!({}, ctx(file));
    expect(sent().map((u) => Object.fromEntries(u.searchParams))).toEqual([
      { paneId: "pane-7", eventType: "SessionStart", kind: "pi", sessionId: "sess-1", transcriptPath: file },
      { paneId: "pane-7", eventType: "Stop", kind: "pi", sessionId: "sess-1", transcriptPath: file },
    ]);
    expect(sent()[0].port).toBe("4567");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { "x-manor-hook-token": "tok-1" } });
  });

  it("sends no transcript path for an in-memory session", async () => {
    const handlers = await loadExtension();
    await handlers.get("session_start")!({}, ctx(undefined));
    expect(sent()[0].searchParams.has("transcriptPath")).toBe(false);
    expect(sent()[0].searchParams.get("sessionId")).toBe("sess-1");
  });
});
