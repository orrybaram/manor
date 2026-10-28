import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `window-focus` starts once per module instance, so each case loads a fresh one.
async function load() {
  vi.resetModules();
  return import("../window-focus");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("window focus on the desktop", () => {
  let push: (focused: boolean) => void;
  let answer: (focused: boolean) => void;

  beforeEach(() => {
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...window.electronAPI,
        platform: "electron",
        window: {
          isFocused: () => new Promise<boolean>((resolve) => (answer = resolve)),
          onFocusChanged: (cb: (focused: boolean) => void) => {
            push = cb;
            return () => {};
          },
        },
      },
    });
  });

  it("takes main's initial answer, then its pushes", async () => {
    const focus = await load();
    const heard: boolean[] = [];
    focus.onWindowFocusChange((f) => heard.push(f));
    expect(focus.isWindowFocused()).toBe(true);

    answer(false);
    await Promise.resolve();
    expect(focus.isWindowFocused()).toBe(false);

    push(true);
    expect(focus.isWindowFocused()).toBe(true);
    expect(heard).toEqual([false, true]);
  });

  it("ignores an initial answer that arrives after a push", async () => {
    const focus = await load();
    expect(focus.isWindowFocused()).toBe(true);
    push(false);
    answer(true);
    await Promise.resolve();
    expect(focus.isWindowFocused()).toBe(false);
  });
});

describe("window focus in a browser", () => {
  it("follows window focus/blur and page visibility", async () => {
    const winListeners = new Map<string, () => void>();
    const docListeners = new Map<string, () => void>();
    const doc = {
      visibilityState: "visible",
      hasFocus: () => true,
      addEventListener: (type: string, cb: () => void) => docListeners.set(type, cb),
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", {
      ...window,
      electronAPI: { ...window.electronAPI, platform: "web" },
      addEventListener: (type: string, cb: () => void) => winListeners.set(type, cb),
    });

    const focus = await load();
    expect(focus.isWindowFocused()).toBe(true);

    winListeners.get("blur")?.();
    expect(focus.isWindowFocused()).toBe(false);
    winListeners.get("focus")?.();
    expect(focus.isWindowFocused()).toBe(true);

    doc.visibilityState = "hidden";
    docListeners.get("visibilitychange")?.();
    expect(focus.isWindowFocused()).toBe(false);
  });
});
