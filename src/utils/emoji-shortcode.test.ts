import { describe, it, expect } from "vitest";
import {
  completeClosedShortcode,
  findShortcodeQuery,
  loadEmojiIndex,
  replaceRange,
  searchEmoji,
  type EmojiEntry,
} from "./emoji-shortcode";

function entry(
  emoji: string,
  shortcodes: string[],
  label = "",
  tags: string[] = [],
): EmojiEntry {
  return { emoji, shortcodes, label, tags };
}

describe("findShortcodeQuery", () => {
  it("triggers on `:sm` at the start of the string", () => {
    expect(findShortcodeQuery(":sm", 3)).toEqual({
      start: 0,
      end: 3,
      query: "sm",
    });
  });

  it("triggers on `:sm` after whitespace", () => {
    expect(findShortcodeQuery("hi :sm", 6)).toEqual({
      start: 3,
      end: 6,
      query: "sm",
    });
  });

  it("lowercases the query", () => {
    expect(findShortcodeQuery(":SM", 3)).toEqual({
      start: 0,
      end: 3,
      query: "sm",
    });
  });

  it("does not trigger on a bare colon inside a time (`10:30`)", () => {
    expect(findShortcodeQuery("10:30", 5)).toBeNull();
  });

  it("does not trigger inside a URL (`http://x`)", () => {
    expect(findShortcodeQuery("http://x", 8)).toBeNull();
  });

  it("does not trigger on `:)`", () => {
    expect(findShortcodeQuery(":)", 2)).toBeNull();
    expect(findShortcodeQuery(":)", 1)).toBeNull();
  });

  it("does not trigger on a query shorter than 2 characters", () => {
    expect(findShortcodeQuery(":s", 2)).toBeNull();
  });

  it("does not trigger when the caret is not at the end of the token", () => {
    expect(findShortcodeQuery(":smile", 3)).toBeNull();
  });
});

describe("searchEmoji", () => {
  const index = [
    entry("🎉", ["tada", "party"], "party popper", ["celebrate"]),
    entry("😀", ["grinning"], "grinning face", ["smile", "happy"]),
    entry("😄", ["smile"], "grinning face with smiling eyes", ["happy"]),
    entry("😊", ["blush"], "smiling face", ["smile", "shy"]),
  ];

  it("ranks an exact shortcode match before a prefix match", () => {
    const results = searchEmoji(index, "smile");
    expect(results.map((e) => e.emoji)).toEqual(["😄", "😀", "😊"]);
  });

  it("ranks a prefix match before a substring match", () => {
    const results = searchEmoji(index, "tad");
    expect(results.map((e) => e.emoji)).toEqual(["🎉"]);
  });

  it("finds a substring match in label and tags", () => {
    const results = searchEmoji(index, "happy");
    expect(results.map((e) => e.emoji)).toEqual(["😀", "😄"]);
  });

  it("keeps ties in the index's original order", () => {
    const tied = [
      entry("🅰️", ["a-thing"], "", ["shared"]),
      entry("🅱️", ["b-thing"], "", ["shared"]),
    ];
    expect(searchEmoji(tied, "shared").map((e) => e.emoji)).toEqual([
      "🅰️",
      "🅱️",
    ]);
  });

  it("respects the limit", () => {
    expect(searchEmoji(index, "s", 2)).toHaveLength(2);
  });
});

describe("completeClosedShortcode", () => {
  const index = [entry("🎉", ["tada"], "party popper", ["celebrate"])];

  it("replaces `:tada:` with the emoji when the closing `:` is typed", () => {
    expect(completeClosedShortcode("hi :tada:", 9, index)).toEqual({
      value: "hi 🎉",
      caret: 5,
    });
  });

  it("returns null for an unknown shortcode", () => {
    expect(completeClosedShortcode("hi :nope:", 9, index)).toBeNull();
  });

  it("returns null when the caret isn't right after a `:`", () => {
    expect(completeClosedShortcode("hi :tada", 8, index)).toBeNull();
  });
});

describe("replaceRange", () => {
  it("places the caret after a multi-codepoint emoji", () => {
    // "👍🏽" is a thumbs-up + skin-tone modifier: 4 UTF-16 code units.
    expect("👍🏽").toHaveLength(4);
    expect(replaceRange("hi :ok:", 3, 7, "👍🏽")).toEqual({
      value: "hi 👍🏽",
      caret: 7,
    });
  });
});

describe("loadEmojiIndex", () => {
  it("loads real emoji data and resolves `tada` to the party popper emoji", async () => {
    const index = await loadEmojiIndex();
    expect(index.length).toBeGreaterThan(100);

    const tada = index.find((e) => e.shortcodes.includes("tada"));
    expect(tada?.emoji).toBe("🎉");

    // Memoized: a second call returns data, not a distinct fresh load.
    const again = await loadEmojiIndex();
    expect(again).toBe(index);
  });
});
