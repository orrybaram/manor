import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeFreshTokens, claudeUsageReader } from "../claude-usage";

/** One assistant line of `id`'s message, usage repeated as Claude writes it. */
function assistantLine(
  id: string,
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number },
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-17T10:00:00.000Z",
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        output_tokens: usage.output,
      },
    },
  });
}

const userLine = JSON.stringify({ type: "user", message: { role: "user", content: "the usage is assistant" } });

describe("claudeFreshTokens", () => {
  it("sums input, cache writes and output, leaving out cache reads", () => {
    const { fresh } = claudeFreshTokens([
      userLine,
      assistantLine("msg_a", { input: 3, cacheWrite: 200, cacheRead: 90_000, output: 40 }),
      assistantLine("msg_b", { input: 5, cacheWrite: 0, cacheRead: 90_200, output: 7 }),
    ]);
    expect(fresh).toBe(3 + 200 + 40 + 5 + 7);
  });

  it("counts a message's repeated usage lines once", () => {
    const usage = { input: 1, cacheWrite: 10, cacheRead: 500, output: 100 };
    const { fresh, ids } = claudeFreshTokens([
      assistantLine("msg_a", usage),
      assistantLine("msg_a", usage),
      assistantLine("msg_a", usage),
    ]);
    expect(fresh).toBe(111);
    // and once across reads, by the ids carried forward
    expect(claudeFreshTokens([assistantLine("msg_a", usage)], ids).fresh).toBe(0);
  });

  it("skips lines that don't parse", () => {
    const { fresh } = claudeFreshTokens([
      '{"type":"assistant","usage": nope',
      assistantLine("msg_a", { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 }),
    ]);
    expect(fresh).toBe(2);
  });

  it("matches a hand sum over a real fixture transcript", () => {
    const fixture = path.join(__dirname, "../../chat-mirror/__fixtures__/claude-code-2.1.308-question-and-write.jsonl");
    const lines = fs.readFileSync(fixture, "utf8").split("\n");
    const byId = new Map<string, number>();
    for (const line of lines) {
      if (!line) continue;
      const o = JSON.parse(line);
      const u = o.type === "assistant" ? o.message?.usage : undefined;
      if (!u) continue;
      byId.set(o.message.id, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0));
    }
    const hand = [...byId.values()].reduce((a, b) => a + b, 0);
    expect(hand).toBeGreaterThan(0);
    expect(claudeFreshTokens(lines).fresh).toBe(hand);
  });
});

describe("claudeUsageReader", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a partial trailing line until it is complete", async () => {
    const file = path.join(dir, "s.jsonl");
    const first = assistantLine("msg_a", { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 });
    const second = assistantLine("msg_b", { input: 10, cacheWrite: 0, cacheRead: 0, output: 10 });
    fs.writeFileSync(file, `${first}\n${second.slice(0, 40)}`);

    const one = await claudeUsageReader.read({ offset: 0 }, file);
    expect(one.fresh).toBe(7);
    expect(one.next.offset).toBe(Buffer.byteLength(first) + 1);

    fs.appendFileSync(file, `${second.slice(40)}\n`);
    const two = await claudeUsageReader.read(one.next, file);
    expect(two.fresh).toBe(20);
    expect(two.next.offset).toBe(fs.statSync(file).size);
  });

  it("reads a transcript bigger than one chunk", async () => {
    const file = path.join(dir, "big.jsonl");
    const pad = "x".repeat(10_000);
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ type: "user", pad }));
      lines.push(assistantLine(`msg_${i}`, { input: 1, cacheWrite: 1, cacheRead: 1000, output: 1 }));
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const read = await claudeUsageReader.read({ offset: 0 }, file);
    expect(read.fresh).toBe(300);
    expect(read.next.offset).toBe(fs.statSync(file).size);
  });

  it("finds the session's subagent transcripts", async () => {
    const file = path.join(dir, "sess-1.jsonl");
    fs.writeFileSync(file, "");
    const sub = path.join(dir, "sess-1", "subagents");
    fs.mkdirSync(path.join(sub, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-b.jsonl"), "");
    fs.writeFileSync(path.join(sub, "agent-a.jsonl"), "");
    fs.writeFileSync(path.join(sub, "agent-a.meta.json"), "{}");
    expect(await claudeUsageReader.sources(file)).toEqual([
      file,
      path.join(sub, "agent-a.jsonl"),
      path.join(sub, "agent-b.jsonl"),
    ]);
  });
});
