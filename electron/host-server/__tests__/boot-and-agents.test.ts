/**
 * The host server end to end (ADR-225 D1, D2): boot, files, the agents its
 * daemon's hooks describe, and what its allowlist refuses. See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";

import {
  eventually,
  hook,
  openOwnerStream,
  useHostServerHarness,
} from "./harness";
import { delay } from "../../terminal-host/daemon-harness";
import { HostServerUnavailableError } from "../../backend/host-server-client";
import type { AgentInfo } from "../../agent-persistence";
import type { PaneStatusUpdate } from "../../agent-status/effects";

describe("host server", () => {
  const h = useHostServerHarness();

  it("writes its pid, version, 0600 owner token and socket, and removes them on stop", async () => {
    await h.serve();
    expect(fs.readFileSync(h.paths.pid, "utf-8").trim()).toBe(
      String(process.pid),
    );
    expect(fs.readFileSync(h.paths.version, "utf-8").trim()).toBe("1.2.3-test");
    expect(fs.statSync(h.paths.ownerToken).mode & 0o777).toBe(0o600);
    expect(fs.statSync(h.paths.socket).mode & 0o777).toBe(0o600);

    await h.stop();
    expect(fs.existsSync(h.paths.pid)).toBe(false);
    expect(fs.existsSync(h.paths.ownerToken)).toBe(false);
    expect(fs.existsSync(h.paths.socket)).toBe(false);
  });

  it("closes a socket whose hello has the wrong token", async () => {
    await h.serve();
    await expect(
      openOwnerStream(h.paths.socket, "not-the-token"),
    ).rejects.toThrow(/refused the owner \(4401/);
  });

  it("serves the agents the daemon's hooks describe, live and replayed after a restart", async () => {
    await h.serve();
    const client = await h.owner();
    expect(await client.invoke<AgentInfo[]>("agents", "getAll")).toEqual([]);
    client.subscribe("agents", "updated");

    // Live: the hook reaches the server as a `hookEvent`.
    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("UserPromptSubmit"));
    const agents = await eventually(
      () => client.invoke<AgentInfo[]>("agents", "getAll"),
      (list) => list.length === 1 && list[0].lastAgentStatus === "thinking",
      "the agent thinking",
    );
    expect(agents).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        paneId: "pane-1",
        hostId: "local",
        status: "active",
        lastAgentStatus: "thinking",
      }),
    ]);
    await client.waitFor(
      (f) => f.kind === "event" && f.ns === "agents" && f.event === "updated",
    );
    const statuses = await client.invoke<PaneStatusUpdate[]>(
      "agents",
      "getPaneStatuses",
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({ paneId: "pane-1", status: "thinking" }),
    );

    // Down: the hook only reaches the journal.
    await h.stop();
    h.daemon.emitHook(hook("Stop"));

    // Back up: replayed from the persisted cursor, and nothing twice.
    await h.serve();
    const again = await h.owner();
    const replayed = await again.invoke<AgentInfo[]>("agents", "getAll");
    expect(replayed).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        status: "active",
        lastAgentStatus: "responded",
      }),
    ]);
    await delay(600); // the cursor's debounced write
    const cursor = JSON.parse(fs.readFileSync(h.paths.hookCursor, "utf-8")) as {
      seq: number;
    };
    expect(cursor.seq).toBe(h.daemon.journal.lastSeq);
  });

  it("replays the whole journal the first time it meets it", async () => {
    // Hooks from before the server was ever installed on this box.
    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("PermissionRequest"));
    await h.serve();
    const client = await h.owner();
    // The agent exists only because the replay created it. (Its last status
    // is then whatever the pane's facts say now: these mocked shells run no
    // agent process, so the resync after the catch-up settles it.)
    expect(await client.invoke<AgentInfo[]>("agents", "getAll")).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        paneId: "pane-1",
        hostId: "local",
        status: "active",
      }),
    ]);
  });

  it("answers what is not on its allowlist with unavailable:host", async () => {
    h.adopt();
    await h.serve();
    const client = await h.owner();
    for (const [ns, methodName] of [
      ["pty", "reset"],
      ["projects", "moveToHost"],
      ["projects", "link"],
      ["layout", "save"],
      ["github", "getIssues"],
      // GitHub is host-native (ADR-227 D7) bar the desktop's feedback flow.
      ["github", "uploadFeedbackImages"],
      ["linear", "getAllIssues"],
      ["linear", "proxyImage"],
    ]) {
      await expect(client.invoke(ns, methodName)).rejects.toBeInstanceOf(
        HostServerUnavailableError,
      );
    }
    // No projects and no layout until one is set up here.
    expect(await client.invoke("projects", "getAll")).toEqual([]);
    expect(await client.invoke("layout", "getAll")).toEqual({});
    expect(await client.invoke("hosts", "list")).toEqual([
      expect.objectContaining({ hostId: "local", status: "connected" }),
    ]);
  });

  it("attaches to a running session, and spawns one the daemon does not have", async () => {
    await h.serve();
    const client = await h.owner();
    const attached = await client.invoke<Record<string, unknown>>(
      "pty",
      "create",
      "pane-1",
      null,
      80,
      24,
    );
    expect(attached).toEqual(
      expect.objectContaining({ ok: true, hostId: "local", prewarmed: true }),
    );

    const spawned = await client.invoke<Record<string, unknown>>(
      "pty",
      "create",
      "pane-new",
      h.tmp,
      80,
      24,
    );
    expect(spawned).toEqual(
      expect.objectContaining({
        ok: true,
        hostId: "local",
        prewarmed: false,
        winsizeOwner: true,
      }),
    );
    expect(
      h.daemon
        .getHost()
        .listSessions()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["pane-1", "pane-new"]);
  });
});
