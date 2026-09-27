/**
 * What env a daemon-spawned shell actually gets. The daemon's `updateEnv`
 * handler writes the values onto its own `process.env` (index.ts), and a
 * session's spawn payload is built from `process.env` plus the per-create
 * `env` overrides at the moment the pty subprocess reports ready. These tests
 * drive a real `TerminalHost` and read the SPAWN frame it sends the (mocked)
 * pty subprocess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import "../xterm-env-polyfill";

const children = vi.hoisted(
  () => [] as Array<{ stdin: PassThrough; stdout: PassThrough }>,
);

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = { stdin: new PassThrough(), stdout: new PassThrough() };
    children.push(child);
    return { ...child, on: vi.fn(), kill: vi.fn(), pid: 4242 };
  }),
}));

vi.mock("../../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-spawn-env-zdotdir",
    realZdotdir: () => "/tmp/manor-spawn-env-home",
  },
}));

import { TerminalHost } from "../terminal-host";
import {
  FrameDecoder,
  MSG,
  encodeFrame,
  type MessageType,
} from "../pty-subprocess-ipc";
import type { PtySpawnPayload } from "../types";

/** Report ready from the newest subprocess and return its SPAWN payload. */
async function spawnPayloadOfLatest(): Promise<PtySpawnPayload> {
  const child = children[children.length - 1]!;
  let payload: PtySpawnPayload | null = null;
  const decoder = new FrameDecoder((type: MessageType, body: Buffer) => {
    if (type === MSG.SPAWN) payload = JSON.parse(body.toString("utf-8"));
  });
  child.stdin.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.write(encodeFrame(MSG.READY));
  await new Promise((r) => setImmediate(r));
  if (!payload) throw new Error("no SPAWN frame was sent");
  return payload;
}

describe("session spawn env", () => {
  let sessionsDir: string;
  let host: TerminalHost;
  const touched = ["MANOR_TEST_UPDATED", "MANOR_TEST_BOTH"];

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-spawn-env-"));
    host = new TerminalHost(sessionsDir);
  });

  afterEach(() => {
    host.disposeAll();
    for (const key of touched) delete process.env[key];
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("includes values the daemon received through updateEnv", async () => {
    // What the daemon's `updateEnv` handler does with the request.
    process.env.MANOR_TEST_UPDATED = "from-update-env";

    host.create("s1", sessionsDir, 80, 24);
    const payload = await spawnPayloadOfLatest();

    expect(payload.env.MANOR_TEST_UPDATED).toBe("from-update-env");
    expect(payload.env.MANOR_PANE_ID).toBe("s1");
  });

  it("lets per-create env overrides win over updateEnv values", async () => {
    process.env.MANOR_TEST_BOTH = "from-update-env";

    host.create("s2", sessionsDir, 80, 24, [], false, {
      MANOR_TEST_BOTH: "from-create",
    });
    const payload = await spawnPayloadOfLatest();

    expect(payload.env.MANOR_TEST_BOTH).toBe("from-create");
  });
});
