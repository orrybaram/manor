import { describe, it, expect } from "vitest";
import { commandAvailableOnWeb, NATIVE_ONLY_COMMANDS } from "../menu-commands";

describe("commandAvailableOnWeb", () => {
  it("is false for a command whose only implementation is Electron-only", () => {
    for (const id of NATIVE_ONLY_COMMANDS) {
      expect(commandAvailableOnWeb(id)).toBe(false);
    }
  });

  it("is true for a command that works the same on the web app", () => {
    expect(commandAvailableOnWeb("new-tab")).toBe(true);
    expect(commandAvailableOnWeb("split-h")).toBe(true);
    expect(commandAvailableOnWeb("open-diff")).toBe(true);
  });
});
