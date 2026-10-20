// @vitest-environment jsdom
/**
 * Before the first connection a skeleton covers the app, and the
 * not-reachable screen replaces it only if that takes a while, so a cold
 * start that needs a redial or two reads as loading. After it, a drop is a
 * small pill over the app, shown only once the page has stayed unreachable
 * for a moment, so a redial after the phone wakes does not flash it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import {
  FIRST_CONNECT_SHOW_AFTER_MS,
  ReachabilityOverlay,
  UNREACHABLE_SHOW_AFTER_MS,
} from "../screens";

type Status = "unknown" | "connected" | "unreachable";

describe("ReachabilityOverlay", () => {
  let status: Status;
  const listeners = new Set<() => void>();
  const set = (next: Status) =>
    act(() => {
      status = next;
      for (const cb of listeners) cb();
    });
  let container: HTMLDivElement;
  let root: Root;
  const shown = () => document.querySelector('[data-testid="web-app-unreachable"]') !== null;
  const reconnecting = () =>
    document.querySelector('[data-testid="web-app-reconnecting"]') !== null;
  const loading = () => document.querySelector('[data-testid="web-app-connecting"]') !== null;

  beforeEach(() => {
    vi.useFakeTimers();
    status = "unknown";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(ReachabilityOverlay, {
          subscribe: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
          getSnapshot: () => status,
          onRetry: () => {},
        }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows a skeleton until the first connection", () => {
    expect(loading()).toBe(true);
    set("connected");
    expect(loading()).toBe(false);
  });

  it("reads a cold start's early misses as loading", () => {
    set("unreachable");
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_SHOW_AFTER_MS - 1));
    expect(loading()).toBe(true);
    expect(shown()).toBe(false);
    set("connected");
    expect(loading()).toBe(false);
    expect(shown()).toBe(false);
  });

  it("gives up on loading when the first connection never comes", () => {
    set("unreachable");
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_SHOW_AFTER_MS));
    expect(shown()).toBe(true);
    expect(loading()).toBe(false);
  });

  it("shows a drop as a pill, not a screen, after a moment", () => {
    set("connected");
    set("unreachable");
    expect(reconnecting()).toBe(false);
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS));
    expect(reconnecting()).toBe(true);
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_SHOW_AFTER_MS));
    expect(shown()).toBe(false);
    expect(loading()).toBe(false);
    set("connected");
    expect(reconnecting()).toBe(false);
  });

  it("never shows for a drop that redials in time", () => {
    set("connected");
    set("unreachable");
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS - 1));
    set("connected");
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS));
    expect(reconnecting()).toBe(false);
  });
});
