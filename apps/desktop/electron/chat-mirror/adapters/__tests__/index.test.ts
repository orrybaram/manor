import { describe, expect, it } from "vitest";
import { CHAT_KINDS } from "../../../../src/lib/agent-chat";
import { adapterFor } from "../index";
import { claudeAdapter } from "../claude";
import { piAdapter } from "../pi";

describe("adapterFor", () => {
  it("resolves claude and pi", () => {
    expect(adapterFor("claude")).toBe(claudeAdapter);
    expect(adapterFor("pi")).toBe(piAdapter);
  });

  it("has no adapter for the other agents yet", () => {
    expect(adapterFor("codex")).toBeNull();
    expect(adapterFor("opencode")).toBeNull();
  });

  it("answers for exactly the kinds the renderer offers a chat", () => {
    for (const kind of ["claude", "codex", "pi", "opencode"] as const) {
      expect(adapterFor(kind) !== null).toBe(CHAT_KINDS.has(kind));
    }
  });
});
