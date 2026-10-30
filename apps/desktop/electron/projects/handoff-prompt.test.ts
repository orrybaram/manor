import { describe, expect, it } from "vitest";
import { buildHandoffPrompt, HANDOFF_MAX, handoffFromPreview } from "./handoff-prompt";

const BASE = {
  sourceHostName: "this Mac",
  targetHostName: "wsl-box",
  branch: "feat/login",
  session: { title: "Fix the login redirect", firstPrompt: "The login page loops back to itself." },
};

describe("buildHandoffPrompt", () => {
  it("says where the work came from, what it is, the recent turns and the branch", () => {
    const prompt = buildHandoffPrompt({
      ...BASE,
      turns: [
        { role: "assistant", text: "The middleware redirects before the cookie is set." },
        { role: "tool", name: "Edit", summary: "src/middleware.ts" },
        { role: "user", text: "Keep the next= param." },
      ],
    });
    expect(prompt).toBe(
      [
        "Continuing work moved from this Mac to wsl-box.",
        "Session: Fix the login redirect",
        "The session began with:\nThe login page loops back to itself.",
        "The last 2 turns:\nAssistant: The middleware redirects before the cookie is set.\n\nUser: Keep the next= param.",
        "All committed work is on branch feat/login. The previous session's terminal and uncommitted " +
          "state did not come along: read git log and git diff on feat/login to catch up, then carry on.",
      ].join("\n\n"),
    );
  });

  it("quotes only the last ten turns, each trimmed", () => {
    const turns = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i} ${"x".repeat(3000)}`,
    }));
    const prompt = buildHandoffPrompt({ ...BASE, turns });
    expect(prompt).not.toContain("turn 3 ");
    expect(prompt).toContain("turn 13 ");
    expect(prompt.length).toBeLessThanOrEqual(HANDOFF_MAX);
    // The oldest go first to fit; the branch note always stays.
    expect(prompt).toContain("on branch feat/login");
    for (const line of prompt.split("\n\n").filter((l) => l.startsWith("User:") || l.startsWith("Assistant:"))) {
      expect(line.length).toBeLessThanOrEqual(1300);
    }
  });

  it("stays under the cap with a huge first prompt and title", () => {
    const prompt = buildHandoffPrompt({
      ...BASE,
      session: { title: "t".repeat(5000), firstPrompt: "p".repeat(50_000) },
      turns: [{ role: "user", text: "u".repeat(50_000) }],
    });
    expect(prompt.length).toBeLessThanOrEqual(HANDOFF_MAX);
    expect(prompt).toContain("on branch feat/login");
  });

  it("is the title and branch note alone when there is nothing else", () => {
    const prompt = buildHandoffPrompt({ ...BASE, session: { title: "Fix it", firstPrompt: null }, turns: [] });
    expect(prompt).toBe(
      [
        "Continuing work moved from this Mac to wsl-box.",
        "Session: Fix it",
        "All committed work is on branch feat/login. The previous session's terminal and uncommitted " +
          "state did not come along: read git log and git diff on feat/login to catch up, then carry on.",
      ].join("\n\n"),
    );
  });
});

describe("handoffFromPreview", () => {
  it("takes the flagged opening prompt out of the turns", () => {
    expect(
      handoffFromPreview({
        truncated: true,
        turns: [
          { role: "user", text: "first", first: true },
          { role: "assistant", text: "a" },
        ],
      }),
    ).toEqual({ firstPrompt: "first", turns: [{ role: "assistant", text: "a" }] });
  });

  it("takes the first user turn of a whole transcript, and none from a window", () => {
    const turns = [
      { role: "assistant" as const, text: "hi" },
      { role: "user" as const, text: "go" },
    ];
    expect(handoffFromPreview({ truncated: false, turns })).toEqual({
      firstPrompt: "go",
      turns: [{ role: "assistant", text: "hi" }],
    });
    expect(handoffFromPreview({ truncated: true, turns })).toEqual({ firstPrompt: null, turns });
  });
});
