import { describe, expect, it } from "vitest";
import { filePathFor, fileRoot, isOutsideWorkspace, pathInFileRoot } from "../file-location";

describe("filePathFor", () => {
  it("makes a path inside the workspace relative", () => {
    expect(filePathFor("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(filePathFor("/repo/", "/repo/./src//a.ts")).toBe("src/a.ts");
  });

  it("keeps a path outside it absolute and tidy", () => {
    expect(filePathFor("/repo", "/etc/hosts")).toBe("/etc/hosts");
    expect(filePathFor("/repo", "/repo/../etc//hosts")).toBe("/etc/hosts");
  });

  it("isn't fooled by a sibling folder sharing the workspace's prefix", () => {
    expect(filePathFor("/repo", "/repo-two/a.ts")).toBe("/repo-two/a.ts");
  });

  it("keeps the workspace folder itself absolute", () => {
    expect(filePathFor("/repo", "/repo")).toBe("/repo");
  });
});

describe("where a file is read from", () => {
  const workspace = { path: "/repo", hostId: "box" };

  it("reads a workspace file from its workspace", () => {
    expect(isOutsideWorkspace("src/a.ts")).toBe(false);
    expect(fileRoot(workspace, "src/a.ts")).toBe(workspace);
    expect(pathInFileRoot("src/a.ts")).toBe("src/a.ts");
  });

  it("reads any other from / on the same host", () => {
    expect(isOutsideWorkspace("/etc/hosts")).toBe(true);
    expect(fileRoot(workspace, "/etc/hosts")).toEqual({ path: "/", hostId: "box" });
    expect(pathInFileRoot("/etc/hosts")).toBe("etc/hosts");
  });
});
