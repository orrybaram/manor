import { describe, expect, it } from "vitest";
import {
  crumbFolder,
  filterEntries,
  folderEntries,
  parentFolder,
  startIndex,
} from "./breadcrumb-picker";

const paths = [
  "README.md",
  "apps/aura/src/lib/chat/metrics.ts",
  "apps/aura/src/lib/chat/datadog-client.ts",
  "apps/aura/src/lib/chat/Send.ts",
  "apps/aura/src/lib/chat/util/fmt.ts",
  "apps/aura/package.json",
  "apps/web/index.ts",
  "Zeta/a.ts",
  ".gitignore",
];

describe("crumbFolder", () => {
  const parts = ["apps", "aura", "src", "main.ts"];
  it("opens a folder segment on that folder", () => {
    expect(crumbFolder(parts, 0)).toBe("apps");
    expect(crumbFolder(parts, 2)).toBe("apps/aura/src");
  });
  it("opens the file's segment on the file's folder", () => {
    expect(crumbFolder(parts, 3)).toBe("apps/aura/src");
    expect(crumbFolder(["main.ts"], 0)).toBe("");
  });
});

describe("parentFolder", () => {
  it("steps up a level, and not above the root", () => {
    expect(parentFolder("apps/aura")).toBe("apps");
    expect(parentFolder("apps")).toBe("");
    expect(parentFolder("")).toBeNull();
  });
});

describe("folderEntries", () => {
  it("lists a folder's own entries, folders first, each alphabetically", () => {
    expect(folderEntries(paths, "apps/aura/src/lib/chat")).toEqual([
      { kind: "dir", name: "util", path: "apps/aura/src/lib/chat/util" },
      {
        kind: "file",
        name: "datadog-client.ts",
        path: "apps/aura/src/lib/chat/datadog-client.ts",
      },
      {
        kind: "file",
        name: "metrics.ts",
        path: "apps/aura/src/lib/chat/metrics.ts",
      },
      { kind: "file", name: "Send.ts", path: "apps/aura/src/lib/chat/Send.ts" },
    ]);
  });
  it("lists the root", () => {
    expect(folderEntries(paths, "").map((e) => e.name)).toEqual([
      "apps",
      "Zeta",
      ".gitignore",
      "README.md",
    ]);
  });
  it("doesn't take a sibling with the same prefix for a child", () => {
    expect(folderEntries(["app/a.ts", "apps/b.ts"], "app")).toEqual([
      { kind: "file", name: "a.ts", path: "app/a.ts" },
    ]);
  });
  it("is empty for a folder it doesn't know", () => {
    expect(folderEntries(paths, "nope")).toEqual([]);
  });
});

describe("filterEntries", () => {
  const entries = folderEntries(paths, "apps/aura/src/lib/chat");
  it("keeps names holding the query, ignoring case", () => {
    expect(filterEntries(entries, "ICS").map((e) => e.name)).toEqual([
      "metrics.ts",
    ]);
  });
  it("keeps everything for an empty query", () => {
    expect(filterEntries(entries, "  ")).toHaveLength(entries.length);
  });
});

describe("startIndex", () => {
  const root = folderEntries(paths, "apps/aura");
  it("starts on the folder on the way to the open file", () => {
    expect(
      root[startIndex(root, "apps/aura/src/lib/chat/metrics.ts")].name,
    ).toBe("src");
  });
  it("starts on the open file itself", () => {
    const chat = folderEntries(paths, "apps/aura/src/lib/chat");
    expect(
      chat[startIndex(chat, "apps/aura/src/lib/chat/metrics.ts")].name,
    ).toBe("metrics.ts");
  });
  it("starts at the top otherwise", () => {
    expect(startIndex(root, "elsewhere.ts")).toBe(0);
    expect(startIndex(root, null)).toBe(0);
  });
});
