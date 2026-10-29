import { describe, expect, it } from "vitest";
import { matchesAgentQuery, matchesQueryWords } from "../agent-query";

describe("matchesQueryWords", () => {
  it("needs every word, in any field, ignoring case", () => {
    expect(matchesQueryWords(["Fix the relay", null, "/code/manor"], "relay MANOR")).toBe(true);
    expect(matchesQueryWords(["Fix the relay", undefined], "relay toast")).toBe(false);
  });

  it("matches anything with an empty query", () => {
    expect(matchesQueryWords([], "  ")).toBe(true);
  });
});

describe("matchesAgentQuery", () => {
  it("searches name, project name and workspace path", () => {
    const agent = { name: "Toast deck", projectName: "manor", workspacePath: "/w/toast-rebuild" };
    expect(matchesAgentQuery(agent, "deck manor rebuild")).toBe(true);
    expect(matchesAgentQuery(agent, "relay")).toBe(false);
  });
});
