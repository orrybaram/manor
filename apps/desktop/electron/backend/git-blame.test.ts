import { describe, expect, it } from "vitest";
import { parseBlamePorcelain, parseCommitMessages } from "./git-blame";

const A = "a".repeat(40);
const B = "b".repeat(40);

const commit = (sha: string, final: number, group: number, author: string, time: number, summary: string) => [
  `${sha} ${final} ${final} ${group}`,
  `author ${author}`,
  `author-mail <${author}@x>`,
  `author-time ${time}`,
  "author-tz +0000",
  `committer ${author}`,
  "committer-mail <c@x>",
  `committer-time ${time}`,
  "committer-tz +0000",
  `summary ${summary}`,
  "boundary",
  "filename a.ts",
];

describe("parseBlamePorcelain", () => {
  it("reads each commit once and a commit's later lines from their headers", () => {
    const output = [
      ...commit(A, 1, 2, "Ada", 100, "first"),
      "\tone",
      `${A} 2 2`,
      "\ttwo",
      ...commit(B, 3, 1, "Bob", 200, "second"),
      "\tthree",
      `${A} 3 4 1`,
      "\tfour",
      "",
    ].join("\n");
    expect(parseBlamePorcelain(output)).toEqual({
      commits: [
        { sha: A, author: "Ada", time: 100, summary: "first", message: "" },
        { sha: B, author: "Bob", time: 200, summary: "second", message: "" },
      ],
      lines: [0, 0, 1, 0],
    });
  });

  it("never reads a line's own text, whatever it looks like", () => {
    const output = [
      ...commit(A, 1, 3, "Ada", 100, "first"),
      "\tauthor Mallory",
      `${A} 2 2`,
      `\t${B} 1 1 1`,
      `${A} 3 3`,
      "\tsummary not this",
      "",
    ].join("\n");
    const blame = parseBlamePorcelain(output);
    expect(blame.commits).toHaveLength(1);
    expect(blame.commits[0]).toMatchObject({ author: "Ada", summary: "first" });
    expect(blame.lines).toEqual([0, 0, 0]);
  });

  it("makes nothing of an empty file", () => {
    expect(parseBlamePorcelain("")).toEqual({ commits: [], lines: [] });
  });
});

describe("parseCommitMessages", () => {
  it("pairs each sha with its message, blank lines and all", () => {
    expect(parseCommitMessages(`${A}\0one\n\nbody\n\0\n${B}\0two\n\0\n`)).toEqual([
      [A, "one\n\nbody"],
      [B, "two"],
    ]);
  });
});
