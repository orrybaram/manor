import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A font face whose load settles when the test says so. */
function deferredFace() {
  let settle!: () => void;
  const loaded = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { load: vi.fn(() => loaded), settle };
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

  it("waits for every declared font face to load", async () => {
    const regular = deferredFace();
    const bold = deferredFace();
    vi.stubGlobal("document", { fonts: [regular, bold] });
    const { terminalFontsReady } = await freshModule();

    const ready = terminalFontsReady();
    regular.settle();
    expect(await isSettled(ready)).toBe(false);

    bold.settle();
    await expect(ready).resolves.toBeUndefined();
  });

  it("starts the load once and shares it between callers", async () => {
    const face = deferredFace();
    vi.stubGlobal("document", { fonts: [face] });
    const { terminalFontsReady } = await freshModule();

    const first = terminalFontsReady();
    const second = terminalFontsReady();
    face.settle();
    await Promise.all([first, second]);
    await terminalFontsReady();

    expect(second).toBe(first);
    expect(face.load).toHaveBeenCalledTimes(1);
  });

  it("gives up on a font that never settles rather than blocking terminals", async () => {
    vi.stubGlobal("document", { fonts: [deferredFace()] });
    const { terminalFontsReady } = await freshModule();

    const ready = terminalFontsReady();
    expect(await isSettled(ready)).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(ready).resolves.toBeUndefined();
  });

  it("does not wait on a font file that fails to load", async () => {
    const broken = { load: vi.fn(() => Promise.reject(new Error("404"))) };
    vi.stubGlobal("document", { fonts: [broken] });
    const { terminalFontsReady } = await freshModule();

    await expect(terminalFontsReady()).resolves.toBeUndefined();
  });
});
