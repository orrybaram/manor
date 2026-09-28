import { describe, it, expect } from "vitest";
import { buildSettingsIndex, searchSettings } from "./settings-search";

const index = buildSettingsIndex([
  { kind: "project", id: "p1", name: "manor" },
  {
    kind: "group",
    id: "g1",
    name: "retrograde",
    members: [
      { id: "m1", hostId: "ssh:blade", hostLabel: "blade" },
      { id: "m2", hostId: "local", hostLabel: "This machine" },
    ],
  },
]);

describe("buildSettingsIndex", () => {
  it("indexes a lone project's sections on its own page", () => {
    const ids = index
      .filter((e) => e.page.type === "project" && e.page.projectId === "p1")
      .map((e) => e.id);
    expect(ids).toEqual([
      null,
      "project-general",
      "project-linear",
      "project-host",
      "project-agent",
      "project-ports",
      "project-commands",
      "project-worktrees",
      "project-links",
    ]);
  });

  it("indexes a group's shared sections on the group page", () => {
    const entries = index.filter(
      (e) => e.page.type === "group" && e.page.groupId === "g1",
    );
    expect(entries.map((e) => e.id)).toEqual([
      null,
      "project-general",
      "project-linear",
      "project-agent",
      "project-commands",
      "project-links",
    ]);
    expect(new Set(entries.map((e) => e.pageLabel))).toEqual(
      new Set(["retrograde"]),
    );
  });

  it("indexes machine sections on each member page, labeled by host", () => {
    for (const [id, label] of [
      ["m1", "retrograde · blade"],
      ["m2", "retrograde · This machine"],
    ]) {
      const entries = index.filter(
        (e) => e.page.type === "project" && e.page.projectId === id,
      );
      expect(entries.map((e) => e.id)).toEqual([
        null,
        "project-location",
        "project-host",
        "project-worktrees",
        "project-ports",
      ]);
      expect(new Set(entries.map((e) => e.pageLabel))).toEqual(new Set([label]));
    }
  });
});

describe("searchSettings", () => {
  it("finds a member's host section by its host name", () => {
    const results = searchSettings(index, "blade");
    expect(results[0]).toMatchObject({
      id: null,
      page: { type: "project", projectId: "m1" },
    });
    expect(
      results.some(
        (r) =>
          r.id === "project-host" &&
          r.page.type === "project" &&
          r.page.projectId === "m1",
      ),
    ).toBe(true);
  });

  it("sends a group's commands to the group page", () => {
    const hits = searchSettings(index, "commands").filter(
      (r) => r.id === "project-commands",
    );
    expect(hits.map((r) => r.page)).toEqual([
      { type: "project", projectId: "p1" },
      { type: "group", groupId: "g1" },
    ]);
  });
});
