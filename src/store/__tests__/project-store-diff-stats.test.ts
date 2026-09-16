import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../project-store";

const WS_PATH = "/tmp/wt/feature";

describe("updateWorkspaceDiffStats", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        {
          path: "/tmp/repo",
          name: "app",
          workspaces: [
            {
              path: WS_PATH,
              name: "feature",
              branch: "feature",
              diffStats: { added: 3, removed: 1 },
            },
          ],
        },
      ],
    } as any);
  });

  // useDiffWatcher re-applies cached stats whenever `projects` changes, so a
  // no-op update must keep the same reference or it loops forever.
  it("keeps the projects reference when stats are unchanged", () => {
    const before = useProjectStore.getState().projects;
    useProjectStore
      .getState()
      .updateWorkspaceDiffStats(WS_PATH, { added: 3, removed: 1 });
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("treats missing and null stats as equal", () => {
    useProjectStore.getState().updateWorkspaceDiffStats(WS_PATH, null);
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().updateWorkspaceDiffStats("/tmp/other", null);
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("stores changed stats", () => {
    useProjectStore
      .getState()
      .updateWorkspaceDiffStats(WS_PATH, { added: 5, removed: 0 });
    const ws = useProjectStore.getState().projects[0].workspaces[0];
    expect(ws.diffStats).toEqual({ added: 5, removed: 0 });
  });
});
