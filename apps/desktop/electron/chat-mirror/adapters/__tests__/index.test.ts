import { describe, expect, it } from "vitest";
import { adapterFor } from "../index";
import { claudeAdapter } from "../claude";

describe("adapterFor", () => {
  it("resolves claude", () => {
    expect(adapterFor("claude")).toBe(claudeAdapter);
  });

  it("has no adapter for the other agents yet", () => {
    expect(adapterFor("codex")).toBeNull();
    expect(adapterFor("opencode")).toBeNull();
    expect(adapterFor("pi")).toBeNull();
  });
});
