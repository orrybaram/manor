import { describe, it, expect } from "vitest";
import { buildSettingsIndex, projectJumpId, searchSettings } from "./settings-search";

const index = buildSettingsIndex([
  { kind: "project", id: "p1", name: "manor" },
  { kind: "group", id: "g1", name: "retrograde" },
]);

const PAGE_IDS = [
  null,
  "project-general",
  "project-linear",
  "project-host",
  "project-agent",
  "project-commands",
];

const isProjectPage = (r: (typeof index)[number]) =>
  r.page.type === "project" || r.page.type === "group";

describe("buildSettingsIndex", () => {
  it("indexes a lone project's sections on its own page", () => {
    const ids = index
      .filter((e) => e.page.type === "project" && e.page.projectId === "p1")
      .map((e) => e.id);
    expect(ids).toEqual(PAGE_IDS);
  });

  it("indexes a group's sections on the group page, in the same order", () => {
    const entries = index.filter(
      (e) => e.page.type === "group" && e.page.groupId === "g1",
    );
    expect(entries.map((e) => e.id)).toEqual(PAGE_IDS);
    expect(new Set(entries.map((e) => e.pageLabel))).toEqual(
      new Set(["retrograde"]),
    );
  });

  it("indexes no per-host pages (ADR-237 D1)", () => {
    expect(
      index.some((e) => e.page.type === "project" && e.page.projectId !== "p1"),
    ).toBe(false);
  });

  it("indexes the fixed pages", () => {
    expect(
      index.some((e) => e.id === null && e.page.type === "hosts"),
    ).toBe(true);
    expect(
      index.some((e) => e.id === "app-theme" && e.page.type === "app"),
    ).toBe(true);
  });
});

describe("searchSettings", () => {
  it.each(["worktree", "port", "separate"])(
    "sends %s to each project's Hosts section",
    (query) => {
      const hits = searchSettings(index, query).filter(isProjectPage);
      expect(hits.map((r) => r.id)).toEqual(["project-host", "project-host"]);
      expect(hits.map((r) => r.page)).toEqual([
        { type: "project", projectId: "p1" },
        { type: "group", groupId: "g1" },
      ]);
    },
  );

  it("sends a group's commands to the group page", () => {
    const hits = searchSettings(index, "commands").filter(
      (r) => r.id === "project-commands",
    );
    expect(hits.map((r) => r.page)).toEqual([
      { type: "project", projectId: "p1" },
      { type: "group", groupId: "g1" },
    ]);
  });

  it("ranks a label prefix above a keyword match", () => {
    const results = searchSettings(index, "font");
    expect(results[0]).toMatchObject({ id: "app-font" });
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings(index, "   ")).toEqual([]);
  });
});

describe("projectJumpId", () => {
  it("lands a grouped project's host link on its own row", () => {
    expect(projectJumpId("project-host", "m1", true)).toBe("project-host-m1");
  });

  it("names the section itself otherwise", () => {
    expect(projectJumpId("project-host", "p1", false)).toBe("project-host");
    expect(projectJumpId("project-agent", "m1", true)).toBe("project-agent");
  });

  it("has no jump without a section", () => {
    expect(projectJumpId(null, "m1", true)).toBeNull();
  });
});
