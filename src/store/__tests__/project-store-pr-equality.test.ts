import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../project-store";
import type { PrInfo } from "../../lib/pr-info";

const WS_PATH = "/tmp/wt/feature";

function basePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    state: "open",
    title: "Rotate signing keys",
    url: "https://github.com/acme/app/pull/42",
    isDraft: false,
    additions: 10,
    deletions: 2,
    reviewDecision: "APPROVED",
    checks: { total: 2, passing: 2, failing: 0, pending: 0 },
    unresolvedThreads: 0,
    commentCount: 0,
    ...overrides,
  };
}

function currentPr(): PrInfo | null | undefined {
  const project = useProjectStore.getState().projects[0];
  return project.workspaces.find((ws) => ws.path === WS_PATH)?.pr;
}

describe("updateWorkspacePr", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        {
          path: "/tmp/repo",
          name: "app",
          workspaces: [
            { path: WS_PATH, name: "feature", branch: "feature", pr: basePr() },
          ],
        },
      ],
    } as any);
  });

  // Arming auto-merge changes nothing else about the PR, so an equality check
  // that skips `queuedToMerge` drops the update and the badge never turns.
  it("stores a PR that only became queued to merge", () => {
    useProjectStore
      .getState()
      .updateWorkspacePr(WS_PATH, basePr({ queuedToMerge: true }));

    expect(currentPr()?.queuedToMerge).toBe(true);
  });

  it("skips an update that changes nothing", () => {
    const before = currentPr();
    useProjectStore.getState().updateWorkspacePr(WS_PATH, basePr());
    expect(currentPr()).toBe(before);
  });
});
