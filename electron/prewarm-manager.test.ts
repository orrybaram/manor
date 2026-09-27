import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrewarmManager } from "./prewarm-manager";
import { LOCAL_HOST_ID } from "./backend/types";
import type { TerminalHostClient } from "./terminal-host/client";

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
  const local = (cwd: string) => ({ cwd, hostId: LOCAL_HOST_ID });

  beforeEach(() => {
    client = fakeClient();
  });

  function manager() {
    return new PrewarmManager(client as unknown as TerminalHostClient, "/local/default");
  }

  it("never warms a remote cwd", async () => {
    const m = manager();

    await m.warm({ cwd: "/remote/ws", hostId: "remote-box" });

    expect(client.createNoSubscribe).not.toHaveBeenCalled();
    expect(m.isReady).toBe(false);
  });

  it("disposes a stale local prewarm when the cwd moves to a remote host", async () => {
    const m = manager();

    await m.warm(local("/local/ws"));
    expect(m.isReady).toBe(true);
    const warmedPaneId = (
      client.createNoSubscribe.mock.calls[0] as unknown[]
    )[0] as string;

    // Same path, now on a remote host.
    await m.updateCwd("/local/ws", "remote-box");

    expect(client.kill).toHaveBeenCalledWith(warmedPaneId);
    expect(m.isReady).toBe(false);
    // No second create for the (now remote) cwd.
    expect(client.createNoSubscribe).toHaveBeenCalledTimes(1);
  });

  it("consume() returns null when the requested cwd doesn't match the warmed one", async () => {
    const m = manager();

    await m.warm(local("/local/ws-a"));
    expect(m.isReady).toBe(true);

    expect(m.consume("/local/ws-b", LOCAL_HOST_ID)).toBeNull();
    // The mismatched consume must not have torn down the still-valid prewarm.
    expect(m.isReady).toBe(true);
    expect(m.consume("/local/ws-a", LOCAL_HOST_ID)).not.toBeNull();
  });

  it("consume() returns null when asked for the warmed cwd on another host", async () => {
    const m = manager();

    await m.warm(local("/local/ws"));
    expect(m.isReady).toBe(true);

    // The workspace was reassigned to a remote host between warming and
    // the tab opening — same cwd, different host.
    expect(m.consume("/local/ws", "remote-box")).toBeNull();
    expect(m.isReady).toBe(true);
  });

  it("consume() hands back the pane and replenishes in the background", async () => {
    const m = manager();

    await m.warm(local("/local/ws"));
    const result = m.consume("/local/ws", LOCAL_HOST_ID);

    expect(result).not.toBeNull();
    expect(m.isReady).toBe(false);

    // Replenish runs in the background — wait for it.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(client.createNoSubscribe).toHaveBeenCalledTimes(2);
  });
});
