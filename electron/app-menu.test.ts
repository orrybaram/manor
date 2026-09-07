import { describe, it, expect, vi } from "vitest";

// ── Mock electron ────────────────────────────────────────────────────────────
// `app-menu.ts` calls electron APIs at module scope only inside
// `installAppMenu`, but importing the module still touches `electron`, so it
// needs a minimal mock — same approach as `electron/__tests__/agents-getactive.test.ts`.
vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    off: vi.fn(),
    isPackaged: false,
    name: "Manor",
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
    setApplicationMenu: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

import { pickTargetWindow } from "./app-menu";

function fakeWindow(): {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean };
} {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  };
}

describe("pickTargetWindow (ADR-170)", () => {
  it("routes a shared-window command to the focused detached window", () => {
    const main = fakeWindow() as never;
    const detached = fakeWindow() as never;
    const result = pickTargetWindow("new-tab", detached, main, [
      main,
      detached,
    ]);
    expect(result).toBe(detached);
  });

  it("routes a primary-only command to the main window even when a detached window is focused", () => {
    const main = fakeWindow() as never;
    const detached = fakeWindow() as never;
    const result = pickTargetWindow("new-workspace", detached, main, [
      main,
      detached,
    ]);
    expect(result).toBe(main);
  });

  it("routes to the main window when the focused window is not a tracked renderer window", () => {
    const main = fakeWindow() as never;
    const untracked = fakeWindow() as never;
    const result = pickTargetWindow("new-tab", untracked, main, [main]);
    expect(result).toBe(main);
  });

  it("returns null when there is no main window and the focused window doesn't qualify", () => {
    const result = pickTargetWindow("new-workspace", null, null, []);
    expect(result).toBeNull();
  });
});
