import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  PROMPT_DEFINITIONS,
  isPromptId,
  promptDefinition,
  promptProblems,
  promptTemplate,
  renderPrompt,
  renderTemplate,
} from "./catalog";

describe("the prompt catalog", () => {
  it("lists each prompt once", () => {
    const ids = PROMPT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(11);
  });

  it("uses every placeholder a prompt offers in its default", () => {
    for (const { id, template } of PROMPT_DEFINITIONS) {
      expect(promptProblems(id, template), id).toEqual({
        unknown: [],
        missing: [],
        empty: false,
        tooLong: false,
      });
    }
  });

  it("matches the hints the hook script has to carry itself", () => {
    const hook = createRequire(import.meta.url)("../../../electron/scripts/agent-hook.js");
    expect(hook.SESSION_START_HINT.hookSpecificOutput.additionalContext).toBe(
      promptDefinition("sessionHint").template,
    );
    expect(hook.REMOTE_SESSION_START_HINT.hookSpecificOutput.additionalContext).toBe(
      promptDefinition("sessionHintRemote").template,
    );
  });

  it("does not take object internals for prompts", () => {
    expect(isPromptId("issue")).toBe(true);
    expect(isPromptId("constructor")).toBe(false);
    expect(isPromptId(7)).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("never reads inserted text again", () => {
    expect(renderTemplate("{{a}} {{b}}", { a: "{{b}}", b: "$& $1" })).toBe("{{b}} $& $1");
  });

  it("leaves an unknown placeholder as typed", () => {
    expect(renderTemplate("{{nope}} {{constructor}}", {})).toBe("{{nope}} {{constructor}}");
  });

  it("fills a placeholder used twice", () => {
    expect(renderTemplate("{{a}}{{a}}", { a: "x" })).toBe("xx");
  });
});

describe("promptTemplate", () => {
  it("uses the default without a saved edit", () => {
    expect(promptTemplate("prConflicts")).toBe(promptDefinition("prConflicts").template);
    expect(promptTemplate("prConflicts", null)).toBe(promptDefinition("prConflicts").template);
  });

  it("uses the saved edit", () => {
    expect(renderPrompt("prConflicts", { pr: "PR #1" }, { prConflicts: "Merge {{pr}}" })).toBe("Merge PR #1");
  });

  it("sends a task prompt's default rather than a blank brief", () => {
    expect(promptTemplate("issue", { issue: "  \n" })).toBe(promptDefinition("issue").template);
  });

  it("lets a session hint be blank", () => {
    expect(promptTemplate("sessionHint", { sessionHint: "" })).toBe("");
  });
});

describe("promptProblems", () => {
  it("names unknown and left-out placeholders", () => {
    expect(promptProblems("prChanges", "{{pr}} {{nope}}")).toMatchObject({
      unknown: ["nope"],
      missing: ["number"],
      empty: false,
    });
  });

  it("flags a blank task prompt but not a blank hint", () => {
    expect(promptProblems("issue", " ").empty).toBe(true);
    expect(promptProblems("sessionHint", " ").empty).toBe(false);
  });

  it("flags text past the limit", () => {
    expect(promptProblems("sessionHint", "x".repeat(20_001)).tooLong).toBe(true);
  });
});
