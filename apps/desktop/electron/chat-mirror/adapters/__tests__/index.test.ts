import { describe, expect, it } from "vitest";
import { CHAT_KINDS } from "../../../../src/lib/agent-chat";
import { adapterFor } from "../index";
import { claudeAdapter } from "../claude";
import { codexAdapter } from "../codex";
import { opencodeAdapter } from "../opencode";
import { piAdapter } from "../pi";

describe("adapterFor", () => {
  it("resolves every agent kind", () => {
    expect(adapterFor("claude")).toBe(claudeAdapter);
    expect(adapterFor("codex")).toBe(codexAdapter);
    expect(adapterFor("pi")).toBe(piAdapter);
    expect(adapterFor("opencode")).toBe(opencodeAdapter);
  });

  it("answers for exactly the kinds the renderer offers a chat", () => {
    for (const kind of ["claude", "codex", "pi", "opencode"] as const) {
      expect(adapterFor(kind) !== null).toBe(CHAT_KINDS.has(kind));
    }
  });
});
