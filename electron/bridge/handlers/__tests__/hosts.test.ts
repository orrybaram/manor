import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { localCtx } from "../../method";

// `hosts.remove` deletes files under `~/.manor`; its own test uses temp dirs.
const forgetHostFiles = vi.hoisted(() => vi.fn());
vi.mock("../../../backend/host-removal", () => ({ forgetHostFiles }));

const statusListeners: Array<(hosts: unknown[]) => void> = [];
const resumedListeners: Array<(hostId: string, sessionIds: string[]) => void> = [];

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostServerUnavailableError } from "../../../backend/host-server-client";
import {
  hostsAdd,
  hostsAddRecipeHost,
  hostsCheckTemplate,
  hostsEncryptKeys,
  hostsHealthCheck,
  hostsPairDevice,
  hostsProjectsOnHost,
  hostsRemove,
  hostsResetPairingKeys,
  hostsRevokeDevice,
  hostsRetryConnect,
  hostsRunTemplateFix,
  hostsServerStatus,
  hostsSetLinearOnHost,
  hostsSetLinkPhones,
  hostsSetSupervised,
  wireHostBroadcasts,
} from "../hosts";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../../../renderer-broadcast";

/**
 * The handlers under test, by their old IPC channel names. There is no
 * `register()` any more (ADR-180 D8): the handler table calls the lifted
 * functions with the one long-lived `HostDeps`, and the two broadcasts are
 * wired once at boot by `wireHostBroadcasts` — which is what `register` does
 * here, besides recording the deps. The first argument stands in for the
 * IPC event and is ignored.
 */
let current: unknown;
function register(deps: unknown): void {
  current = deps;
  wireHostBroadcasts(deps as never);
}
const call =
  (fn: (...args: never[]) => unknown) =>
  (_event: unknown, ...args: unknown[]): unknown =>
    (fn as (...args: unknown[]) => unknown)(localCtx(current as never), ...args);
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>([
  ["hosts:add", call(hostsAdd)],
  ["hosts:addRecipeHost", call(hostsAddRecipeHost)],
  ["hosts:retryConnect", call(hostsRetryConnect)],
  ["hosts:healthCheck", call(hostsHealthCheck)],
]);

/** Every renderer broadcast, which is how the host events go out (ADR-180 D5). */
let frames: RendererBroadcast[] = [];
let stopSink: () => void = () => {};
beforeEach(() => {
  frames = [];
  stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
});
afterEach(() => stopSink());

function makeDeps() {
  const backendRegistry = {
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    connectInBackground: vi.fn(),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    retryNow: vi.fn(),
    onHostResumed: vi.fn((cb: (hostId: string, sessionIds: string[]) => void) => {
      resumedListeners.push(cb);
      return () => {};
    }),
    onHostServerStateChange: vi.fn(() => () => {}),
    setServerFacts: vi.fn(),
    onStatusChange: vi.fn((cb: (hosts: unknown[]) => void) => {
      statusListeners.push(cb);
      return () => {};
    }),
  };
  const projectManager = {
    assertKnownHost: vi.fn((hostId: string) => {
      if (hostId !== "local" && hostId !== "box") throw new Error(`Unknown host "${hostId}".`);
    }),
    saveHost: vi.fn(),
    remoteHostIdsInUse: vi.fn().mockReturnValue([]),
    getHosts: vi.fn().mockReturnValue([]),
    hostLinksPhones: vi.fn().mockReturnValue(true),
    setHostLinksPhones: vi.fn(),
    setHostSupervised: vi.fn(),
    hostSupervised: vi.fn().mockReturnValue(false),
  };
  const deps = {
    backendRegistry,
    projectManager,
  };
  return { deps, backendRegistry, projectManager };
}

describe("hosts:add", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("rejects an empty target", () => {
    const { deps } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    expect(() => handler(null, "  ")).toThrow();
  });

  it("rejects a target that looks like an ssh flag", () => {
    const { deps } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    expect(() => handler(null, "-oProxyCommand=evil")).toThrow(/Invalid ssh target/);
  });

  it("registers a valid target and starts connecting in the background", () => {
    const { deps, backendRegistry, projectManager } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    const result = handler(null, "me@box.example.com") as {
      hostId: string;
      spec: { kind: string; target: string };
    };

    expect(result.spec).toEqual({ kind: "ssh", target: "me@box.example.com" });
    expect(projectManager.saveHost).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.register).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.connectInBackground).toHaveBeenCalledWith(result.hostId);
  });

  it("keeps a newly added host's Manor running across reboots by default (ADR-229 D4)", () => {
    const { deps, projectManager } = makeDeps();
    register(deps as never);
    const result = handlers.get("hosts:add")!(null, "me@box") as { hostId: string };
    expect(projectManager.setHostSupervised).toHaveBeenCalledWith(result.hostId, true);
  });
});

describe("hosts:addRecipeHost (ADR-229 D2)", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    statusListeners.length = 0;
    savedHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hosts-recipe-test-"));
    process.env.HOME = home;
    const dir = path.join(home, ".manor", "host-recipes", "k8s-dev");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "recipe.json"),
      JSON.stringify({ schemaVersion: 1, id: "k8s-dev", name: "Dev pod", up: "./up.sh" }),
    );
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("registers a host for the recipe and connects it, which runs up", () => {
    const { deps, backendRegistry, projectManager } = makeDeps();
    register(deps as never);
    const result = handlers.get("hosts:addRecipeHost")!(null, "k8s-dev") as {
      hostId: string;
      spec: unknown;
    };
    expect(result.spec).toEqual({ kind: "recipe", recipeId: "k8s-dev" });
    expect(projectManager.saveHost).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.register).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.ensureConnected).toHaveBeenCalledWith(result.hostId);
    // A box Manor starts is supervised (ADR-229 D4).
    expect(projectManager.setHostSupervised).toHaveBeenCalledWith(result.hostId, true);
  });

  it("refuses a recipe that isn't in ~/.manor/host-recipes, or an id that leaves it", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:addRecipeHost")!;
    expect(() => handler(null, "nope")).toThrow(/No recipe "nope"/);
    expect(() => handler(null, "../k8s-dev")).toThrow(/Invalid recipe id/);
    expect(backendRegistry.register).not.toHaveBeenCalled();
  });

  it("refuses a recipe another host already uses", () => {
    const { deps, projectManager } = makeDeps();
    projectManager.getHosts.mockReturnValue([
      { hostId: "h1", spec: { kind: "recipe", recipeId: "k8s-dev" } },
    ]);
    register(deps as never);
    expect(() => handlers.get("hosts:addRecipeHost")!(null, "k8s-dev")).toThrow(
      /Dev pod" already starts a host/,
    );
  });
});

describe("hosts:checkTemplate (ADR-234 D6)", () => {
  const check = (...args: unknown[]) =>
    (hostsCheckTemplate as (...a: unknown[]) => unknown)(localCtx(makeDeps().deps as never), ...args);

  it("refuses values that aren't an object of strings", () => {
    expect(() => check("docker", null)).toThrow(/object of strings/);
    expect(() => check("docker", ["x"])).toThrow(/object of strings/);
    expect(() => check("docker", { context: 1 })).toThrow(/values\.context/);
    expect(() => check(7, {})).toThrow(/templateId/);
  });

  it("rejects an unknown template", async () => {
    await expect(check("nope", {})).rejects.toThrow(/Unknown template/);
  });
});

describe("hosts:runTemplateFix (ADR-234 D8)", () => {
  const fix = (...args: unknown[]) =>
    (hostsRunTemplateFix as (...a: unknown[]) => unknown)(localCtx(makeDeps().deps as never), ...args);

  it("refuses arguments of the wrong shape", () => {
    expect(() => fix(7, "pull-image", {})).toThrow(/templateId/);
    expect(() => fix("docker", null, {})).toThrow(/fixId/);
    expect(() => fix("docker", "pull-image", null)).toThrow(/object of strings/);
    expect(() => fix("docker", "pull-image", { image: 1 })).toThrow(/values\.image/);
  });

  it("rejects an unknown template or fix", async () => {
    await expect(fix("nope", "pull-image", {})).rejects.toThrow(/Unknown template/);
    await expect(fix("docker", "nope", {})).rejects.toThrow(/Unknown fix/);
  });
});

describe("hosts:retryConnect", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("retries the given host now (the registry decides wake-vs-connect)", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:retryConnect")!;
    handler(null, "box");
    expect(backendRegistry.retryNow).toHaveBeenCalledWith("box");
  });
});

describe("hosts:statusChanged broadcast", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("pushes every status change to every renderer", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);

    const hosts = [{ hostId: "box", status: "connected" }];
    for (const listener of statusListeners) listener(hosts);

    expect(frames).toEqual([
      { ns: "hosts", event: "statusChanged", args: [hosts], to: null },
    ]);
    expect(backendRegistry.onStatusChange).toHaveBeenCalledTimes(1);
  });
});

describe("hosts:reconnected broadcast", () => {
  beforeEach(() => {
    resumedListeners.length = 0;
  });

  it("tells every renderer which sessions a resumed host still has", () => {
    const { deps } = makeDeps();
    register(deps as never);

    for (const listener of resumedListeners) listener("box", ["pane-1"]);

    expect(frames).toEqual([
      {
        ns: "hosts",
        event: "reconnected",
        args: [{ hostId: "box", sessionIds: ["pane-1"] }],
        to: null,
      },
    ]);
  });
});

describe("hosts:healthCheck", () => {

  it("refuses a host that is not registered, before touching any backend", async () => {
    const { deps, backendRegistry } = makeDeps();
    const get = vi.fn();
    Object.assign(backendRegistry, { get });
    register(deps as never);
    await expect(
      handlers.get("hosts:healthCheck")!(null, "nope", "/srv/app") as Promise<unknown>,
    ).rejects.toThrow(/Unknown host/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("hosts phone access", () => {
  function withServer(state: string) {
    const { deps, backendRegistry } = makeDeps();
    const client = {
      status: vi.fn().mockResolvedValue({ pushEndpoints: ["https://p"], devices: 1 }),
      pair: vi.fn().mockResolvedValue({ pairingUrl: "https://relay/app/1/#x" }),
      listDevices: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue([]),
      resetIdentity: vi.fn().mockResolvedValue({ devices: 0 }),
      setLinearToken: vi.fn().mockImplementation(async (t: string | null) => t !== null),
    };
    const server = {
      state,
      api: {
        hostServer: {
          status: client.status,
          resetIdentity: client.resetIdentity,
          setLinearToken: client.setLinearToken,
        },
        remoteControl: {
          pair: client.pair,
          listDevices: client.listDevices,
          revoke: client.revoke,
        },
      },
    };
    Object.assign(backendRegistry, {
      hostServer: vi.fn((id: string) => (id === "box" ? server : undefined)),
    });
    const hostServerSync = { pairingChanged: vi.fn().mockResolvedValue(undefined) };
    const linearManager = { getToken: vi.fn().mockReturnValue("lin_key") };
    return {
      ctx: localCtx({ ...deps, hostServerSync, linearManager } as never),
      backendRegistry,
      client,
      hostServerSync,
      linearManager,
    };
  }

  it("sends the desktop's Linear key to the host, or deletes the copy", async () => {
    const { ctx, client } = withServer("connected");
    await expect(hostsSetLinearOnHost(ctx, "box", true)).resolves.toBe(true);
    expect(client.setLinearToken).toHaveBeenLastCalledWith("lin_key");
    await expect(hostsSetLinearOnHost(ctx, "box", false)).resolves.toBe(false);
    expect(client.setLinearToken).toHaveBeenLastCalledWith(null);
  });

  it("will not turn Linear on without a key here, or on a dropped host", async () => {
    const { ctx, client, linearManager } = withServer("connected");
    linearManager.getToken.mockReturnValue(null);
    await expect(hostsSetLinearOnHost(ctx, "box", true)).rejects.toThrow(/Connect Linear/);
    const dropped = withServer("disconnected");
    await expect(hostsSetLinearOnHost(dropped.ctx, "box", true)).rejects.toThrow(/Phone access/);
    expect(client.setLinearToken).not.toHaveBeenCalled();
    expect(dropped.client.setLinearToken).not.toHaveBeenCalled();
  });

  it("reports an unknown host plainly", async () => {
    const { ctx } = withServer("connected");
    await expect(hostsServerStatus(ctx, "nope")).rejects.toThrow(/Unknown remote host/);
    await expect(hostsPairDevice(ctx, "nope")).rejects.toThrow(/Unknown remote host/);
  });

  it("returns the state without a status while unsupported", async () => {
    const { ctx, client } = withServer("unsupported");
    await expect(hostsServerStatus(ctx, "box")).resolves.toEqual({
      state: "unsupported",
      status: null,
      devices: [],
      linkPhones: true,
      linkedDeviceIds: [],
      blockedDevices: [],
      supervisor: null,
      supervise: false,
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it("refuses to pair, list, revoke or reset on an unsupported or dropped host", async () => {
    for (const state of ["unsupported", "disconnected"]) {
      const { ctx, client } = withServer(state);
      await expect(hostsPairDevice(ctx, "box", "p")).rejects.toThrow(/Phone access/);
      await expect(hostsRevokeDevice(ctx, "box", "d")).rejects.toThrow(/Phone access/);
      await expect(hostsResetPairingKeys(ctx, "box")).rejects.toThrow(/Phone access/);
      expect(client.pair).not.toHaveBeenCalled();
    }
  });

  it("reads a status without touching the endpoint cache", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    const view = await hostsServerStatus(ctx, "box");
    expect(view.status?.devices).toBe(1);
    expect(view.devices).toEqual([]);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    expect(hostServerSync.pairingChanged).not.toHaveBeenCalled();
  });

  it("records the status's room and capability for hosts.list; an older host has no viewer bridge (ADR-228)", async () => {
    const { ctx, client, backendRegistry: registry } = withServer("connected");
    // An older host: no `capabilities`, no top-level `roomId`.
    client.status.mockResolvedValueOnce({ devices: 0, relay: { roomId: "room-old" } });
    await hostsServerStatus(ctx, "box");
    expect(registry.setServerFacts).toHaveBeenLastCalledWith("box", {
      roomId: "room-old",
      viewerBridge: false,
    });
    client.status.mockResolvedValueOnce({
      devices: 0,
      roomId: "room-new",
      capabilities: ["viewer-bridge"],
      relay: { roomId: "room-new" },
    });
    await hostsServerStatus(ctx, "box");
    expect(registry.setServerFacts).toHaveBeenLastCalledWith("box", {
      roomId: "room-new",
      viewerBridge: true,
    });
  });

  it("tells the sync the pairing changed after pair, revoke and reset", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    await hostsPairDevice(ctx, "box", "  my phone ");
    expect(client.pair).toHaveBeenCalledWith("my phone");
    await hostsRevokeDevice(ctx, "box", "d1");
    await hostsResetPairingKeys(ctx, "box");
    expect(hostServerSync.pairingChanged).toHaveBeenCalledTimes(3);
    expect(hostServerSync.pairingChanged).toHaveBeenCalledWith("box");
  });

  it("resets a host's pairing keys through the links' queue (ADR-230 D11)", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    const hostLinks = {
      resetHost: vi.fn(async (_hostId: string, reset: () => Promise<unknown>) => reset()),
    };
    const linkedCtx = { ...ctx, deps: { ...(ctx.deps as object), hostLinks } } as typeof ctx;
    const status = await hostsResetPairingKeys(linkedCtx, "box");
    expect(hostLinks.resetHost).toHaveBeenCalledWith("box", expect.any(Function));
    expect(client.resetIdentity).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ devices: 0 });
    expect(hostServerSync.pairingChanged).toHaveBeenCalledWith("box");
  });

  it("carries the phone-link switch and which phones this desktop linked (ADR-228 D9)", async () => {
    const { ctx } = withServer("connected");
    const hostLinks = {
      linkedOn: vi.fn().mockReturnValue(["d1"]),
      blockedOn: vi.fn().mockReturnValue([]),
      setLinkPhones: vi.fn(),
    };
    const linkedCtx = { ...ctx, deps: { ...(ctx.deps as object), hostLinks } } as typeof ctx;
    const view = await hostsServerStatus(linkedCtx, "box");
    expect(view.linkPhones).toBe(true);
    expect(view.linkedDeviceIds).toEqual(["d1"]);
    expect(hostLinks.linkedOn).toHaveBeenCalledWith("box");
  });

  it("revokes through the links, which block the phone there, and still says the pairing changed (ADR-238 D3)", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    const hostLinks = {
      revokeOnHost: vi.fn(async (_h: string, _d: string, revoke: () => Promise<unknown>) => revoke()),
    };
    const linkedCtx = { ...ctx, deps: { ...(ctx.deps as object), hostLinks } } as typeof ctx;
    await hostsRevokeDevice(linkedCtx, "box", "d1");
    expect(hostLinks.revokeOnHost).toHaveBeenCalledWith("box", "d1", expect.any(Function));
    expect(client.revoke).toHaveBeenCalledWith("d1");
    expect(hostServerSync.pairingChanged).toHaveBeenCalledWith("box");
  });

  it("carries the phones revoked on the host, the host away too (ADR-238 D3)", async () => {
    for (const state of ["connected", "disconnected"] as const) {
      const { ctx } = withServer(state);
      const hostLinks = {
        linkedOn: vi.fn().mockReturnValue([]),
        blockedOn: vi.fn().mockReturnValue([{ deviceId: "p1", label: "Orry's phone" }]),
      };
      const linkedCtx = { ...ctx, deps: { ...(ctx.deps as object), hostLinks } } as typeof ctx;
      const view = await hostsServerStatus(linkedCtx, "box");
      expect(view.blockedDevices).toEqual([{ id: "p1", label: "Orry's phone" }]);
      expect(hostLinks.blockedOn).toHaveBeenCalledWith("box");
    }
  });

  it("sets the phone-link switch through the links, away host included, and says the pairing changed", async () => {
    const { ctx } = withServer("disconnected");
    const hostLinks = {
      linkedOn: vi.fn(),
      blockedOn: vi.fn().mockReturnValue([]),
      setLinkPhones: vi.fn().mockResolvedValue(undefined),
    };
    const linkedCtx = { ...ctx, deps: { ...(ctx.deps as object), hostLinks } } as typeof ctx;
    await hostsSetLinkPhones(linkedCtx, "box", false);
    expect(hostLinks.setLinkPhones).toHaveBeenCalledWith("box", false);
    expect(frames).toContainEqual({ ns: "hosts", event: "pairingChanged", args: ["box"], to: null });
    await expect(hostsSetLinkPhones(linkedCtx, "nope", false)).rejects.toThrow(/Unknown remote host/);
    await expect(hostsSetLinkPhones(linkedCtx, "box", "no" as never)).rejects.toThrow();
  });

  it("carries what supervises the host from its status (ADR-229 D4)", async () => {
    const { ctx, client } = withServer("connected");
    client.status.mockResolvedValueOnce({ devices: 0, supervisor: { kind: "systemd", linger: false } });
    expect((await hostsServerStatus(ctx, "box")).supervisor).toEqual({ kind: "systemd", linger: false });
    // An older server says nothing: none.
    expect((await hostsServerStatus(ctx, "box")).supervisor).toBeNull();
  });

  it("carries the switch's remembered state, read with the host away too (ADR-229 D4)", async () => {
    const { ctx } = withServer("disconnected");
    const pm = (ctx.deps as unknown as { projectManager: { hostSupervised: ReturnType<typeof vi.fn> } })
      .projectManager;
    pm.hostSupervised.mockReturnValue(true);
    expect((await hostsServerStatus(ctx, "box")).supervise).toBe(true);
    expect(pm.hostSupervised).toHaveBeenCalledWith("box");
  });
});

describe("hosts:setSupervised (ADR-229 D4)", () => {
  function withTransport(stdout: string, code = 0) {
    const { deps, backendRegistry, projectManager } = makeDeps();
    const exec = vi.fn().mockResolvedValue({ code, stdout, stderr: "" });
    Object.assign(backendRegistry, {
      provider: vi.fn((id: string) => (id === "box" ? { transport: () => ({ exec }) } : undefined)),
    });
    return { ctx: localCtx(deps as never), exec, projectManager };
  }

  it("runs supervisor install on the host, remembers it, and answers the facts", async () => {
    const { ctx, exec, projectManager } = withTransport('{"supervisor":{"kind":"systemd","linger":true}}\n');
    await expect(hostsSetSupervised(ctx, "box", true)).resolves.toEqual({ kind: "systemd", linger: true });
    expect(exec.mock.calls[0][0]).toBe('exec "$HOME/.manor/bin/manor-host" supervisor install --json');
    expect(projectManager.setHostSupervised).toHaveBeenCalledWith("box", true);
    expect(frames).toContainEqual({ ns: "hosts", event: "pairingChanged", args: ["box"], to: null });
  });

  it("runs uninstall to turn it off", async () => {
    const { ctx, exec, projectManager } = withTransport('{"supervisor":null}\n');
    await expect(hostsSetSupervised(ctx, "box", false)).resolves.toBeNull();
    expect(exec.mock.calls[0][0]).toContain("supervisor uninstall --json");
    expect(projectManager.setHostSupervised).toHaveBeenCalledWith("box", false);
  });

  it("leaves the choice as it was when the host has no supervisor", async () => {
    const { ctx, projectManager } = withTransport('{"error":"No supervisor on this host"}\n', 1);
    await expect(hostsSetSupervised(ctx, "box", true)).rejects.toThrow("No supervisor on this host");
    expect(projectManager.setHostSupervised).not.toHaveBeenCalled();
  });

  it("refuses an unknown host or a non-boolean", async () => {
    const { ctx } = withTransport("{}");
    await expect(hostsSetSupervised(ctx, "nope", true)).rejects.toThrow(/Unknown host/);
    await expect(hostsSetSupervised(ctx, "box", "yes" as never)).rejects.toThrow();
  });
});

describe("hosts:encryptKeys (ADR-236 D7)", () => {
  const OK =
    '{"secrets":{"backend":"key-file","keyFile":"~/.config/manor/secret.key","place":"home"}}\n';
  /** `statuses` are what successive `hostServer.status()` reads do: a backend, or an Error to throw. */
  function withTransport(
    stdout: string,
    opts: { code?: number; execDisabled?: boolean; statuses?: Array<string | Error> } = {},
  ) {
    const { deps, backendRegistry } = makeDeps();
    const exec = vi.fn().mockResolvedValue({ code: opts.code ?? 0, stdout, stderr: "" });
    const statuses = [...(opts.statuses ?? ["key-file"])];
    const status = vi.fn(async () => {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (next instanceof Error) throw next;
      return { secretBackend: next };
    });
    Object.assign(backendRegistry, {
      provider: vi.fn((id: string) =>
        id === "box" ? { transport: () => (opts.execDisabled ? {} : { exec }) } : undefined,
      ),
      // `connected` from the start: the old channel, which must not be trusted.
      hostServer: vi.fn(() => ({ state: "connected", api: { hostServer: { status } } })),
    });
    return { ctx: localCtx(deps as never), exec, status };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs secrets encrypt on the host, answers the facts, and broadcasts", async () => {
    const { ctx, exec } = withTransport(OK);
    await expect(hostsEncryptKeys(ctx, "box")).resolves.toEqual({
      backend: "key-file",
      keyFile: "~/.config/manor/secret.key",
      place: "home",
    });
    expect(exec.mock.calls[0][0]).toBe('exec "$HOME/.manor/bin/manor-host" secrets encrypt --json');
    expect(frames).toContainEqual({ ns: "hosts", event: "pairingChanged", args: ["box"], to: null });
  });

  it("waits, through failed reads and the old server's stale answer, for the new backend before broadcasting", async () => {
    vi.useFakeTimers();
    const { ctx, status } = withTransport(OK, {
      statuses: [
        "plaintext",
        new Error("channel closed"),
        new HostServerUnavailableError("box", "disconnected"),
        "key-file",
      ],
    });
    const done = hostsEncryptKeys(ctx, "box");
    await vi.advanceTimersByTimeAsync(400);
    expect(frames).not.toContainEqual(expect.objectContaining({ event: "pairingChanged" }));
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(status).toHaveBeenCalledTimes(4);
    expect(frames).toContainEqual(expect.objectContaining({ event: "pairingChanged" }));
  });

  it("broadcasts anyway after about 15 s", async () => {
    vi.useFakeTimers();
    const { ctx } = withTransport(OK, { statuses: [new Error("down")] });
    const done = hostsEncryptKeys(ctx, "box");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(frames).not.toContainEqual(expect.objectContaining({ event: "pairingChanged" }));
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(frames).toContainEqual(expect.objectContaining({ event: "pairingChanged" }));
  });

  it("refuses facts of the wrong shape", async () => {
    const { ctx } = withTransport('{"secrets":{"backend":"key-file","keyFile":3,"place":"home"}}\n');
    await expect(hostsEncryptKeys(ctx, "box")).rejects.toThrow(/unreadable/);
  });

  it("passes the command's error through", async () => {
    const { ctx } = withTransport('{"error":"Key file is not writable"}\n', { code: 1 });
    await expect(hostsEncryptKeys(ctx, "box")).rejects.toThrow("Key file is not writable");
    expect(frames).not.toContainEqual(expect.objectContaining({ event: "pairingChanged" }));
  });

  it("refuses an unknown host and a transport without exec", async () => {
    const { ctx } = withTransport(OK);
    await expect(hostsEncryptKeys(ctx, "nope")).rejects.toThrow(/Unknown host/);
    const noExec = withTransport(OK, { execDisabled: true });
    await expect(hostsEncryptKeys(noExec.ctx, "box")).rejects.toThrow(/can't run commands/);
  });
});

describe("hosts:remove (ADR-229 D8)", () => {
  const spec = { kind: "recipe", recipeId: "dev-pod" };

  function withHost(provider: unknown) {
    const { deps, backendRegistry, projectManager } = makeDeps();
    const order: string[] = [];
    const pm = Object.assign(projectManager, {
      getHosts: vi.fn().mockReturnValue([{ hostId: "box", spec }]),
      removeHost: vi.fn(() => void order.push("forget")),
      projectNamesOnHost: vi.fn().mockReturnValue(["App"]),
    });
    Object.assign(backendRegistry, {
      provider: vi.fn((id: string) => (id === "box" ? provider : undefined)),
      hostDisplayName: vi.fn().mockReturnValue("Dev pod"),
      unregister: vi.fn(async () => void order.push("unregister")),
    });
    forgetHostFiles.mockReset().mockImplementation(() => void order.push("files"));
    return { ctx: localCtx(deps as never), backendRegistry, projectManager: pm, order };
  }

  it("destroys the box first, then forgets the host, its connection and its files", async () => {
    const box = { capabilities: { canDestroy: true }, destroy: vi.fn() };
    const { ctx, order } = withHost(box);
    box.destroy.mockImplementation(async () => void order.push("destroy"));
    await hostsRemove(ctx, "box", { destroy: true });
    expect(order).toEqual(["destroy", "forget", "unregister", "files"]);
    expect(forgetHostFiles).toHaveBeenCalledWith("box", spec, { destroyed: true });
    expect(frames).toContainEqual({ ns: "projects", event: "changed", args: [], to: null });
  });

  it("removes nothing when the destroy fails", async () => {
    const { ctx, backendRegistry, projectManager } = withHost({
      capabilities: { canDestroy: true },
      destroy: vi.fn().mockRejectedValue(new Error("destroy.sh exited 1")),
    });
    await expect(hostsRemove(ctx, "box", { destroy: true })).rejects.toThrow("destroy.sh exited 1");
    expect(projectManager.removeHost).not.toHaveBeenCalled();
    expect(backendRegistry.unregister).not.toHaveBeenCalled();
    expect(forgetHostFiles).not.toHaveBeenCalled();
  });

  it("refuses to destroy a host its provider cannot", async () => {
    const { ctx, projectManager } = withHost({ capabilities: { canDestroy: false } });
    await expect(hostsRemove(ctx, "box", { destroy: true })).rejects.toThrow(/can't be destroyed/);
    expect(projectManager.removeHost).not.toHaveBeenCalled();
  });

  it("removes from Manor without touching the box", async () => {
    const destroy = vi.fn();
    const { ctx, order } = withHost({ capabilities: { canDestroy: true }, destroy });
    await hostsRemove(ctx, "box", { destroy: false });
    expect(destroy).not.toHaveBeenCalled();
    expect(order).toEqual(["forget", "unregister", "files"]);
    expect(forgetHostFiles).toHaveBeenCalledWith("box", spec, { destroyed: false });
  });

  it("refuses this computer, an unknown host and a bad argument", async () => {
    const { ctx } = withHost(undefined);
    await expect(hostsRemove(ctx, "local", { destroy: false })).rejects.toThrow(/can't be removed/);
    await expect(hostsRemove(ctx, "nope", { destroy: false })).rejects.toThrow(/Unknown remote host/);
    await expect(hostsRemove(ctx, "box", { destroy: "yes" } as never)).rejects.toThrow();
    await expect(hostsRemove(ctx, "box", null as never)).rejects.toThrow();
  });

  it("names the projects on a host", () => {
    const { ctx, projectManager } = withHost(undefined);
    expect(hostsProjectsOnHost(ctx, "box")).toEqual(["App"]);
    expect(projectManager.projectNamesOnHost).toHaveBeenCalledWith("box");
    expect(() => hostsProjectsOnHost(ctx, "nope")).toThrow(/Unknown host/);
  });
});
