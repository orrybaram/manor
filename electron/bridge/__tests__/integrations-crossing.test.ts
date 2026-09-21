/**
 * The last namespace group to cross (ADR-180 D4/D8, ticket 10).
 *
 * `git`, `github`, `linear` and `remoteControl` are table entries now, and two
 * things about them are decisions rather than mechanics — which means nothing
 * downstream would go red if either were undone:
 *
 * - **A push's progress goes to whoever started it.** It rode `event.sender`
 *   when it was an `ipcMain.handle`; it is an addressed `git.push.progress`
 *   frame now (D5). Get the origin wrong and a second window's toast tracks
 *   somebody else's push — silently, with a green suite behind it.
 * - **`LOCAL_ONLY` is the whole of the refusal.** Pairing, revoking and the
 *   tunnel controls refuse a paired device because a stolen `full` token that
 *   can pair more devices is a token that survives its own revocation;
 *   `linear.connect` refuses one because it is the only method in the surface
 *   whose *argument* is a credential. Both are one flag on a table entry —
 *   which is the point of writing them down, and the reason they are
 *   asserted through real dispatch rather than by reading the set back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { HostDeps } from "../../ipc/types";
import { UNAVAILABLE_CODE } from "../types";
import { BridgeServer } from "../server";
import type { BridgeConnection, EventFrame } from "../types";

function makeConnection(id: string, callerClass: "local" | "device") {
  const frames: EventFrame[] = [];
  const connection: BridgeConnection = {
    id,
    callerClass,
    deviceId: callerClass === "device" ? id : null,
    deviceLabel: callerClass === "device" ? "phone" : null,
    send: (frame) => {
      if (frame.kind === "event") frames.push(frame);
    },
  };
  return { connection, frames };
}

describe("git.push over the bridge", () => {
  let server: BridgeServer;
  let pushStream: ReturnType<typeof vi.fn>;
  let handlers: { onLine(line: string): void; onDone(r: unknown): void };

  beforeEach(() => {
    pushStream = vi.fn(
      (_wsPath: string, _opts: unknown, sinks: typeof handlers) => {
        handlers = sinks;
        return { cancel: vi.fn() };
      },
    );
    const deps = {
      getRendererWindows: () => [],
      backend: { git: { pushStream } },
    } as unknown as HostDeps;
    server = new BridgeServer(deps);
  });

  afterEach(() => {
    server.dispose();
  });

  it("streams its lines to the caller and to nobody else", async () => {
    const pushing = makeConnection("11", "local");
    const bystander = makeConnection("12", "local");
    for (const c of [pushing, bystander]) server.accept(c.connection);
    // Both windows have a DiffPane mounted, so both are listening.
    for (const c of [pushing, bystander]) {
      server.subscribe(c.connection, "git.push", "progress");
    }

    const result = await server.dispatch(pushing.connection, {
      kind: "invoke",
      id: "p1",
      ns: "git.push",
      method: "start",
      args: [{ wsPath: "/repo/main", setUpstream: true }],
    });
    expect(result.ok).toBe(true);
    expect(pushStream).toHaveBeenCalledWith(
      "/repo/main",
      { setUpstream: true },
      expect.anything(),
    );

    handlers.onLine("Enumerating objects: 3, done.");
    handlers.onDone({ exitCode: 0, stderr: "" });

    expect(pushing.frames).toEqual([
      {
        kind: "event",
        ns: "git.push",
        event: "progress",
        args: [
          {
            pushId: "/repo/main",
            type: "line",
            line: "Enumerating objects: 3, done.",
          },
        ],
      },
      {
        kind: "event",
        ns: "git.push",
        event: "progress",
        args: [{ pushId: "/repo/main", type: "done", exitCode: 0, stderr: "" }],
      },
    ]);
    expect(bystander.frames).toEqual([]);
  });

  it("refuses a second push for the same workspace", async () => {
    const win = makeConnection("11", "local");
    server.accept(win.connection);
    const start = () =>
      server.dispatch(win.connection, {
        kind: "invoke",
        id: "p",
        ns: "git.push",
        method: "start",
        args: [{ wsPath: "/repo/main" }],
      });

    expect((await start()).ok).toBe(true);
    const second = await start();
    expect(second.ok).toBe(false);
    // A real failure, not a refusal: the caller may try again once it ends.
    expect(second).toMatchObject({ code: "failed" });

    // Let the first one finish so the module-level lock does not leak into
    // the next test in this file.
    handlers.onDone({ exitCode: 0, stderr: "" });
  });
});

describe("what a paired device may not call (LOCAL_ONLY)", () => {
  let server: BridgeServer;
  let remoteControl: Record<string, ReturnType<typeof vi.fn>>;
  let linearManager: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    remoteControl = {
      status: vi.fn(() => ({ enabled: true })),
      refreshDetection: vi.fn(() => Promise.resolve({ enabled: true })),
      setEnabled: vi.fn(() => Promise.resolve({ enabled: false })),
      pair: vi.fn(() => ({ rawToken: "secret", device: { id: "d2" } })),
      revoke: vi.fn(() => ({ enabled: true })),
      startTunnel: vi.fn(() => Promise.resolve({ enabled: true })),
      stopTunnel: vi.fn(() => Promise.resolve({ enabled: true })),
      onChange: vi.fn(),
    };
    linearManager = {
      saveToken: vi.fn(),
      clearToken: vi.fn(),
      getViewer: vi.fn(() => Promise.resolve({ name: "O", email: "o@x" })),
      isConnected: vi.fn(() => true),
    };
    const deps = {
      getRendererWindows: () => [],
      remoteControl,
      linearManager,
    } as unknown as HostDeps;
    server = new BridgeServer(deps);
  });

  afterEach(() => {
    server.dispose();
  });

  function call(conn: BridgeConnection, ns: string, method: string, args = []) {
    return server.dispatch(conn, { kind: "invoke", id: "x", ns, method, args });
  }

  const refused = [
    ["remoteControl", "setEnabled"],
    ["remoteControl", "pair"],
    ["remoteControl", "revoke"],
    ["remoteControl", "startTunnel"],
    ["remoteControl", "stopTunnel"],
    ["linear", "connect"],
  ] as const;

  it.each(refused)("refuses %s.%s with unavailable:web", async (ns, method) => {
    const device = makeConnection("dev-1", "device");
    server.accept(device.connection);

    const result = await call(device.connection, ns, method);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: UNAVAILABLE_CODE });
    // Refused before the handler, so nothing was half-done on the way out.
    expect(remoteControl.pair).not.toHaveBeenCalled();
    expect(remoteControl.setEnabled).not.toHaveBeenCalled();
    expect(linearManager.saveToken).not.toHaveBeenCalled();
  });

  it("lets a device read the surface it is on", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device.connection);

    expect(
      await call(device.connection, "remoteControl", "getStatus"),
    ).toMatchObject({ ok: true });
    expect(
      await call(device.connection, "remoteControl", "refreshDetection"),
    ).toMatchObject({ ok: true });
    expect(
      await call(device.connection, "linear", "isConnected"),
    ).toMatchObject({ ok: true, result: true });
  });

  it("lets the user at the machine do all of it", async () => {
    const win = makeConnection("11", "local");
    server.accept(win.connection);

    const paired = await server.dispatch(win.connection, {
      kind: "invoke",
      id: "p",
      ns: "remoteControl",
      method: "pair",
      args: ["Orry's phone", "full"],
    });

    expect(paired).toMatchObject({ ok: true });
    expect(remoteControl.pair).toHaveBeenCalledWith("Orry's phone", "full");

    const connected = await server.dispatch(win.connection, {
      kind: "invoke",
      id: "c",
      ns: "linear",
      method: "connect",
      args: ["lin_api_key"],
    });

    expect(connected).toMatchObject({ ok: true });
    expect(linearManager.saveToken).toHaveBeenCalledWith("lin_api_key");
  });
});
