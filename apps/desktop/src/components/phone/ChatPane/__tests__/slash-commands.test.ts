/**
 * The phone composer's `/` menu, as pure functions.
 */
import { describe, expect, it } from "vitest";
import {
  opensMenu,
  type ChatCommand,
} from "../../../../../electron/chat-mirror/builtin-commands";
import {
  applyCommand,
  commandEffect,
  findSlashQuery,
  matchCommands,
  splitCommand,
} from "../slash-commands";

function cmd(name: string, description = "", over: Partial<ChatCommand> = {}): ChatCommand {
  return { name, description, source: "skill", ...over };
}

describe("findSlashQuery", () => {
  it("opens on a lone slash with an empty query", () => {
    expect(findSlashQuery("/", 1)).toEqual({ query: "" });
  });

  it("returns the text between the slash and the caret", () => {
    expect(findSlashQuery("/rev", 4)).toEqual({ query: "rev" });
    expect(findSlashQuery("/review", 3)).toEqual({ query: "re" });
  });

  it("is null when the text doesn't start with a slash", () => {
    expect(findSlashQuery("hi /rev", 7)).toBeNull();
    expect(findSlashQuery(" /rev", 5)).toBeNull();
  });

  it("is null with the caret before the slash", () => {
    expect(findSlashQuery("/rev", 0)).toBeNull();
  });

  it("is null once the caret is past the first word", () => {
    expect(findSlashQuery("/review ", 8)).toBeNull();
    expect(findSlashQuery("/review src/foo.ts", 12)).toBeNull();
  });

  it("stays open with the caret at the end of the first word and args after it", () => {
    expect(findSlashQuery("/review src", 7)).toEqual({ query: "review" });
  });

  it("is null for a caret beyond the text", () => {
    expect(findSlashQuery("/a", 5)).toBeNull();
  });
});

describe("matchCommands", () => {
  const commands = [
    cmd("review", "Review a pull request", { source: "builtin" }),
    cmd("anthropic-skills:pdf", "Work with PDF files"),
    cmd("clear", "Clear the conversation", { source: "builtin" }),
    cmd("security-review", "Review pending changes for security"),
    cmd("pdf-tools", "Misc"),
    cmd("compact", "Summarize the conversation to free up context"),
  ];

  it("lists the first commands alphabetically for an empty query, mixed sources", () => {
    expect(matchCommands(commands, "", 3).map((c) => c.name)).toEqual([
      "anthropic-skills:pdf",
      "clear",
      "compact",
    ]);
  });

  it("ranks name prefix, then after-colon prefix, then name substring, then description", () => {
    expect(matchCommands(commands, "pdf").map((c) => c.name)).toEqual([
      "pdf-tools",
      "anthropic-skills:pdf",
    ]);
    expect(matchCommands(commands, "rev").map((c) => c.name)).toEqual([
      "review",
      "security-review",
    ]);
    expect(matchCommands(commands, "conversation").map((c) => c.name)).toEqual([
      "clear",
      "compact",
    ]);
  });

  it("is case-insensitive", () => {
    expect(matchCommands(commands, "REV").map((c) => c.name)).toEqual([
      "review",
      "security-review",
    ]);
  });

  it("keeps ties alphabetical", () => {
    const list = [cmd("cz"), cmd("ca"), cmd("cm")];
    expect(matchCommands(list, "c").map((c) => c.name)).toEqual(["ca", "cm", "cz"]);
  });

  it("caps the result at the limit (8 by default)", () => {
    const many = Array.from({ length: 12 }, (_, i) => cmd(`c${String(i).padStart(2, "0")}`));
    expect(matchCommands(many, "c")).toHaveLength(8);
    expect(matchCommands(many, "c", 2)).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});

describe("applyCommand", () => {
  it("replaces the query with the name and a trailing space", () => {
    expect(applyCommand("/rev", 4, "review")).toEqual({ text: "/review ", caret: 8 });
  });

  it("keeps args after the first word without doubling the space", () => {
    expect(applyCommand("/rev src/foo.ts", 4, "review")).toEqual({
      text: "/review src/foo.ts",
      caret: 8,
    });
  });

  it("replaces the whole first word when the caret is inside it", () => {
    expect(applyCommand("/reviw", 3, "review")).toEqual({ text: "/review ", caret: 8 });
  });

  it("works for a lone slash", () => {
    expect(applyCommand("/", 1, "clear")).toEqual({ text: "/clear ", caret: 7 });
  });
});

describe("splitCommand", () => {
  it("splits the name from the trimmed args", () => {
    expect(splitCommand("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
    expect(splitCommand("/config  a=b  c ")).toEqual({ name: "config", args: "a=b  c" });
    expect(splitCommand("/review\nthe diff")).toEqual({ name: "review", args: "the diff" });
  });

  it("has empty args for a bare command", () => {
    expect(splitCommand("/model")).toEqual({ name: "model", args: "" });
    expect(splitCommand("/model ")).toEqual({ name: "model", args: "" });
  });

  it("is null for plain text", () => {
    expect(splitCommand("hello /model")).toBeNull();
    expect(splitCommand("/")).toBeNull();
  });
});

describe("opensMenu", () => {
  const model = cmd("model", "", { source: "builtin", menu: "bare-only" });
  const theme = cmd("theme", "", { source: "builtin", menu: "always" });

  it("opens when sent bare", () => {
    expect(opensMenu(model, "")).toBe(true);
    expect(opensMenu(model, "  ")).toBe(true);
  });

  it("doesn't open when an argument skips the menu", () => {
    expect(opensMenu(model, "sonnet")).toBe(false);
  });

  it("still opens with args for an always-menu command", () => {
    expect(opensMenu(theme, "dark")).toBe(true);
  });

  it("doesn't open for a command without a menu or an unknown one", () => {
    expect(opensMenu(cmd("review"), "")).toBe(false);
    expect(opensMenu(undefined, "")).toBe(false);
  });
});

describe("commandEffect", () => {
  const lookup = (name: string) =>
    ({ model: cmd("model", "", { menu: "bare-only" }), clear: cmd("clear") })[name];

  it("is menu for a bare menu command", () => {
    expect(commandEffect(splitCommand("/model"), lookup)).toBe("menu");
  });

  it("is null when an argument skips the menu", () => {
    expect(commandEffect(splitCommand("/model sonnet"), lookup)).toBeNull();
  });

  it("is clear for /clear and its aliases", () => {
    expect(commandEffect(splitCommand("/clear"), lookup)).toBe("clear");
    expect(commandEffect(splitCommand("/reset"), lookup)).toBe("clear");
    expect(commandEffect(splitCommand("/new"), lookup)).toBe("clear");
  });

  it("is null for plain text and unknown commands", () => {
    expect(commandEffect(splitCommand("hello"), lookup)).toBeNull();
    expect(commandEffect(splitCommand("/nonsense"), lookup)).toBeNull();
  });
});
