import { describe, expect, it } from "vitest";
import { CHAT_KINDS } from "../../../../src/lib/agent-chat";
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

  it("answers for exactly the kinds the renderer offers a chat", () => {
    for (const kind of ["claude", "codex", "pi", "opencode"] as const) {
      expect(adapterFor(kind) !== null).toBe(CHAT_KINDS.has(kind));
    }
  });
});
