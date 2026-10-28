import { describe, expect, it } from "vitest";
import { TranscriptScrubber } from "../../../scripts/scrub-transcript";

function scrub(...lines: Record<string, unknown>[]): Record<string, unknown>[] {
  const s = new TranscriptScrubber();
  return s.scrubLines(lines.map((l) => JSON.stringify(l))).lines.map((l) => JSON.parse(l));
}

const UUID_A = "3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const UUID_B = "8a7b6c5d-4e3f-4a1b-8c9d-0e1f2a3b4c5d";

describe("scrub-transcript", () => {
  it("scrubs an unknown string field, keeping its length and punctuation", () => {
    const [out] = scrub({ type: "mystery", note: "Alice met Bob at 221B, then left." });
    expect(out.type).toBe("mystery");
    const v = out.note as string;
    expect(v).not.toMatch(/Alice|Bob|221B|left/);
    expect(v.length).toBe("Alice met Bob at 221B, then left.".length);
    expect(v).toMatch(/^\w+ \w+ \w+ \w+ \w+, \w+ \w+\.$/);
  });

  it("keeps keys, numbers, booleans, enums and tool names", () => {
    const [out] = scrub({
      type: "assistant",
      isSidechain: false,
      message: {
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 12 },
        content: [{ type: "tool_use", id: "toolu_01AbCdEfGhIjKlMnOpQrStUv", name: "Edit", input: { file_path: "/x" } }],
      },
    });
    expect(out).toMatchObject({
      type: "assistant",
      isSidechain: false,
      message: { model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 12 } },
    });
    const block = (out.message as { content: Record<string, unknown>[] }).content[0];
    expect(block.name).toBe("Edit");
    expect(block.id).toMatch(/^toolu_[A-Za-z0-9]{24}$/);
    expect(block.id).not.toBe("toolu_01AbCdEfGhIjKlMnOpQrStUv");
  });

  it("remaps ids consistently, so links between lines survive", () => {
    const [a, b] = scrub(
      { type: "user", uuid: UUID_A, parentUuid: null, sessionId: UUID_B },
      {
        type: "user",
        uuid: UUID_B.replace("8a", "9a"),
        parentUuid: UUID_A,
        sessionId: UUID_B,
        message: { content: `<task-notification>\n<task-id>abc123def456</task-id>\n<tool-use-id>toolu_01Zz</tool-use-id>\n<status>completed</status>\n<summary>Agent "Fix login" finished</summary>\n</task-notification>` },
      },
    );
    expect(b.parentUuid).toBe(a.uuid);
    expect(b.sessionId).toBe(a.sessionId);
    expect(a.uuid).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    const text = (b.message as { content: string }).content;
    expect(text).toMatch(/^<task-notification>\n<task-id>[0-9a-f]{12}<\/task-id>\n<tool-use-id>toolu_\w+<\/tool-use-id>\n<status>completed<\/status>\n<summary>\w+ "\w+ \w+" \w+<\/summary>\n<\/task-notification>$/);
    expect(text).not.toMatch(/abc123def456|Fix login/);
  });

  it("keeps Claude Code's own markers and markup, and scrubs what they wrap", () => {
    const [a, b, c] = scrub(
      { type: "user", message: { content: "[Request interrupted by user for tool use]" } },
      { type: "user", message: { content: "<bash-input>git push origin secret-branch</bash-input>" } },
      { type: "user", message: { content: "<command-name>/model</command-name>\n<command-args>opus please</command-args>" } },
    );
    expect((a.message as { content: string }).content).toBe("[Request interrupted by user for tool use]");
    expect((b.message as { content: string }).content).toMatch(/^<bash-input>\w{3} \w{4} \w{6} \w{6}-\w{6}<\/bash-input>$/);
    expect((c.message as { content: string }).content).toMatch(/^<command-name>\/model<\/command-name>\n<command-args>\w+ \w+<\/command-args>$/);
  });

  it("treats an unclosed <word> as prose", () => {
    const [out] = scrub({ type: "user", message: { content: "use <button> here" } });
    expect((out.message as { content: string }).content).not.toContain("button");
  });

  it("maps paths under the cwd to /work/repo, keeping depth and extension", () => {
    const [out] = scrub({
      type: "user",
      cwd: "/home/someone/Code/project",
      toolUseResult: { filePath: "/home/someone/Code/project/src/app/main.tsx", other: "/etc/hosts.d/x.conf" },
      message: { content: "see /home/someone/Code/project/README.md and mail me@corp.example.org" },
    });
    expect(out.cwd).toBe("/work/repo");
    const r = out.toolUseResult as { filePath: string; other: string };
    expect(r.filePath).toMatch(/^\/work\/repo\/src\/d\d+\/f\d+\.tsx$/);
    expect(r.other).toMatch(/^\/etc\/d\d+\/f\d+\.conf$/);
    const text = (out.message as { content: string }).content;
    expect(text).toMatch(/^\w+ \/work\/repo\/f\d+\.md \w+ \w+ user@example\.com$/);
  });

  it("keeps a structuredPatch's numbers and line prefixes", () => {
    const [out] = scrub({
      type: "user",
      toolUseResult: {
        structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" keep me", "-old line", "+new line", "\\ No newline at end of file"] }],
      },
    });
    const [h] = (out.toolUseResult as { structuredPatch: { lines: string[]; oldStart: number }[] }).structuredPatch;
    expect(h.oldStart).toBe(3);
    expect(h.lines.map((l) => l[0])).toEqual([" ", "-", "+", "\\"]);
    expect(h.lines.map((l) => l.length)).toEqual([8, 9, 9, 27]);
    expect(h.lines.join("")).not.toMatch(/keep|old|new/);
  });

  it("drops noisy line types and sensitive keys", () => {
    const s = new TranscriptScrubber();
    const { lines, dropped } = s.scrubLines([
      JSON.stringify({ type: "api-request-blob", body: "x" }),
      JSON.stringify({ type: "attachment", attachment: { type: "credential_org", org: "x" } }),
      JSON.stringify({ type: "user", email: "a@b.co", oauthAccount: { x: 1 }, rendered: "x", permissionDecision: { decision: "accept" }, gitBranch: "fix/acme-bug" }),
      "not json",
    ]);
    expect(dropped).toEqual({ "api-request-blob": 1, "attachment:credential_org": 1, malformed: 1 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ type: "user", gitBranch: "feat/branch" }]);
  });

  it("shifts timestamps to 2026-01-01, keeping the gaps", () => {
    const [a, b] = scrub(
      { type: "user", timestamp: "2024-05-06T07:08:09.000Z" },
      { type: "user", timestamp: "2024-05-06T07:08:19.500Z" },
    );
    expect(a.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(b.timestamp).toBe("2026-01-01T00:00:10.500Z");
  });

  it("shortens long text and replaces base64", () => {
    const [out] = scrub({
      type: "user",
      big: "word ".repeat(5000),
      message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(5000) } }] },
    });
    expect((out.big as string).length).toBeLessThan(5000);
    const img = (out.message as { content: { source: { data: string; media_type: string } }[] }).content[0].source;
    expect(img.media_type).toBe("image/png");
    expect(img.data.length).toBeLessThan(200);
  });

  it("shifts epochs and dates with the timestamps", () => {
    const base = Date.UTC(2024, 4, 6, 7, 8, 9);
    const [out] = scrub({
      type: "user",
      timestamp: new Date(base).toISOString(),
      startTime: base + 1000,
      scheduledFor: base / 1000 + 60,
      stamp: String(base + 2000),
      attachment: { type: "date", date: "2024-05-07" },
      message: { content: "on 2024-05-06T07:08:19Z, see 2024-05-06" },
    });
    expect(out.startTime).toBe(Date.UTC(2026, 0, 1) + 1000);
    expect(out.scheduledFor).toBe(Date.UTC(2026, 0, 1) / 1000 + 60);
    expect(out.stamp).toBe(String(Date.UTC(2026, 0, 1) + 2000));
    expect((out.attachment as { date: string }).date).toBe("2026-01-01");
    expect((out.message as { content: string }).content).toMatch(/^\w+ 2026-01-01T00:00:10Z, \w+ 2025-12-31$/);
  });

  it("keeps a version only when it is semver, and drops PR fields", () => {
    const [a, b] = scrub(
      { type: "user", version: "2.1.308", prNumber: 353, prUrl: "https://x/y", prRepository: "me/repo" },
      { type: "user", version: "1792097047-7a55" },
    );
    expect(a).toEqual({ type: "user", version: "2.1.308" });
    expect(b.version).not.toContain("7a55");
  });

  it("replaces numbers of three or more digits in text, and long digit strings", () => {
    const [out] = scrub({
      type: "user",
      runs: "12345678",
      short: "4096",
      message: { content: "PR #353 fixes ADR-227 in 2 steps" },
    });
    expect(out.runs).not.toBe("12345678");
    expect(out.runs).toHaveLength(8);
    expect(out.short).toBe("4096");
    const text = (out.message as { content: string }).content;
    expect(text).not.toMatch(/353|227/);
    expect(text).toMatch(/^\w+ #\d{3} \w+ \w+-\d{3} \w+ 2 \w+$/);
  });

  it("zeroes costs, rounds token counts, and blanks osVersion digits", () => {
    const [out] = scrub({
      type: "user",
      costUSD: 1.234,
      usage: { input_tokens: 3, cache_read_input_tokens: 123_456 },
      osVersion: "Linux 6.18.54-generic",
    });
    expect(out.costUSD).toBe(0);
    expect(out.usage).toEqual({ input_tokens: 3, cache_read_input_tokens: 123_500 });
    expect(out.osVersion).toMatch(/^\w+ 0\.00\.00-\w+$/);
  });

  it("scrubs keys that are paths, files, hosts or emails, and keeps identifier keys", () => {
    const [out] = scrub({
      type: "user",
      files: { "src/app.ts": 1, "README.md": 2, "me@corp.com": 3, "localhost:3000": 4, cache_read: 5, "anthropic-skills:pdf": 6 },
    });
    const keys = Object.keys(out.files as object);
    expect(keys).toContain("cache_read");
    expect(keys).toContain("anthropic-skills:pdf");
    expect(keys.join(" ")).not.toMatch(/app|README|corp|localhost/);
    expect(Object.values(out.files as object).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps no enum with a slash or an at sign but a media type", () => {
    const [out] = scrub({ type: "a/b", status: "me@host", media_type: "image/png" });
    expect(out.type).not.toBe("a/b");
    expect(out.status).not.toBe("me@host");
    expect(out.media_type).toBe("image/png");
  });
});
