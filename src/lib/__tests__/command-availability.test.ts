import { describe, it, expect } from "vitest";
import {
  COMMANDS,
  availableCommands,
  commandAvailableOnHostServer,
  commandAvailableOnWeb,
  commandHandlers,
  type CommandContext,
} from "../commands";
import { NATIVE_ONLY_COMMANDS } from "../menu-commands";

describe("commandAvailableOnWeb", () => {
  it("is false for a command whose only implementation is Electron-only", () => {
    for (const id of NATIVE_ONLY_COMMANDS) {
      expect(commandAvailableOnWeb(id)).toBe(false);
    }
    expect([...NATIVE_ONLY_COMMANDS].sort()).toEqual([
      "add-project",
      "detach-pane",
      "detach-tab",
      "open-in-editor",
      "reveal-in-finder",
    ]);
  });

  it("is true for a command that works the same on the web app", () => {
    expect(commandAvailableOnWeb("new-tab")).toBe(true);
    expect(commandAvailableOnWeb("split-h")).toBe(true);
    expect(commandAvailableOnWeb("open-diff")).toBe(true);
  });

  // The help links go through `openExternal`, which opens a browser tab.
  it("keeps the help links on the web", () => {
    expect(commandAvailableOnWeb("help-docs")).toBe(true);
    expect(commandAvailableOnWeb("help-release-notes")).toBe(true);
    expect(commandAvailableOnWeb("help-report-issue")).toBe(true);
  });
});

describe("availableCommands", () => {
  it("is the whole table on the desktop", () => {
    expect(availableCommands({ web: false })).toBe(COMMANDS);
  });

  it("drops exactly the native-only commands on the web", () => {
    const web = new Set(availableCommands({ web: true }).map((d) => d.id));
    for (const def of COMMANDS) {
      expect(web.has(def.id), def.id).toBe(!NATIVE_ONLY_COMMANDS.has(def.id));
    }
  });
});

describe("commandAvailableOnHostServer", () => {
  it("is false for exactly what a host server cannot do (ADR-225 D5)", () => {
    const refused = COMMANDS.filter((d) => !commandAvailableOnHostServer(d.id)).map((d) => d.id);
    expect(refused.sort()).toEqual(["new-agent", "new-workspace"]);
  });

  it("drops them from the table and the handler maps on a host server", () => {
    const ids = availableCommands({ web: true, hostServer: true }).map((d) => d.id);
    expect(ids).not.toContain("new-workspace");
    expect(ids).not.toContain("new-agent");
    expect(ids).toContain("new-tab");
    const handlers = commandHandlers({ chrome: {} } as unknown as CommandContext, {
      web: true,
      hostServer: true,
      primary: true,
    });
    expect(handlers["new-workspace"]).toBeUndefined();
    expect(handlers["new-agent"]).toBeUndefined();
    expect(handlers["new-tab"]).toBeTypeOf("function");
  });

  it("keeps them on the web when connected to a desktop", () => {
    const ids = availableCommands({ web: true }).map((d) => d.id);
    expect(ids).toContain("new-workspace");
    expect(ids).toContain("new-agent");
  });
});

describe("COMMANDS", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every primary-window command a run", () => {
    for (const def of COMMANDS) {
      if (def.scope === "primary") expect(def.run, def.id).toBeTypeOf("function");
    }
  });
});
