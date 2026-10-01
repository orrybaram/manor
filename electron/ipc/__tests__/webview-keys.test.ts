import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPageKeyHandler } from "../webview-keys";
import { resolveBindings } from "../../../src/lib/keybinding-defs";
import {
  addRendererBroadcastSink,
  setRendererWindowResolver,
  type RendererBroadcast,
} from "../../renderer-broadcast";

type Mods = Partial<Pick<Electron.Input, "meta" | "control" | "shift" | "alt">>;

function input(
  key: string,
  mods: Mods = {},
  type: Electron.Input["type"] = "keyDown",
): Electron.Input {
  return {
    type,
    key,
    code: "",
    meta: false,
    control: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: [],
    ...mods,
  } as Electron.Input;
}

function setup(overrides: Record<string, string> = {}) {
  let bindings = resolveBindings(overrides, "MacIntel").bindings;
  let time = 1_000;
  let zoom = 0;
  const page = {
    getZoomLevel: vi.fn(() => zoom),
    setZoomLevel: vi.fn((level: number) => {
      zoom = level;
    }),
    reload: vi.fn(),
  };
  const host = { id: 1, send: vi.fn(), isDestroyed: vi.fn(() => false) };
  const handler = createPageKeyHandler({
    paneId: "pane-1",
    page,
    host,
    getBindings: () => bindings,
    now: () => time,
  });
  const press = (i: Electron.Input) => {
    const event = { preventDefault: vi.fn() } as unknown as Electron.Event & {
      preventDefault: ReturnType<typeof vi.fn>;
    };
    handler(event, i);
    return event;
  };
  return {
    page,
    host,
    press,
    advance: (ms: number) => {
      time += ms;
    },
    rebind: (next: Record<string, string>) => {
      bindings = resolveBindings(next, "MacIntel").bindings;
    },
  };
}

describe("createPageKeyHandler", () => {
  let frames: RendererBroadcast[];
  let stopSink: () => void;

  beforeEach(() => {
    frames = [];
    stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
    // The host's `id` names a connection the same way a real renderer window
    // would (ADR-180 D5) — the transport this test stands in for.
    setRendererWindowResolver((win) => String(win.webContents.id));
  });

  afterEach(() => {
    stopSink();
    setRendererWindowResolver(null);
  });

  describe("double Escape", () => {
    it("blurs the page on a second Escape within 500ms", () => {
      const { press, host, advance } = setup();
      const first = press(input("Escape"));
      expect(first.preventDefault).not.toHaveBeenCalled();
      expect(host.send).not.toHaveBeenCalled();
      advance(200);
      const second = press(input("Escape"));
      expect(second.preventDefault).toHaveBeenCalled();
      expect(host.send).toHaveBeenCalledWith("webview:escape", "pane-1");
    });

    it("ignores two Escapes too far apart", () => {
      const { press, host, advance } = setup();
      press(input("Escape"));
      advance(600);
      press(input("Escape"));
      expect(host.send).not.toHaveBeenCalled();
    });

    it("needs a fresh pair after firing", () => {
      const { press, host, advance } = setup();
      press(input("Escape"));
      advance(100);
      press(input("Escape"));
      advance(100);
      press(input("Escape"));
      expect(host.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("browser keys", () => {
    it("zooms the page in, out and back", () => {
      const { press, page } = setup();
      expect(press(input("=", { meta: true })).preventDefault).toHaveBeenCalled();
      expect(page.setZoomLevel).toHaveBeenLastCalledWith(0.5);
      press(input("-", { meta: true }));
      expect(page.setZoomLevel).toHaveBeenLastCalledWith(0);
      press(input("-", { meta: true }));
      press(input("0", { meta: true }));
      expect(page.setZoomLevel).toHaveBeenLastCalledWith(0);
    });

    it("reloads the page", () => {
      const { press, page } = setup();
      press(input("r", { meta: true }));
      expect(page.reload).toHaveBeenCalled();
    });

    it("relays URL focus, find and back/forward to the host pane", () => {
      const { press, host } = setup();
      press(input("l", { meta: true }));
      press(input("f", { meta: true }));
      press(input("[", { meta: true }));
      press(input("]", { meta: true }));
      expect(host.send.mock.calls).toEqual([
        ["webview:focus-url", "pane-1"],
        ["webview:find", "pane-1"],
        ["webview:go-back", "pane-1"],
        ["webview:go-forward", "pane-1"],
      ]);
    });
  });

  describe("app shortcuts", () => {
    /** Every `keybindings.forwardedCommand` frame this press produced. */
    function forwarded() {
      return frames.filter(
        (f) => f.ns === "keybindings" && f.event === "forwardedCommand",
      );
    }

    it("forwards a bound combo to the host renderer's connection", () => {
      const { press } = setup();
      const event = press(input("k", { meta: true }));
      expect(event.preventDefault).toHaveBeenCalled();
      expect(forwarded()).toEqual([
        {
          ns: "keybindings",
          event: "forwardedCommand",
          args: [
            { commandId: "command-palette", source: "webview", paneId: "pane-1" },
          ],
          to: "1",
        },
      ]);
    });

    it("forwards F6 and Shift+F6", () => {
      const { press } = setup();
      press(input("F6"));
      press(input("F6", { shift: true }));
      expect(
        forwarded().map(
          (f) => (f.args[0] as { commandId: string }).commandId,
        ),
      ).toEqual(["focus-next-region", "focus-prev-region"]);
    });

    it("tracks the user's edits to the bindings", () => {
      const { press, rebind } = setup();
      rebind({ "command-palette": "meta+shift+p" });
      expect(press(input("k", { meta: true })).preventDefault).not.toHaveBeenCalled();
      press(input("P", { meta: true, shift: true }));
      expect(forwarded()).toEqual([
        {
          ns: "keybindings",
          event: "forwardedCommand",
          args: [
            expect.objectContaining({ commandId: "command-palette" }),
          ],
          to: "1",
        },
      ]);
    });

    it("leaves unbound keys and typing to the page", () => {
      const { press, page } = setup();
      for (const i of [
        input("c", { meta: true }),
        input("a"),
        input("A", { shift: true }),
        input("F7"),
      ]) {
        expect(press(i).preventDefault).not.toHaveBeenCalled();
      }
      expect(forwarded()).toEqual([]);
      expect(page.reload).not.toHaveBeenCalled();
    });

    it("ignores key-up events", () => {
      const { press } = setup();
      const event = press(input("k", { meta: true }, "keyUp"));
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(forwarded()).toEqual([]);
    });

    it("does not forward from a destroyed host", () => {
      const { press, host } = setup();
      host.isDestroyed.mockReturnValue(true);
      press(input("k", { meta: true }));
      expect(forwarded()).toEqual([]);
    });
  });
});
