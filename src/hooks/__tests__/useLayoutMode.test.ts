// @vitest-environment jsdom
/**
 * ADR-181 D2: `useLayoutMode()` is the one hook every phone-mode reader
 * consults — width decides, a detached window is the one exception.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_MAX_WIDTH, useLayoutMode } from "../useLayoutMode";

/** A stubbed `MediaQueryList` whose `matches` a test can flip by hand. */
class FakeMediaQueryList {
  matches: boolean;
  private listeners = new Set<() => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "change") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "change") this.listeners.delete(listener);
  }

  /** Flips `matches` and notifies every subscriber, as a real MQL would. */
  set(matches: boolean): void {
    this.matches = matches;
    this.listeners.forEach((listener) => listener());
  }
}

/** One `matchMedia` stub, sharing a single live MQL per query string. */
function stubMatchMedia(initialMatches: boolean) {
  const mql = new FakeMediaQueryList(initialMatches);
  const matchMedia = vi.fn().mockReturnValue(mql);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: matchMedia,
  });
  return mql;
}

/** A detached window is one holding a claim; the primary holds none. */
function stubDetached(isDetached: boolean) {
  Object.defineProperty(window, "electronAPI", {
    writable: true,
    configurable: true,
    value: {
      claim: isDetached ? { workspacePath: "/w", tabId: "tab-1" } : null,
    },
  });
}

let container: HTMLDivElement;
let root: Root;

/** Renders `useLayoutMode()`'s answer as text, so a test reads it from the DOM. */
function Probe() {
  return createElement("div", null, useLayoutMode());
}

/** Mounts `useLayoutMode()` and returns a getter for its current answer. */
function mountHook(): () => string {
  act(() => {
    root.render(createElement(Probe));
  });
  return () => container.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("useLayoutMode", () => {
  it("uses the ADR-178 D9 breakpoint of ~768px", () => {
    expect(PHONE_MAX_WIDTH).toBe(767);
  });

  it("is phone when the query matches and the window is not detached", () => {
    stubMatchMedia(true);
    stubDetached(false);
    const mode = mountHook();
    expect(mode()).toBe("phone");
  });

  it("is desk when the query does not match", () => {
    stubMatchMedia(false);
    stubDetached(false);
    const mode = mountHook();
    expect(mode()).toBe("desk");
  });

  it("stays desk when narrow but the window is detached", () => {
    stubMatchMedia(true);
    stubDetached(true);
    const mode = mountHook();
    expect(mode()).toBe("desk");
  });

  it("flips when the media query's change event fires", () => {
    const mql = stubMatchMedia(false);
    stubDetached(false);
    const mode = mountHook();
    expect(mode()).toBe("desk");

    act(() => {
      mql.set(true);
    });
    expect(mode()).toBe("phone");

    act(() => {
      mql.set(false);
    });
    expect(mode()).toBe("desk");
  });

  it("mirrors the mode onto <html data-layout> for portaled UI, and follows it", () => {
    // A Radix portal mounts under <body>, outside `.app`, so the command
    // palette's phone CSS keys off `:root[data-layout]` — which only works if
    // this attribute tracks the same answer the hook gives.
    const mql = stubMatchMedia(true);
    stubDetached(false);
    mountHook();
    expect(document.documentElement.dataset.layout).toBe("phone");

    act(() => {
      mql.set(false);
    });
    expect(document.documentElement.dataset.layout).toBe("desk");
  });

  it("mirrors desk onto <html> for a narrow detached window", () => {
    stubMatchMedia(true);
    stubDetached(true);
    mountHook();
    expect(document.documentElement.dataset.layout).toBe("desk");
  });

  it("unsubscribes from the media query on unmount", () => {
    const mql = stubMatchMedia(false);
    stubDetached(false);
    mountHook();
    act(() => {
      root.unmount();
    });
    // No listener left to notify; flipping after unmount must not throw.
    expect(() => mql.set(true)).not.toThrow();
  });
});
