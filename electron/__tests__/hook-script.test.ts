/**
 * Tests that the hook shell script (notify.sh) correctly extracts `tool_use_id`
 * from the stdin JSON payload and forwards it as a `toolUseId` query param.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { HOOK_SCRIPT_PATH, ensureHookScript } from "../agent-hooks";

// ── Helpers ──

function startCaptureServer(): Promise<{
  server: http.Server;
  port: number;
  requests: string[];
  close: () => void;
}> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200);
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        requests,
        close: () => server.close(),
      });
    });
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Suite ──

describe("hook script (notify.sh) — toolUseId forwarding", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-hookscript-e2e-${crypto.randomUUID()}`,
    );
    originalHome = process.env.HOME;
    // Override HOME so the hook script writes hook-port to a temp dir,
    // not the real ~/.manor/hook-port.
    process.env.HOME = tmpDir;
    ensureHookScript();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends toolUseId query param when tool_use_id is present in payload", async () => {
    const { port, requests, close } = await startCaptureServer();

    // Write the hook-port file to the temp HOME dir
    const hookPortDir = path.join(tmpDir, ".manor");
    fs.mkdirSync(hookPortDir, { recursive: true });
    fs.writeFileSync(path.join(hookPortDir, "hook-port"), String(port));

    const payload = JSON.stringify({
      hook_event_name: "SubagentStart",
      session_id: "parent-sess",
      tool_use_id: "tool-xyz",
    });

    spawnSync("bash", [HOOK_SCRIPT_PATH], {
      input: payload,
      env: {
        ...process.env,
        HOME: tmpDir,
        MANOR_PANE_ID: "pane-1",
        MANOR_HOOK_PORT: String(port),
      },
      timeout: 5000,
    });

    // Give curl a moment to complete
    await waitMs(200);
    close();

    expect(requests.length).toBeGreaterThan(0);
    const url = requests[0];
    expect(url).toContain("paneId=pane-1");
    expect(url).toContain("eventType=SubagentStart");
    expect(url).toContain("toolUseId=tool-xyz");
  });

  it("omits toolUseId query param when tool_use_id is absent", async () => {
    const { port, requests, close } = await startCaptureServer();

    const hookPortDir = path.join(tmpDir, ".manor");
    fs.mkdirSync(hookPortDir, { recursive: true });
    fs.writeFileSync(path.join(hookPortDir, "hook-port"), String(port));

    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-123",
    });

    spawnSync("bash", [HOOK_SCRIPT_PATH], {
      input: payload,
      env: {
        ...process.env,
        HOME: tmpDir,
        MANOR_PANE_ID: "pane-2",
        MANOR_HOOK_PORT: String(port),
      },
      timeout: 5000,
    });

    await waitMs(200);
    close();

    expect(requests.length).toBeGreaterThan(0);
    const url = requests[0];
    expect(url).toContain("paneId=pane-2");
    expect(url).toContain("eventType=Stop");
    expect(url).not.toContain("toolUseId");
  });
});
