import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A `document.fonts` whose `load(font, text)` calls each settle when the
 * test says so, keyed by the font string asked for.
 */
function deferredFonts() {
  const pending = new Map<string, () => void>();
  const load = vi.fn(
    (font: string, _text?: string) =>
      new Promise<void>((resolve) => {
        pending.set(font, resolve);
      }),
  );
  return {
    fonts: { load },
    load,
    settle(match: string) {
      for (const [font, resolve] of pending) if (font.startsWith(match)) resolve();
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return import("../terminal-font");
}

/** Whether `promise` has settled, without waiting on it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

describe("terminalFontsReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the regular and bold text faces to load", async () => {
    const fonts = deferredFonts();
    vi.stubGlobal("document", { fonts: fonts.fonts });
    const { terminalFontsReady } = await freshModule();

    const ready = terminalFontsReady();
    fonts.settle("400");
    expect(await isSettled(ready)).toBe(false);

    fonts.settle("700");
    await expect(ready).resolves.toBeUndefined();
  });

  it("asks only for the family the terminal draws with, by the glyph it measures", async () => {
    const fonts = deferredFonts();
    vi.stubGlobal("document", { fonts: fonts.fonts });
    const { terminalFontsReady } = await freshModule();

    void terminalFontsReady();
    expect(fonts.load.mock.calls).toEqual([
      ["400 13px 'MesloLGM Nerd Font Mono'", "W"],
      ["700 13px 'MesloLGM Nerd Font Mono'", "W"],
    ]);
  });

  it("starts the load once and shares it between callers", async () => {
    const fonts = deferredFonts();
    vi.stubGlobal("document", { fonts: fonts.fonts });
    const { terminalFontsReady } = await freshModule();

    const first = terminalFontsReady();
    const second = terminalFontsReady();
    fonts.settle("");
    await Promise.all([first, second]);
    await terminalFontsReady();

    expect(second).toBe(first);
    expect(fonts.load).toHaveBeenCalledTimes(2);
  });

  it("gives up on a font that never settles rather than blocking terminals", async () => {
    vi.stubGlobal("document", { fonts: deferredFonts().fonts });
    const { terminalFontsReady } = await freshModule();

    const ready = terminalFontsReady();
    expect(await isSettled(ready)).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(ready).resolves.toBeUndefined();
  });

  it("does not wait on a font file that fails to load", async () => {
    const load = vi.fn(() => Promise.reject(new Error("404")));
    vi.stubGlobal("document", { fonts: { load } });
    const { terminalFontsReady } = await freshModule();

    await expect(terminalFontsReady()).resolves.toBeUndefined();
  });
});
