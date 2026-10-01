import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ app: vi.fn(), detached: vi.fn() }));

vi.mock("../../App", () => {
  loaded.app();
  return { default: function App() {} };
});
vi.mock("../../DetachedApp", () => {
  loaded.detached();
  return { default: function DetachedApp() {} };
});

import { rootLoaderFor } from "../window-root";

describe("rootLoaderFor", () => {
  it("gives a detached popout its own root, without the primary app", async () => {
    // Importing the module loads neither root; only running a loader does.
    expect(loaded.detached).not.toHaveBeenCalled();

    const root = await rootLoaderFor(true)();

    expect(root.default.name).toBe("DetachedApp");
    expect(loaded.detached).toHaveBeenCalled();
    expect(loaded.app).not.toHaveBeenCalled();
  });

  it("gives the primary window the full app", async () => {
    const root = await rootLoaderFor(false)();

    expect(root.default.name).toBe("App");
  });
});
