/**
 * `stats.getSummary` and `stats.reset`, plus the debounced `stats.changed`
 * broadcast.
 *
 * No `ipcMain` here any more: `stats` crossed to the handler table in
 * ADR-180 ticket 7, so `statsGetSummary`/`statsReset` are plain functions
 * over `IpcDeps`, and the debounce subscription (`wireStatsBroadcast`) is
 * what is left of `register()` — wired once at boot rather than behind an
 * `ipcMain.handle`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { statsGetSummary, statsReset, wireStatsBroadcast, BROADCAST_DEBOUNCE_MS } from "../bridge/handlers/stats";
import { localCtx } from "../bridge/method";
import { StatsStore } from "../stats-store";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../renderer-broadcast";

describe("stats.getSummary / stats.reset", () => {
  it("stats.getSummary returns the store's summary", () => {
    const summary = { today: {}, last7Days: {}, allTime: {}, streakWeeks: 0, badges: {}, enabled: true };
    const statsStore = {
      getSummary: vi.fn().mockReturnValue(summary),
      reset: vi.fn(),
      onChange: vi.fn(() => () => {}),
    };

    expect(statsGetSummary(localCtx({ statsStore } as never))).toBe(summary);
  });

  it("stats.reset delegates to the store", () => {
    const statsStore = {
      getSummary: vi.fn(),
      reset: vi.fn(),
      onChange: vi.fn(() => () => {}),
    };

    statsReset(localCtx({ statsStore } as never));

    expect(statsStore.reset).toHaveBeenCalledTimes(1);
  });
});

describe("stats.changed broadcast (debounced)", () => {
  let tmpDir: string;
  let statsStore: StatsStore;
  let frames: RendererBroadcast[];
  let stopSink: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = path.join(os.tmpdir(), `manor-stats-ipc-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    statsStore = new StatsStore(tmpDir, { isEnabled: () => true });
    frames = [];
    stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
  });

  afterEach(() => {
    stopSink();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts exactly one stats.changed after the debounce settles", () => {
    wireStatsBroadcast({ statsStore });

    statsStore.record("prompts");
    statsStore.record("prompts");
    statsStore.record("toolCalls");

    vi.advanceTimersByTime(BROADCAST_DEBOUNCE_MS - 1);
    expect(frames).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(frames).toEqual([
      {
        ns: "stats",
        event: "changed",
        args: [statsStore.getSummary()],
        to: null,
      },
    ]);
  });

  it("collapses a burst of recording into a single broadcast", () => {
    wireStatsBroadcast({ statsStore });

    for (let i = 0; i < 5; i++) statsStore.record("prompts");
    vi.advanceTimersByTime(BROADCAST_DEBOUNCE_MS);

    expect(frames).toHaveLength(1);
  });
});
