import { describe, it, expect } from "vitest";

// popups.ts imports `BrowserWindow` and `shell` from electron at module scope.
// We mock the whole electron module before importing the unit under test so the
// pure helper `buildPopupWindowOptions` remains importable in the Node/vitest
// environment without a running Electron instance.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: () => Promise.resolve() },
}));

import { vi } from "vitest";
import { buildPopupWindowOptions } from "../popups";

// ---------------------------------------------------------------------------
// Constants mirrored from popups.ts (kept in sync manually)
// ---------------------------------------------------------------------------
const DEFAULT_POPUP_WIDTH = 600;
const DEFAULT_POPUP_HEIGHT = 700;
const MIN_POPUP_DIMENSION = 200;
const MAX_POPUP_DIMENSION = 2000;

// ---------------------------------------------------------------------------
// Helper: extract width/height from the return value
// ---------------------------------------------------------------------------
function sizeOf(opts: ReturnType<typeof buildPopupWindowOptions>) {
  return { width: opts.width, height: opts.height };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPopupWindowOptions – features string parsing & size clamping", () => {
  it("uses defaults when features string is empty", () => {
    const opts = buildPopupWindowOptions(null, "");
    expect(sizeOf(opts)).toEqual({
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT,
    });
  });

  it("uses defaults when features string has no width/height keys", () => {
    const opts = buildPopupWindowOptions(null, "popup,scrollbars=yes");
    expect(sizeOf(opts)).toEqual({
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT,
    });
  });

  it("parses explicit width and height from features string", () => {
    const opts = buildPopupWindowOptions(null, "width=500,height=600");
    expect(sizeOf(opts)).toEqual({ width: 500, height: 600 });
  });

  it("parses width/height with extra keys interspersed", () => {
    const opts = buildPopupWindowOptions(null, "popup,width=800,scrollbars=yes,height=900");
    expect(sizeOf(opts)).toEqual({ width: 800, height: 900 });
  });

  it("clamps width below MIN to MIN_POPUP_DIMENSION", () => {
    const opts = buildPopupWindowOptions(null, "width=50,height=400");
    expect(opts.width).toBe(MIN_POPUP_DIMENSION);
    expect(opts.height).toBe(400);
  });

  it("clamps height below MIN to MIN_POPUP_DIMENSION", () => {
    const opts = buildPopupWindowOptions(null, "width=400,height=1");
    expect(opts.width).toBe(400);
    expect(opts.height).toBe(MIN_POPUP_DIMENSION);
  });

  it("clamps width above MAX to MAX_POPUP_DIMENSION", () => {
    const opts = buildPopupWindowOptions(null, "width=9999,height=400");
    expect(opts.width).toBe(MAX_POPUP_DIMENSION);
    expect(opts.height).toBe(400);
  });

  it("clamps height above MAX to MAX_POPUP_DIMENSION", () => {
    const opts = buildPopupWindowOptions(null, "width=400,height=99999");
    expect(opts.width).toBe(400);
    expect(opts.height).toBe(MAX_POPUP_DIMENSION);
  });

  it("accepts a value exactly at MIN (no clamping)", () => {
    const opts = buildPopupWindowOptions(null, `width=${MIN_POPUP_DIMENSION},height=${MIN_POPUP_DIMENSION}`);
    expect(sizeOf(opts)).toEqual({
      width: MIN_POPUP_DIMENSION,
      height: MIN_POPUP_DIMENSION,
    });
  });

  it("accepts a value exactly at MAX (no clamping)", () => {
    const opts = buildPopupWindowOptions(null, `width=${MAX_POPUP_DIMENSION},height=${MAX_POPUP_DIMENSION}`);
    expect(sizeOf(opts)).toEqual({
      width: MAX_POPUP_DIMENSION,
      height: MAX_POPUP_DIMENSION,
    });
  });

  it("falls back to default width when width value is non-numeric", () => {
    const opts = buildPopupWindowOptions(null, "width=abc,height=500");
    expect(opts.width).toBe(DEFAULT_POPUP_WIDTH);
    expect(opts.height).toBe(500);
  });

  it("falls back to default height when height value is non-numeric", () => {
    const opts = buildPopupWindowOptions(null, "width=500,height=xyz");
    expect(opts.width).toBe(500);
    expect(opts.height).toBe(DEFAULT_POPUP_HEIGHT);
  });

  it("falls back to defaults when width is zero", () => {
    const opts = buildPopupWindowOptions(null, "width=0,height=0");
    expect(sizeOf(opts)).toEqual({
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT,
    });
  });

  it("falls back to defaults when width is negative", () => {
    const opts = buildPopupWindowOptions(null, "width=-100,height=-200");
    expect(sizeOf(opts)).toEqual({
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT,
    });
  });

  it("rounds fractional pixel values", () => {
    // parseFeaturesSize uses parseInt so 499.9 → 499, which is in range
    const opts = buildPopupWindowOptions(null, "width=499,height=499");
    expect(opts.width).toBe(499);
    expect(opts.height).toBe(499);
  });

  it("sets secure webPreferences regardless of features", () => {
    const opts = buildPopupWindowOptions(null, "width=500,height=600");
    expect(opts.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it("sets minWidth and minHeight to MIN_POPUP_DIMENSION", () => {
    const opts = buildPopupWindowOptions(null, "");
    expect(opts.minWidth).toBe(MIN_POPUP_DIMENSION);
    expect(opts.minHeight).toBe(MIN_POPUP_DIMENSION);
  });

  it("accepts a non-null mainWindow and sets it as parent", () => {
    // We just need any object to stand in for a BrowserWindow reference;
    // buildPopupWindowOptions assigns it to `parent` without calling methods.
    const fakeWindow = { id: 1 } as unknown as Electron.BrowserWindow;
    const opts = buildPopupWindowOptions(fakeWindow, "width=400,height=500");
    expect(opts.parent).toBe(fakeWindow);
  });

  it("sets parent to undefined when mainWindow is null", () => {
    const opts = buildPopupWindowOptions(null, "width=400,height=500");
    expect(opts.parent).toBeUndefined();
  });

  it("is tolerant of extra whitespace around key/value pairs", () => {
    const opts = buildPopupWindowOptions(null, " width = 500 , height = 600 ");
    expect(sizeOf(opts)).toEqual({ width: 500, height: 600 });
  });

  it("treats keys case-insensitively (WIDTH/HEIGHT)", () => {
    // parseFeaturesSize lowercases keys, so WIDTH and HEIGHT should parse
    const opts = buildPopupWindowOptions(null, "WIDTH=500,HEIGHT=600");
    expect(sizeOf(opts)).toEqual({ width: 500, height: 600 });
  });
});
