import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrewarmManager } from "./prewarm-manager";
import { LOCAL_HOST_ID } from "./backend/types";
import type { TerminalHostClient } from "./terminal-host/client";
import type { HostForPath } from "./backend/routed-backend";

/** A fake `TerminalHostClient` exposing only what `PrewarmManager` calls. */
function fakeClient() {
  let seq = 0;
  return {
    createNoSubscribe: vi.fn(async () => {
      seq++;
      return { id: `session-${seq}` };
    }),
    writeAfterReady: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  };
}

describe("PrewarmManager", () => {
  let client: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    client = fakeClient();
  });

  it("never warms a remote cwd", async () => {
    const hostForPath: HostForPath = () => "remote-box";
    const manager = new PrewarmManager(
      client as unknown as TerminalHostClient,
      "/local/default",
      hostForPath,
    );

    await manager.warm("/remote/ws");

    expect(client.createNoSubscribe).not.toHaveBeenCalled();
    expect(manager.isReady).toBe(false);
  });

  it("disposes a stale local prewarm when the cwd moves to a remote host", async () => {
    let host = LOCAL_HOST_ID;
    const hostForPath: HostForPath = () => host;
    const manager = new PrewarmManager(
      client as unknown as TerminalHostClient,
      "/local/default",
      hostForPath,
    );

    await manager.warm("/local/ws");
    expect(manager.isReady).toBe(true);
    const warmedPaneId = (
      client.createNoSubscribe.mock.calls[0] as unknown[]
    )[0] as string;

    host = "remote-box";
    await manager.warm("/local/ws");

    expect(client.kill).toHaveBeenCalledWith(warmedPaneId);
    expect(manager.isReady).toBe(false);
    // No second create for the (now remote) cwd.
    expect(client.createNoSubscribe).toHaveBeenCalledTimes(1);
  });

  it("consume() returns null when the requested cwd doesn't match the warmed one", async () => {
    const manager = new PrewarmManager(
      client as unknown as TerminalHostClient,
      "/local/default",
      () => LOCAL_HOST_ID,
    );

    await manager.warm("/local/ws-a");
    expect(manager.isReady).toBe(true);

    expect(manager.consume("/local/ws-b")).toBeNull();
    // The mismatched consume must not have torn down the still-valid prewarm.
    expect(manager.isReady).toBe(true);
    expect(manager.consume("/local/ws-a")).not.toBeNull();
  });

  it("consume() returns null when the warmed cwd's host is no longer local", async () => {
    let host = LOCAL_HOST_ID;
    const manager = new PrewarmManager(
      client as unknown as TerminalHostClient,
      "/local/default",
      () => host,
    );

    await manager.warm("/local/ws");
    expect(manager.isReady).toBe(true);

    // Simulate the workspace having been reassigned to a remote host
    // between warming and the tab opening — same cwd, different host.
    host = "remote-box";

    expect(manager.consume("/local/ws")).toBeNull();
  });

  it("consume() hands back the pane and replenishes in the background", async () => {
    const manager = new PrewarmManager(
      client as unknown as TerminalHostClient,
      "/local/default",
      () => LOCAL_HOST_ID,
    );

    await manager.warm("/local/ws");
    const result = manager.consume("/local/ws");

    expect(result).not.toBeNull();
    expect(manager.isReady).toBe(false);

    // Replenish runs in the background — wait for it.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(client.createNoSubscribe).toHaveBeenCalledTimes(2);
  });
});
