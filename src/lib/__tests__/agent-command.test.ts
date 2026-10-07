/**
 * `agentCommandWithPromptFile` — the short launch line that reads its prompt
 * from a file on the pane's host (ADR-209), so the line typed into a fresh
 * shell never runs into the tty's canonical line limit.
 */

import { describe, expect, it } from "vitest";
import {
  agentCommandWithPrompt,
  agentCommandWithPromptFile,
} from "../agent-command";

describe("agentCommandWithPromptFile", () => {
  it("passes the file's contents as the first argument and removes it", () => {
    expect(
      agentCommandWithPromptFile("claude", "/home/me/.manor/prompts/p-1.txt"),
    ).toBe(
      `claude "$(cat '/home/me/.manor/prompts/p-1.txt'; rm -f '/home/me/.manor/prompts/p-1.txt')"`,
    );
  });

  it("single-quotes a path with a space and a quote in it", () => {
    const file = "/Users/O'Brien/My Home/.manor/prompts/p.txt";
    const q = `'/Users/O'\\''Brien/My Home/.manor/prompts/p.txt'`;
    expect(agentCommandWithPromptFile("claude --flag", file)).toBe(
      `claude --flag "$(cat ${q}; rm -f ${q})"`,
    );
  });

  it("stays short however long the prompt is", () => {
    const line = agentCommandWithPromptFile("claude", "/h/.manor/prompts/a.txt");
    expect(line.length).toBeLessThan(200);
  });
});

describe("agentCommandWithPrompt", () => {
  it("is the bare command without a prompt", () => {
    expect(agentCommandWithPrompt("claude")).toBe("claude");
  });

  it("flattens and quotes the prompt inline", () => {
    expect(agentCommandWithPrompt("claude", 'a\n\nsay "$x"')).toBe(
      `claude "a say \\"\\$x\\""`,
    );
  });
});
