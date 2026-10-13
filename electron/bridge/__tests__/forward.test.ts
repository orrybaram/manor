/**
 * `BridgeServer`'s `forward` (ADR-227 D4): a routed call that names a remote
 * host is answered by that host's server, a refusal from an away host is a
 * stated `unavailable:host-away`, and everything else runs here as before.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { RemoteAuditLog } from "../../remote-control/audit";
import { byProject, flatten, method, toHandlerTable, type HandlerCtx } from "../method";
import { BridgeServer, type BridgeForward } from "../server";
import {
  BridgeUnavailableRefusal,
  UNAVAILABLE_CODE,
  UNAVAILABLE_HOST_AWAY_CODE,
  type BridgeConnection,
} from "../types";

type Deps = { backend: { pty: { getSnapshot: () => Promise<null> } } };

const here = vi.fn((_ctx: HandlerCtx<Deps>, projectId: string) => `here:${projectId}`);

const TABLE = toHandlerTable<Deps>(
  flatten({
    projects: {
      rename: method(here, { mutating: true, route: byProject(0) }),
      list: method(here),
    },
  }),
  { unavailable: { code: UNAVAILABLE_CODE, where: "in the browser" }, localOnlyCallers: new Set(["local"]) },
);

function connection(callerClass: "local" | "device"): BridgeConnection {
  return {
    id: callerClass === "local" ? "1" : "phone",
    callerClass,
    deviceId: callerClass === "device" ? "phone" : null,
    deviceLabel: callerClass === "device" ? "A phone" : null,
    send: () => {},
  };
}

function server(forward: BridgeForward) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-forward-"));
  const auditFile = path.join(dir, "audit.jsonl");
  const bridge = new BridgeServer<Deps>(
    { backend: { pty: { getSnapshot: async () => null } } },
    {
      table: TABLE,
      forward,
      events: () => () => {},
      audit: new RemoteAuditLog(auditFile),
    },
  );
  onTestFinished(() => {
    bridge.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bridge, auditFile };
}

describe("BridgeServer forward (ADR-227 D4)", () => {
  it("answers a call for a remote host's project from that host", async () => {
    here.mockClear();
    const forward: BridgeForward = {
      target: (_rule, args) => (args[0] === "box-app" ? "box" : null),
      invoke: vi.fn(async (hostId, ns, name, args) => `${hostId}:${ns}.${name}:${String(args[0])}`),
    };
    const { bridge } = server(forward);
    const conn = connection("local");
    bridge.accept(conn);

    const remote = await bridge.dispatch(conn, {
      id: 1,
      kind: "invoke",
      ns: "projects",
      method: "rename",
      args: ["box-app", "New"],
    });
    expect(remote).toMatchObject({ ok: true, result: "box:projects.rename:box-app" });
    expect(forward.invoke).toHaveBeenCalledWith(
      "box",
      "projects",
      "rename",
      ["box-app", "New"],
      { id: "1", callerClass: "local", deviceId: null },
    );
    expect(here).not.toHaveBeenCalled();

    // A local project, and an unrouted method, run here.
    expect(
      await bridge.dispatch(conn, { id: 2, kind: "invoke", ns: "projects", method: "rename", args: ["mine"] }),
    ).toMatchObject({ ok: true, result: "here:mine" });
    expect(
      await bridge.dispatch(conn, { id: 3, kind: "invoke", ns: "projects", method: "list", args: ["box-app"] }),
    ).toMatchObject({ ok: true, result: "here:box-app" });
  });

  it("answers an away host's refusal as unavailable:host-away, audited", async () => {
    const forward: BridgeForward = {
      target: () => "box",
      invoke: async () => {
        throw new BridgeUnavailableRefusal("me@box is offline", UNAVAILABLE_HOST_AWAY_CODE);
      },
    };
    const { bridge, auditFile } = server(forward);
    const phone = connection("device");
    bridge.accept(phone);
    const answer = await bridge.dispatch(phone, {
      id: 1,
      kind: "invoke",
      ns: "projects",
      method: "rename",
      args: ["box-app"],
    });
    expect(answer).toEqual({
      id: 1,
      kind: "result",
      ok: false,
      error: "me@box is offline",
      code: UNAVAILABLE_HOST_AWAY_CODE,
    });
    const line = JSON.parse(fs.readFileSync(auditFile, "utf-8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ route: "projects.rename", outcome: "rejected", status: 403 });
  });

  it("runs a call here when the lookup throws", async () => {
    here.mockClear();
    const forward: BridgeForward = {
      target: () => {
        throw new Error("boom");
      },
      invoke: vi.fn(),
    };
    const { bridge } = server(forward);
    const conn = connection("local");
    bridge.accept(conn);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    expect(
      await bridge.dispatch(conn, { id: 1, kind: "invoke", ns: "projects", method: "rename", args: ["x"] }),
    ).toMatchObject({ ok: true, result: "here:x" });
    expect(forward.invoke).not.toHaveBeenCalled();
  });
});
