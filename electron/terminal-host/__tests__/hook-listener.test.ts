import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { HookJournal } from "../hook-journal";
import { HOOK_TOKEN_HEADER, HookListener } from "../hook-listener";
import type { HookJournalEntry } from "../types";

function httpGet(
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
  });
}

describe("HookListener (remote daemon, ADR-178 §2)", () => {
  let dir: string;
  let portFile: string;
  let journal: HookJournal;
  let listener: HookListener;
  let env: NodeJS.ProcessEnv;
  let entries: HookJournalEntry[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-hook-listener-"));
    portFile = path.join(dir, "hook-port");
    journal = new HookJournal(path.join(dir, "daemon", "hook-journal.ndjson"));
    journal.open();
    env = { MANOR_HOOK_PORT: "1" };
    entries = [];
    listener = new HookListener({
      journal,
      portFile,
      env,
      onEntry: (entry) => entries.push(entry),
    });
    await listener.start();
  });

  /** The listener's token, as the hook script reads it from the port file. */
  const token = () => fs.readFileSync(portFile, "utf-8").split("\n")[1]!;
  const get = (urlPath: string) =>
    httpGet(listener.port, urlPath, { [HOOK_TOKEN_HEADER]: token() });

  afterEach(() => {
    listener.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("publishes its port and token in a 0600 port file, and the file in MANOR_HOOK_PORT_FILE", () => {
    expect(listener.port).toBeGreaterThan(0);
    const [port, tok] = fs.readFileSync(portFile, "utf-8").split("\n");
    expect(port).toBe(String(listener.port));
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(portFile).mode & 0o777).toBe(0o600);
    expect(env.MANOR_HOOK_PORT).toBe(String(listener.port));
    expect(env.MANOR_HOOK_PORT_FILE).toBe(portFile);
  });

  it("refuses requests without the right token, journaling nothing", async () => {
    const url = "/hook/event?paneId=p1&eventType=Stop&kind=claude";
    expect((await httpGet(listener.port, url)).status).toBe(403);
    expect((await httpGet(listener.port, url, { [HOOK_TOKEN_HEADER]: "nope" })).status).toBe(403);
    expect(
      (await httpGet(listener.port, url, { [HOOK_TOKEN_HEADER]: token().replace(/.$/, "x") })).status,
    ).toBe(403);
    expect(entries).toEqual([]);
    expect(journal.lastSeq).toBe(0);
    expect((await get(url)).status).toBe(200);
    expect(journal.lastSeq).toBe(1);
  });

  it("journals and emits a valid hook, answering 200 ok", async () => {
    const res = await get("/hook/event?paneId=p1&eventType=Stop&kind=claude&sessionId=s1");
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      seq: 1,
      payload: { paneId: "p1", eventType: "Stop", kind: "claude", sessionId: "s1" },
    });
    expect(journal.since(0)).toEqual(entries);
  });

  it("answers like AgentHookServer: 404 off-path, 400 malformed, 200 for a dropped event", async () => {
    expect((await get("/other")).status).toBe(404);
    expect((await get("/hook/event?eventType=Stop&kind=claude")).status).toBe(400);
    expect((await get("/hook/event?paneId=p&eventType=Stop&kind=nope")).status).toBe(400);
    const dropped = await get(
      "/hook/event?paneId=p&eventType=Notification&kind=claude&notificationKind=idle_prompt",
    );
    expect(dropped).toEqual({ status: 200, body: "ok" });
    // None of these were relayable, so none were journaled.
    expect(entries).toEqual([]);
    expect(journal.lastSeq).toBe(0);
  });

  it("binds loopback only", () => {
    const server = (listener as unknown as { server: http.Server }).server;
    const addr = server.address();
    expect(addr && typeof addr === "object" ? addr.address : null).toBe("127.0.0.1");
  });

  it("removes its port file on stop, but not one that names another listener", async () => {
    listener.stop();
    expect(fs.existsSync(portFile)).toBe(false);

    await listener.start();
    fs.writeFileSync(portFile, "9");
    listener.stop();
    expect(fs.readFileSync(portFile, "utf-8")).toBe("9");
  });
});
