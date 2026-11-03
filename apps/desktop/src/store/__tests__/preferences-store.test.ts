// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

type Prefs = Record<string, unknown>;

/** The store over a fake main process whose writes answer only when told. */
async function storeOverSlowMain() {
  vi.resetModules();
  const answers: (() => void)[] = [];
  let push: (prefs: Prefs) => void = () => {};
  const remote: Prefs = { defaultEditor: "", chatFontFamily: "" };
  window.electronAPI = {
    preferences: {
      getAll: async () => ({ ...remote }),
      onChange: (cb: (prefs: Prefs) => void) => {
        push = cb;
        return () => {};
      },
      set: (key: string, value: unknown) => {
        remote[key] = value;
        return new Promise<void>((resolve) => answers.push(resolve));
      },
    },
  } as unknown as typeof window.electronAPI;
  const { usePreferencesStore } = await import("../preferences-store");
  return {
    store: usePreferencesStore,
    answers,
    push: (prefs: Prefs) => push(prefs),
    remote,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe("preferences store", () => {
  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it("keeps a later keystroke when main's answer to an earlier one arrives", async () => {
    const { store, answers, push, remote } = await storeOverSlowMain();
    await flush();
    store.getState().set("defaultEditor", "c");
    store.getState().set("defaultEditor", "co");
    push({ ...remote, defaultEditor: "c" });
    expect(store.getState().preferences.defaultEditor).toBe("co");

    // Other keys still come through while that write is out.
    push({ ...remote, defaultEditor: "c", chatFontFamily: "Inter" });
    expect(store.getState().preferences.chatFontFamily).toBe("Inter");

    // Once every write is answered, main is the truth again.
    answers.forEach((answer) => answer());
    await flush();
    push({ ...remote, defaultEditor: "code" });
    expect(store.getState().preferences.defaultEditor).toBe("code");
  });
});
