import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { PR_FOCUS_MIN_INTERVAL, fetchPrs, refreshPrsOnFocus } from "../usePrWatcher";
import { makeProject } from "../../test-utils/fixtures";

// PR refreshes (#303): one at a time, and window focus at most once per
// minimum interval.

const getPrsForBranches = vi.fn();

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    ...(globalThis.window as { electronAPI?: object }).electronAPI,
    github: { getPrsForBranches },
  },
});

function project(id: string, branches: string[]): ProjectInfo {
  return makeProject({
    id,
    name: id,
    path: `/code/${id}`,
    workspaces: [
      { path: `/code/${id}`, branch: "main", isMain: true, name: null },
      ...branches.map((branch) => ({
        path: `/code/${id}-${branch}`,
        branch,
        isMain: false,
        name: null,
      })),
    ],
  });
}

// The throttle is module state: each test starts well past the last refresh.
let now = 0;

beforeEach(() => {
  getPrsForBranches.mockReset();
  getPrsForBranches.mockImplementation(async (_repo, branches: string[]) =>
    branches.map((b) => [b, null]),
  );
  now += 10 * PR_FOCUS_MIN_INTERVAL;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  useProjectStore.setState({ projects: [project("a", ["x", "y", "z"]), project("b", ["w"])] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchPrs", () => {
  it("asks main once per project, with every tracked branch", async () => {
    await fetchPrs();
    expect(getPrsForBranches.mock.calls.map(([repo, branches]) => [repo.path, branches])).toEqual([
      ["/code/a", ["x", "y", "z"]],
      ["/code/b", ["w"]],
    ]);
  });

  it("joins a refresh already running rather than starting another", async () => {
    await Promise.all([fetchPrs(), fetchPrs(), fetchPrs()]);
    expect(getPrsForBranches).toHaveBeenCalledTimes(2);
  });
});

describe("refreshPrsOnFocus", () => {
  it("refreshes at most once per minimum interval however often focus comes", async () => {
    expect(refreshPrsOnFocus()).toBe(true);
    await fetchPrs();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      expect(refreshPrsOnFocus()).toBe(false);
    }
    expect(getPrsForBranches).toHaveBeenCalledTimes(2);

    now += PR_FOCUS_MIN_INTERVAL;
    expect(refreshPrsOnFocus()).toBe(true);
    await fetchPrs();
    expect(getPrsForBranches).toHaveBeenCalledTimes(4);
  });

  it("counts any recent refresh, not just a focus one", async () => {
    await fetchPrs();
    now += 1000;
    expect(refreshPrsOnFocus()).toBe(false);
  });
});
