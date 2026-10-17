// @vitest-environment jsdom
/**
 * The not-reachable screen covers the app only once the page has stayed
 * unreachable for a moment, so a redial after the phone wakes, or a slow
 * load, does not flash it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { ReachabilityOverlay, UNREACHABLE_SHOW_AFTER_MS } from "../screens";

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

  it("waits before covering the app", () => {
    set("unreachable");
    expect(shown()).toBe(false);
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS));
    expect(shown()).toBe(true);
    set("connected");
    expect(shown()).toBe(false);
  });

  it("never shows for a drop that redials in time", () => {
    set("unreachable");
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS - 1));
    set("connected");
    act(() => vi.advanceTimersByTime(UNREACHABLE_SHOW_AFTER_MS));
    expect(shown()).toBe(false);
  });
});
