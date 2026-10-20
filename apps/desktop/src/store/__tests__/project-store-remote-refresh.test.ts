import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REMOTE_REFRESH_MIN_INTERVAL,
  useProjectStore,
  type ProjectInfo,
} from "../project-store";
import { makeProject } from "../../test-utils/fixtures";

// A window focus re-lists only remote projects' worktrees (#303): local
// ones are kept current by main's worktree watcher.

const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  getRemote: vi.fn(),
};

vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

function project(id: string, hostId: string, branch = "main"): ProjectInfo {
  return makeProject({
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    workspaces: [{ path: `/code/${id}`, branch, isMain: true, name: null }],
  });
}

// The throttle is module state: each test starts well past the last refresh.
let now = 0;

beforeEach(() => {
  vi.clearAllMocks();
  now += 10 * REMOTE_REFRESH_MIN_INTERVAL;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshRemoteProjects", () => {
  it("asks main for nothing when every project is local", async () => {
    useProjectStore.setState({ projects: [project("a", "local")] });
    await useProjectStore.getState().refreshRemoteProjects();
    expect(api.getRemote).not.toHaveBeenCalled();
    expect(api.getAll).not.toHaveBeenCalled();
  });

  it("replaces only the remote projects, leaving local ones as they are", async () => {
    const local = project("a", "local");
    useProjectStore.setState({ projects: [local, project("b", "box")] });
    api.getRemote.mockResolvedValue([project("b", "box", "feat")]);

    await useProjectStore.getState().refreshRemoteProjects();

    const { projects } = useProjectStore.getState();
    expect(projects[0]).toBe(local);
    expect(projects[1].workspaces[0].branch).toBe("feat");
    expect(api.getAll).not.toHaveBeenCalled();
  });

  it("refreshes at most once per minimum interval, sharing a running one", async () => {
    useProjectStore.setState({ projects: [project("b", "box")] });
    api.getRemote.mockResolvedValue([project("b", "box")]);
    const { refreshRemoteProjects } = useProjectStore.getState();

    await Promise.all([refreshRemoteProjects(), refreshRemoteProjects()]);
    now += REMOTE_REFRESH_MIN_INTERVAL - 1;
    await refreshRemoteProjects();
    expect(api.getRemote).toHaveBeenCalledTimes(1);

    now += 1;
    await refreshRemoteProjects();
    expect(api.getRemote).toHaveBeenCalledTimes(2);
  });

  it("keeps the projects when main fails", async () => {
    const before = [project("b", "box")];
    useProjectStore.setState({ projects: before });
    api.getRemote.mockRejectedValue(new Error("host away"));

    await useProjectStore.getState().refreshRemoteProjects();
    expect(useProjectStore.getState().projects).toBe(before);
  });
});
