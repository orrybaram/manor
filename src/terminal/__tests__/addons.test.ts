import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

class FakeWebglAddon {}
class FakeImageAddon {}
class FakeUnicode11Addon {}
class FakeSearchAddon {}

const fonts = vi.hoisted(() => ({ ready: vi.fn(() => Promise.resolve()) }));
const searchImport = vi.hoisted(() => vi.fn());

vi.mock("../../lib/terminal-font", () => ({
  terminalFontsReady: fonts.ready,
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: FakeImageAddon }));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: FakeUnicode11Addon,
}));
vi.mock("@xterm/addon-search", () => {
  searchImport();
  return { SearchAddon: FakeSearchAddon };
});

async function freshModule() {
  vi.resetModules();
  return import("../addons");
}

afterEach(() => {
  vi.clearAllMocks();
  fonts.ready.mockImplementation(() => Promise.resolve());
});

describe("whenTerminalCanOpen", () => {
  it("hands over the add-ons that decide how the grid is drawn", async () => {
    const { whenTerminalCanOpen } = await freshModule();

    await expect(whenTerminalCanOpen()).resolves.toEqual({
      WebglAddon: FakeWebglAddon,
      ImageAddon: FakeImageAddon,
      Unicode11Addon: FakeUnicode11Addon,
    });
  });

  it("opens without an add-on whose chunk failed to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@xterm/addon-webgl", () => {
      throw new Error("chunk failed");
    });
    try {
      const { whenTerminalCanOpen } = await freshModule();

      await expect(whenTerminalCanOpen()).resolves.toEqual({
        WebglAddon: null,
        ImageAddon: FakeImageAddon,
        Unicode11Addon: FakeUnicode11Addon,
      });
    } finally {
      vi.doMock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
      warn.mockRestore();
    }
  });

  it("does not resolve until the terminal fonts are ready", async () => {
    let fontsLoaded!: () => void;
    fonts.ready.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          fontsLoaded = resolve;
        }),
    );
    const { whenTerminalCanOpen } = await freshModule();

    let opened = false;
    const ready = whenTerminalCanOpen().then(() => {
      opened = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(false);

    fontsLoaded();
    await ready;
    expect(opened).toBe(true);
  });
});

describe("loadSearchAddon", () => {
  it("loads the search add-on once, however many panes ask", async () => {
    const { loadSearchAddon } = await freshModule();

    const [a, b] = await Promise.all([loadSearchAddon(), loadSearchAddon()]);
    await loadSearchAddon();

    expect(a).toBe(FakeSearchAddon);
    expect(b).toBe(FakeSearchAddon);
    expect(searchImport).toHaveBeenCalledTimes(1);
  });
});

describe("searchAddonFor", () => {
  it("loads one search add-on onto each terminal", async () => {
    const { searchAddonFor } = await freshModule();
    const term = { loadAddon: vi.fn() } as unknown as Terminal;

    expect(searchAddonFor(term)).toBe(searchAddonFor(term));
    const addon = await searchAddonFor(term);

    expect(addon).toBeInstanceOf(FakeSearchAddon);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledWith(addon);
  });
});
