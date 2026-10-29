import { describe, expect, it } from "vitest";
import { commitBlocker, type CommitFlag } from "./commit";

const flags = (...f: CommitFlag[]) => new Set(f);

describe("commitBlocker", () => {
  it("lets a message commit what's staged", () => {
    expect(commitBlocker("Fix it", 2, flags())).toBeNull();
  });

  it("asks for something staged first", () => {
    expect(commitBlocker("Fix it", 0, flags())).toBe("Stage changes to commit");
  });

  it("asks for a message, ignoring whitespace", () => {
    expect(commitBlocker("  \n", 1, flags())).toBe("Write a commit message");
  });

  it("amends with nothing staged and no message, keeping the last one", () => {
    expect(commitBlocker("", 0, flags("--amend"))).toBeNull();
  });

  it("allows an empty commit with nothing staged, but still wants a message", () => {
    expect(commitBlocker("Empty", 0, flags("--allow-empty"))).toBeNull();
    expect(commitBlocker("", 0, flags("--allow-empty"))).toBe(
      "Write a commit message",
    );
  });
});
