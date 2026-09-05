import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { register, BROADCAST_DEBOUNCE_MS } from "../ipc/stats";
import { StatsStore } from "../stats-store";

function makeWindow() {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn(),
    },
  };
}

describe("stats:getSummary / stats:reset handlers", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("stats:getSummary returns the store's summary", () => {
    const summary = { today: {}, last7Days: {}, allTime: {}, streakDays: 0, badges: {}, enabled: true };
    const statsStore = {
      getSummary: vi.fn().mockReturnValue(summary),
      reset: vi.fn(),
      onChange: vi.fn(() => () => {}),
    };

    register({ statsStore, getRendererWindows: () => [] } as never);

    const handler = handlers.get("stats:getSummary")!;
    expect(handler()).toBe(summary);
  });

  it("stats:reset delegates to the store", () => {
    const statsStore = {
      getSummary: vi.fn(),
      reset: vi.fn(),
      onChange: vi.fn(() => () => {}),
    };

    register({ statsStore, getRendererWindows: () => [] } as never);

    const handler = handlers.get("stats:reset")!;
    handler();

    expect(statsStore.reset).toHaveBeenCalledTimes(1);
  });
});

describe("stats:changed broadcast (debounced)", () => {
  let tmpDir: string;
  let statsStore: StatsStore;

  beforeEach(() => {
    handlers.clear();
    vi.useFakeTimers();
    tmpDir = path.join(os.tmpdir(), `manor-stats-ipc-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    statsStore = new StatsStore(tmpDir, { isEnabled: () => true });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends exactly one stats:changed per live window after the debounce settles", () => {
    const win1 = makeWindow();
    const win2 = makeWindow();

    register({
      statsStore,
      getRendererWindows: () => [win1, win2],
    } as never);

    statsStore.record("prompts");
    statsStore.record("prompts");
    statsStore.record("toolCalls");

    // Still within the debounce window: nothing sent yet.
    vi.advanceTimersByTime(BROADCAST_DEBOUNCE_MS - 1);
    expect(win1.webContents.send).not.toHaveBeenCalled();
    expect(win2.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(win1.webContents.send).toHaveBeenCalledTimes(1);
    expect(win1.webContents.send).toHaveBeenCalledWith(
      "stats:changed",
      statsStore.getSummary(),
    );
    expect(win2.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("skips destroyed windows", () => {
    const live = makeWindow();
    const destroyed = makeWindow();
    destroyed.isDestroyed.mockReturnValue(true);

    register({
      statsStore,
      getRendererWindows: () => [live, destroyed],
    } as never);

    statsStore.record("prompts");
    vi.advanceTimersByTime(BROADCAST_DEBOUNCE_MS);

    expect(live.webContents.send).toHaveBeenCalledTimes(1);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});
