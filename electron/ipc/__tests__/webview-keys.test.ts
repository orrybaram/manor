import { describe, it, expect, vi } from "vitest";
import { createPageKeyHandler } from "../webview-keys";
import { resolveBindings } from "../../../src/lib/keybinding-defs";

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
  const host = { send: vi.fn(), isDestroyed: vi.fn(() => false) };
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
    it("forwards a bound combo to the host renderer", () => {
      const { press, host } = setup();
      const event = press(input("k", { meta: true }));
      expect(event.preventDefault).toHaveBeenCalled();
      expect(host.send).toHaveBeenCalledWith("keybinding-command", {
        commandId: "command-palette",
        source: "webview",
        paneId: "pane-1",
      });
    });

    it("forwards F6 and Shift+F6", () => {
      const { press, host } = setup();
      press(input("F6"));
      press(input("F6", { shift: true }));
      expect(host.send.mock.calls.map((c) => c[1].commandId)).toEqual([
        "focus-next-region",
        "focus-prev-region",
      ]);
    });

    it("tracks the user's edits to the bindings", () => {
      const { press, host, rebind } = setup();
      rebind({ "command-palette": "meta+shift+p" });
      expect(press(input("k", { meta: true })).preventDefault).not.toHaveBeenCalled();
      press(input("P", { meta: true, shift: true }));
      expect(host.send).toHaveBeenCalledWith(
        "keybinding-command",
        expect.objectContaining({ commandId: "command-palette" }),
      );
    });

    it("leaves unbound keys and typing to the page", () => {
      const { press, host, page } = setup();
      for (const i of [
        input("c", { meta: true }),
        input("a"),
        input("A", { shift: true }),
        input("F7"),
      ]) {
        expect(press(i).preventDefault).not.toHaveBeenCalled();
      }
      expect(host.send).not.toHaveBeenCalled();
      expect(page.reload).not.toHaveBeenCalled();
    });

    it("ignores key-up events", () => {
      const { press, host } = setup();
      const event = press(input("k", { meta: true }, "keyUp"));
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(host.send).not.toHaveBeenCalled();
    });

    it("does not send to a destroyed host", () => {
      const { press, host } = setup();
      host.isDestroyed.mockReturnValue(true);
      press(input("k", { meta: true }));
      expect(host.send).not.toHaveBeenCalled();
    });
  });
});
