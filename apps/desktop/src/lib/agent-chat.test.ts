import { describe, expect, it } from "vitest";
import { agentChat, CHAT_KINDS, hasChat } from "./agent-chat";

describe("agentChat", () => {
  it("names each agent kind as the chat shows it", () => {
    expect(agentChat("claude").name).toBe("Claude");
    expect(agentChat("codex").name).toBe("Codex");
    expect(agentChat("pi").name).toBe("pi");
    expect(agentChat("opencode").name).toBe("opencode");
  });

  it("gives Claude its / menu, /clear, one Esc and answerable pickers", () => {
    expect(agentChat("claude")).toEqual({
      name: "Claude",
      commands: "claude",
      clearCommands: ["clear", "reset", "new"],
      interruptKeys: ["\x1b"],
      answersPickers: true,
    });
  });

  it("gives the other kinds no Claude menu and no answerable pickers; opencode stops on two Escs", () => {
    for (const kind of ["codex", "pi", "opencode"]) {
      expect(agentChat(kind).commands).toBe("none");
      expect(agentChat(kind).clearCommands).toEqual([]);
      expect(agentChat(kind).answersPickers).toBe(false);
    }
    expect(agentChat("codex").interruptKeys).toEqual(["\x1b"]);
    expect(agentChat("opencode").interruptKeys).toEqual(["\x1b", "\x1b"]);
  });

  it("offers nothing kind-specific for no kind or an unknown one", () => {
    for (const kind of [null, undefined, "aider", "toString"]) {
      expect(agentChat(kind)).toMatchObject({ name: "Agent", commands: "none", answersPickers: false });
    }
  });
});

describe("hasChat", () => {
  it("is true only for kinds in CHAT_KINDS (Claude and pi, for now)", () => {
    expect([...CHAT_KINDS]).toEqual(["claude", "pi"]);
    expect(hasChat("claude")).toBe(true);
    expect(hasChat("pi")).toBe(true);
    expect(hasChat("codex")).toBe(false);
    expect(hasChat(null)).toBe(false);
    expect(hasChat(undefined)).toBe(false);
  });
});
