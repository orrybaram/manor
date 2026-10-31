// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { removeWorktreeWithToast } = vi.hoisted(() => ({ removeWorktreeWithToast: vi.fn(async () => true) }));
vi.mock("../../store/workspace-actions", () => ({ removeWorktreeWithToast }));
vi.mock("../../toast", () => ({ toast: { success: vi.fn(), info: vi.fn() } }));

import { deleteWorkspaceWhenMerged, isDeletingWhenMerged, settleMergeCleanup } from "../merge-cleanup";
import { workspaceKey } from "../workspace-key";
import type { ProjectInfo, WorkspaceInfo } from "../../store/project-store";
import type { PrInfo } from "../pr-info";

const project = { id: "p", hostId: "local" } as unknown as ProjectInfo;
const ws = { path: "/wt/feature", branch: "feature", name: "", isMain: false } as unknown as WorkspaceInfo;
const key = workspaceKey("local", ws.path);
const URL_ = "https://github.com/acme/app/pull/9";
const pr = (state: string, url = URL_) => ({ number: 9, state, title: "t", url }) as PrInfo;

describe("settleMergeCleanup", () => {
  beforeEach(() => {
    localStorage.clear();
    removeWorktreeWithToast.mockClear();
  });

  it("removes the workspace once its queued PR merges, and only once", () => {
    deleteWorkspaceWhenMerged(key, URL_);
    settleMergeCleanup(project, ws, pr("open"));
    expect(removeWorktreeWithToast).not.toHaveBeenCalled();
    settleMergeCleanup(project, ws, pr("merged"));
    expect(removeWorktreeWithToast).toHaveBeenCalledWith(project, ws, true);
    expect(isDeletingWhenMerged(key)).toBe(false);
    settleMergeCleanup(project, ws, pr("merged"));
    expect(removeWorktreeWithToast).toHaveBeenCalledTimes(1);
  });

  it("forgets the request when the PR closes unmerged", () => {
    deleteWorkspaceWhenMerged(key, URL_);
    settleMergeCleanup(project, ws, pr("closed"));
    expect(removeWorktreeWithToast).not.toHaveBeenCalled();
    expect(isDeletingWhenMerged(key)).toBe(false);
  });

  it("ignores a different PR on the same branch", () => {
    deleteWorkspaceWhenMerged(key, URL_);
    settleMergeCleanup(project, ws, pr("merged", "https://github.com/acme/app/pull/10"));
    expect(removeWorktreeWithToast).not.toHaveBeenCalled();
    expect(isDeletingWhenMerged(key)).toBe(true);
  });
});
