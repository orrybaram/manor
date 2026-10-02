/**
 * What a caller's *class* changes, and nothing else (ADR-180 D4).
 *
 * Dispatch knows two kinds of caller: `local`, an Electron renderer window on
 * this machine, authenticated by being one, and `device`, a paired device
 * that got past remote control's token check. One table answers both,
 * and exactly two things read the difference:
 *
 * - **`LOCAL_ONLY`** — fifteen methods a device may not call. It is asserted here through real dispatch, method by method,
 *   because the whole point of D4 is that the refusal is a decision written
 *   down rather than an absence: a `Set` entry is one line to delete, and
 *   deleting it has to fail something. The last block pins the membership
 *   by name; the rest pin what membership *does*.
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
  SECRET_FIRST_ARG,
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
   * No state changed, but something happened: a paired device asked for
   * real power it is denied, and `remoteControl.pair` from a stolen token is
   * the single most important line this log can hold. The HTTP transport
   * already records its refusals as `rejected`; the bridge staying silent on
   * the same event would be the two transports of one gate disagreeing.
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
    expect(line).toMatchObject({
      route: "linear.connect",
      outcome: "rejected",
    });
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

/**
 * The handler table's own refusal list (ADR-180 D4), pinned by name: a
 * method absent from `HANDLERS` is refused by not existing, and a method
 * present but named here is refused on purpose, in writing, instead of by an
 * accident of the preload never implementing it. The blocks above pin what
 * membership *does*; this one pins who the members are.
 */
describe("the bridge's LOCAL_ONLY (ADR-180 D4)", () => {
  it("is exactly the methods that name a window or a per-host resource", () => {
    expect([...LOCAL_ONLY].sort()).toEqual(
      [
        // ADR-180 ticket 5: one prewarmed session per host.
        "pty.consumePrewarmed",
        "pty.updatePrewarmCwd",
        // ADR-180 ticket 6: the desk's own viewport file, and the reply half
        // of an app-command addressed to the primary window only.
        "viewport.load",
        "viewport.save",
        "appCommands.result",
        // ADR-180 ticket 7: the keybindings page is read-only on web
        // (ADR-178 ticket 6), and a popout's forwarded command names a
        // window a device does not have.
        "keybindings.set",
        "keybindings.reset",
        "keybindings.resetAll",
        "keybindings.runInMainWindow",
        // ADR-180 ticket 10: the keys, and the lock they turn. A stolen
        // `full` token that can pair more devices is a token that survives
        // its own revocation, and one that can turn remote control off can lock
        // the owner out of taking it back. `getStatus` is absent from this list
        // on purpose — a device's settings page may read the surface it is
        // on.
        "remoteControl.setEnabled",
        "remoteControl.startRelay",
        "remoteControl.pair",
        "remoteControl.resetRelayAddress",
        "remoteControl.revoke",
        "remoteControl.stopRelay",
        // The one method in the whole surface that takes a raw credential as
        // an argument. Everything else Linear does hands back the result of
        // using the stored key and crosses like any other read.
        "linear.connect",
      ].sort(),
    );
  });

  /**
   * The half of the namespace that is *not* refused. Pinned beside the list
   * above because "read-only on web" is a claim about both halves, and a
   * future edit that widened `LOCAL_ONLY` to the whole namespace would leave
   * a paired device's own settings page unable to say whether the host is
   * reachable — while still passing the assertion above.
   */
  it("leaves remote control's read reachable from a device", () => {
    expect(LOCAL_ONLY.has("remoteControl.getStatus")).toBe(false);
  });

  /**
   * `MUTATING` decides what lands in the audit log, and `bridgeTarget` puts
   * the first string argument of an audited call in its `target` field. For
   * `linear.connect` that argument is the API key.
   *
   * Asserted over `SECRET_FIRST_ARG` rather than over that one name, because
   * the rule is about the class and not about Linear: a method that *takes* a
   * credential goes in that set, and this is what the set is for.
   * `surface.ts` makes the same assertion at compile time; this one is here
   * because this is the file somebody reads when they want to know what a
   * device may do.
   */
  it("never audits a method whose first argument is a credential", () => {
    expect([...SECRET_FIRST_ARG]).toEqual(["linear.connect"]);
    for (const method of SECRET_FIRST_ARG) {
      expect(MUTATING.has(method)).toBe(false);
    }
  });

  /**
   * The other direction, and the one that would rot silently: every name in
   * `LOCAL_ONLY` has to be a method the table actually has. A refusal for a
   * method that no longer exists refuses nothing, and reads in a diff exactly
   * like one that does.
   */
  it("names only methods that are on the table", () => {
    for (const method of LOCAL_ONLY) {
      expect(Object.keys(HANDLERS)).toContain(method);
    }
  });

  /**
   * What a `full` device's bridge surface *is*, said once: the table, minus
   * the refusals. There is no third list and no per-method gate — `dispatch`
   * looks the method up and asks `LOCAL_ONLY` about the caller's class, and
   * that is the whole of it (ADR-180 D4).
   */
  it("is the whole of what a full device may not reach on the bridge", () => {
    const table = Object.keys(HANDLERS);
    const reachable = table.filter((method) => !LOCAL_ONLY.has(method));
    const refused = table.filter((method) => LOCAL_ONLY.has(method));

    expect(refused.sort()).toEqual([...LOCAL_ONLY].sort());
    expect(reachable).toHaveLength(table.length - LOCAL_ONLY.size);
    // Not a token subset: the reads, the writes and the whole of `pty` are in
    // it, which is ADR-178 D3 as written.
    expect(reachable).toContain("pty.create");
    expect(reachable).toContain("projects.removeWorktree");
    expect(reachable).toContain("git.commit");
    expect(reachable).toContain("remoteControl.getStatus");
  });
});
