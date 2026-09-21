/**
 * What a caller's *class* changes, and nothing else (ADR-180 D4).
 *
 * Dispatch knows two kinds of caller: `local`, an Electron renderer window on
 * this machine, authenticated by being one, and `device`, a paired `full`
 * device that got past remote control's token check. One table answers both,
 * and exactly two things read the difference:
 *
 * - **`LOCAL_ONLY`** — fifteen methods a device may not call, however `full`
 *   its tier. It is asserted here through real dispatch, method by method,
 *   because the whole point of D4 is that the refusal is a decision written
 *   down rather than an absence: a `Set` entry is one line to delete, and
 *   deleting it has to fail something. `allowlist.test.ts` pins the
 *   membership by name; this file pins what membership *does*.
 * - **The audit log** — a device's mutating calls leave a line, and a local
 *   caller's never do, whatever they touch. A line per window would be a log
 *   of the app using itself, and it would bury the lines that are about
 *   somebody else's phone.
 *
 * The handlers are stubs on purpose. What each method *does* is tested where
 * it lives; what is tested here is the two decisions dispatch makes before it
 * calls one, and a stub is the only way to see that a refused call never
 * reached its handler at all.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { HostDeps } from "../../ipc/types";
import { RemoteAuditLog } from "../../remote-control/audit";
import {
  HANDLERS,
  LOCAL_ONLY,
  MUTATING,
  type BridgeHandler,
} from "../handlers";
import { BridgeServer } from "../server";
import { UNAVAILABLE_CODE, type BridgeConnection } from "../types";

function makeConnection(
  id: string,
  callerClass: "local" | "device",
): BridgeConnection {
  return {
    id,
    callerClass,
    deviceId: callerClass === "device" ? id : null,
    deviceLabel: callerClass === "device" ? "Orry's phone" : null,
    send: () => {},
  };
}

const deps = { getRendererWindows: () => [] } as unknown as HostDeps;

/** The real table's keys, with stubs that record who got through. */
function stubTable(called: string[]): Record<string, BridgeHandler> {
  return Object.fromEntries(
    Object.keys(HANDLERS).map((method) => [
      method,
      (() => {
        called.push(method);
        return "answered";
      }) as BridgeHandler,
    ]),
  );
}

function invoke(
  server: BridgeServer,
  connection: BridgeConnection,
  method: string,
  args: unknown[] = [],
) {
  const at = method.lastIndexOf(".");
  return server.dispatch(connection, {
    kind: "invoke",
    id: "1",
    ns: at === -1 ? method : method.slice(0, at),
    method: at === -1 ? method : method.slice(at + 1),
    args,
  });
}

describe("LOCAL_ONLY, through dispatch", () => {
  let server: BridgeServer;
  let called: string[];

  beforeEach(() => {
    called = [];
    server = new BridgeServer(deps, { handlers: stubTable(called) });
  });

  afterEach(() => server.dispose());

  it.each([...LOCAL_ONLY])("refuses a device calling %s", async (method) => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    const result = await invoke(server, device, method);

    expect(result).toMatchObject({ ok: false, code: UNAVAILABLE_CODE });
    // Refused *before* the handler: nothing was half-done on the way out, and
    // the device cannot tell a refusal from a method that does not exist.
    expect(called).toEqual([]);
  });

  it.each([...LOCAL_ONLY])(
    "lets the user at the machine call %s",
    async (method) => {
      const window = makeConnection("11", "local");
      server.accept(window);

      const result = await invoke(server, window, method);

      expect(result).toMatchObject({ ok: true, result: "answered" });
      expect(called).toEqual([method]);
    },
  );

  it("refuses an absent method the same way it refuses a listed one", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    const absent = await invoke(server, device, "pty.frobnicate");
    const listed = await invoke(server, device, "viewport.load");

    expect(absent).toEqual({
      id: "1",
      kind: "result",
      ok: false,
      code: UNAVAILABLE_CODE,
      error: "pty.frobnicate is not available in the browser",
    });
    expect(listed).toEqual({
      id: "1",
      kind: "result",
      ok: false,
      code: UNAVAILABLE_CODE,
      error: "viewport.load is not available in the browser",
    });
  });
});

describe("the audit log, by caller class", () => {
  let dir: string;
  let audit: RemoteAuditLog;
  let server: BridgeServer;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-caller-class-"));
    audit = new RemoteAuditLog(path.join(dir, "remote-audit.jsonl"));
    server = new BridgeServer(deps, { audit, handlers: stubTable([]) });
  });

  afterEach(() => {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a line for a device's mutating call, naming what it pointed at", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    await invoke(server, device, "preferences.set", ["defaultEditor", "vim"]);

    expect(audit.read()).toMatchObject([
      {
        deviceId: "dev-1",
        deviceLabel: "Orry's phone",
        tier: "full",
        transport: "bridge",
        route: "preferences.set",
        // The key, never the value: `bridgeTarget` takes the first primitive
        // argument and the rest of the call is not recorded at all.
        target: "defaultEditor",
        outcome: "sent",
        status: 200,
      },
    ]);
  });

  it("writes nothing for the user at the machine, mutating or not", async () => {
    const window = makeConnection("11", "local");
    server.accept(window);

    await invoke(server, window, "preferences.set", ["defaultEditor", "vim"]);
    await invoke(server, window, "projects.remove", ["p1"]);
    await invoke(server, window, "pty.close", ["pane-1"]);

    expect(audit.read()).toEqual([]);
  });

  it("writes nothing for a device's read", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    await invoke(server, device, "projects.getAll");
    await invoke(server, device, "agents.getActive");

    expect(MUTATING.has("projects.getAll")).toBe(false);
    expect(audit.read()).toEqual([]);
  });

  /**
   * This test used to assert the opposite — "writes nothing when a device is
   * refused, because nothing happened" — and was reversed in ADR-180 ticket
   * 13. No state changed, but something happened: a paired device asked for
   * real power it is denied, and `remoteControl.pair` from a stolen token is
   * the single most important line this log can hold. The HTTP transport
   * already records its refusals as `rejected`; the bridge staying silent on
   * the same event was the two transports of one gate disagreeing.
   */
  it("writes a rejected line when a device is refused a LOCAL_ONLY method", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    await invoke(server, device, "remoteControl.pair", ["laptop", "full"]);

    expect(audit.read()).toMatchObject([
      {
        deviceId: "dev-1",
        route: "remoteControl.pair",
        target: "laptop",
        outcome: "rejected",
        status: 403,
      },
    ]);
  });

  it("never writes the secret a refused credential call carried", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    await invoke(server, device, "linear.connect", ["lin_api_stolen"]);

    const [line] = audit.read();
    expect(line).toMatchObject({ route: "linear.connect", outcome: "rejected" });
    expect(line.target).toBeNull();
    expect(JSON.stringify(audit.read())).not.toContain("lin_api_stolen");
  });

  it("writes nothing for a method that is not on the table at all", async () => {
    const device = makeConnection("dev-1", "device");
    server.accept(device);

    await invoke(server, device, "pty.frobnicate", ["pane-1"]);

    expect(audit.read()).toEqual([]);
  });
});
