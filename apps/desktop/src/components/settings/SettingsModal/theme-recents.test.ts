import { describe, expect, it } from "vitest";
import { keptThemePicks } from "./theme-recents";

describe("keptThemePicks", () => {
  it("counts the global theme left selected, not the ones browsed past", () => {
    // Clicking Dracula, then Nord, then closing on Nord: only Nord changed.
    expect(
      keptThemePicks({ global: "a", projects: {} }, { global: "Nord", projects: {} }),
    ).toEqual(["Nord"]);
  });

  it("counts nothing when Settings closes on the theme it opened with", () => {
    expect(
      keptThemePicks(
        { global: "a", projects: { p: "b" } },
        { global: "a", projects: { p: "b" } },
      ),
    ).toEqual([]);
  });

  it("counts a project's new theme, but not a switch back to the global one", () => {
    expect(
      keptThemePicks(
        { global: "a", projects: { p: null, q: "x" } },
        { global: "a", projects: { p: "b", q: null } },
      ),
    ).toEqual(["b"]);
  });

  it("puts the global pick last, so it lands newest", () => {
    expect(
      keptThemePicks(
        { global: "a", projects: { p: null } },
        { global: "g", projects: { p: "g" } },
      ),
    ).toEqual(["g"]);
    expect(
      keptThemePicks(
        { global: "a", projects: { p: null } },
        { global: "g", projects: { p: "b" } },
      ),
    ).toEqual(["b", "g"]);
  });
});
