import { describe, it, expect } from "vitest";
import { memoryTracker } from "./memory";
import { toRow } from "./github";
import type { TaskContext } from "../tasks";
import type { GitHubIssue } from "../../electron.d";
import type { ProjectInfo } from "../../store/project-store";

const ctx: TaskContext = {
  entryKey: "p1",
  project: { id: "p1" } as ProjectInfo,
  projectName: "manor",
  color: null,
};

const row = toRow(
  {
    number: 12,
    title: "Fix the thing",
    url: "https://github.com/acme/manor/issues/12",
  } as GitHubIssue,
  ctx,
);

describe("memoryTracker", () => {
  const tracker = memoryTracker("github", [row]);

  it("lists the given rows of its provider and entry", async () => {
    await expect(tracker.listQuery(ctx, "open").queryFn()).resolves.toEqual([
      row,
    ]);
    await expect(
      tracker.listQuery({ ...ctx, entryKey: "p2" }, "open").queryFn(),
    ).resolves.toEqual([]);
    await expect(
      memoryTracker("linear", [row]).listQuery(ctx, "open").queryFn(),
    ).resolves.toEqual([]);
  });

  it("matches links by URL", () => {
    const link = { id: "gh-12", identifier: "#12", title: "", url: row.url };
    expect(tracker.ownsLink(link)).toBe(true);
    expect(tracker.matchesLink(link, row)).toBe(true);
    expect(tracker.matchesLink({ ...link, url: "" }, row)).toBe(false);
  });
});
