/**
 * The ordering invariant `install-desktop.ts` and `install-web.ts` both
 * state and hold: no store module may evaluate — read
 * or subscribe to `window.electronAPI` at module scope, inside `create()`'s
 * initializer — before `window.electronAPI` exists.
 *
 * A test that only imports a store and checks it does not throw passes on
 * the bug: `preferences-store.ts` (and `theme-store.ts`, `agent-store.ts`,
 * `keybindings-store.ts`, `stats-store.ts`, `remote-control-store.ts`) write
 * every one of those calls `window.electronAPI?.…`, so a missing bridge is
 * silently skipped rather than thrown. What this asserts instead is that
 * the calls a store's initializer makes at module scope actually reach a
 * transport — which only happens if the side-effect module that installs
 * the bridge was imported, and finished evaluating, first. Reversing the
 * import order reproduces it below: the same store, the same spies, zero
 * calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ManorHost } from "../../electron";
import { base64urlEncode } from "../../lib/relay-crypto";
import { desktopKey, FakeRelaySocket } from "./fake-relay";

function hostWith(overrides: Partial<ManorHost> = {}): ManorHost {
  return {
    platform: "electron",
    rendererId: "1",
    claim: null,
    env: { isPackaged: true },
    native: {} as ManorHost["native"],
    invoke: vi.fn((frame: { id: unknown }) =>
      Promise.resolve({
        id: frame.id,
        kind: "result" as const,
        ok: true as const,
        result: undefined,
      }),
    ),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe("the bridge-install ordering invariant", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    delete (window as unknown as { manorHost?: unknown }).manorHost;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("install-desktop.ts installs the bridge before preferences-store evaluates", async () => {
    const host = hostWith();
    (window as unknown as { manorHost: ManorHost }).manorHost = host;

    await import("../install-desktop");
    await import("../../store/preferences-store");

    // `preferences-store.ts`'s module-scope `getAll()` and `onChange(...)`
    // reached the real transport, which only happens if `window.electronAPI`
    // already existed when the store module was evaluated.
    expect(host.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ ns: "preferences", method: "getAll", args: [] }),
    );
    expect(host.subscribe).toHaveBeenCalledWith(
      "preferences",
      "changed",
      null,
      expect.any(Function),
    );
  });

  it("install-web.ts installs the bridge before preferences-store evaluates", async () => {
    FakeRelaySocket.instances = [];
    FakeRelaySocket.key = desktopKey();
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };
    vi.stubGlobal("WebSocket", FakeRelaySocket);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "relay.test",
      hash: `#relay=AbCdEfGhIjKlMnOpQr_-01.${base64urlEncode(FakeRelaySocket.key.pub)}&t=full-token`,
      pathname: "/app/1.0.0/",
      search: "",
      replace: vi.fn(),
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("__APP_VERSION__", "1.0.0");

    await import("../install-web");
    await import("../../store/preferences-store");

    const socket = FakeRelaySocket.instances[0];
    expect(socket).toBeDefined();
    socket.handshake();

    // Same property: the store's module-scope calls made it onto the wire.
    const kinds = socket.frames.map((frame) => frame.kind);
    expect(kinds).toContain("invoke");
    expect(kinds).toContain("subscribe");
  });

  it("fails on the old ordering: a store evaluated before the bridge exists never reaches the transport", async () => {
    const host = hostWith();

    // The bug: the store module (reached through `./App` in the real entry
    // files) evaluates before the bridge is installed. Every call at module
    // scope is `?.`-guarded, so nothing throws — it is just silently
    // skipped, forever, because a store's initializer runs once.
    await import("../../store/preferences-store");

    (window as unknown as { manorHost: ManorHost }).manorHost = host;
    await import("../install-desktop");

    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.subscribe).not.toHaveBeenCalled();
  });
});
