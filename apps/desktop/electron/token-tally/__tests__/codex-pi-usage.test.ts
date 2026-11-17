import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexLineTotal, codexUsageReader } from "../codex-usage";
import { piUsageReader } from "../pi-usage";

const FIXTURES = path.join(__dirname, "../../chat-mirror/__fixtures__");

function tokenCount(input: number, cached: number, output: number, timestamp = "2026-11-17T10:00:00.000Z"): string {
  const usage = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output };
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
  });
}

function piAssistant(id: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, timestamp = "2026-11-17T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage },
  });
}

describe("codex and pi usage readers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pi-usage-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, lines: string[]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  };

  describe("codex", () => {
    it("counts the rise of the cumulative fresh total, leaving out cached input", async () => {
      const file = write("rollout.jsonl", [
        tokenCount(1000, 800, 50),
        // repeated: nothing new
        tokenCount(1000, 800, 50),
        tokenCount(3000, 2500, 120),
      ]);
      const read = await codexUsageReader.read({ offset: 0 }, file);
      // 1000-800+50 = 250, then 3000-2500+120 = 620
      expect(read.fresh).toBe(620);
      expect(read.next.total).toBe(620);

      fs.appendFileSync(file, `${tokenCount(3000, 2500, 120)}\n${tokenCount(4000, 3000, 200)}\n`);
      const again = await codexUsageReader.read(read.next, file);
      expect(again.fresh).toBe(1200 - 620);
    });

    it("counts a total that fell from zero", async () => {
      const file = write("rollout.jsonl", [tokenCount(5000, 0, 0), tokenCount(300, 0, 0)]);
      expect((await codexUsageReader.read({ offset: 0 }, file)).fresh).toBe(5300);
    });

    it("starts a marker at the end with the total so far", async () => {
      const file = write("rollout.jsonl", [tokenCount(1000, 0, 0)]);
      const marker = await codexUsageReader.markerAtEnd(file);
      expect(marker.total).toBe(1000);
      fs.appendFileSync(file, `${tokenCount(1500, 0, 0)}\n`);
      expect((await codexUsageReader.read(marker, file)).fresh).toBe(500);
    });

    it("leaves out totals from before the floor, but counts the rise after them", async () => {
      const file = write("fork.jsonl", [
        tokenCount(9000, 0, 0, "2026-10-01T00:00:00.000Z"),
        tokenCount(9400, 0, 0, "2026-11-17T10:00:00.000Z"),
      ]);
      const read = await codexUsageReader.read({ offset: 0, floor: Date.parse("2026-11-17T00:00:00.000Z") }, file);
      expect(read.fresh).toBe(400);
    });

    it("reads the fixture rollout's totals, skipping a token_count with no info", async () => {
      const fixture = path.join(FIXTURES, "codex/codex-cli-0.130.0-shell-patch-interrupt.jsonl");
      const lines = fs.readFileSync(fixture, "utf8").split("\n").filter(Boolean);
      const totals = lines.map(codexLineTotal).filter((t) => t !== null).map((t) => t.total);
      expect(totals.length).toBeGreaterThan(0);
      expect(totals[0]).toBe(9120 - 3072 + 210);
      let expected = 0;
      let previous = 0;
      for (const total of totals) {
        expected += total >= previous ? total - previous : total;
        previous = total;
      }
      expect((await codexUsageReader.read({ offset: 0 }, fixture)).fresh).toBe(expected);
    });
  });

  describe("pi", () => {
    it("sums input, cache writes and output once per entry, leaving out cache reads", async () => {
      const usage = { input: 3, output: 41, cacheRead: 9000, cacheWrite: 5120 };
      const file = write("session.jsonl", [
        JSON.stringify({ type: "session", version: 3, id: "s" }),
        piAssistant("e1", usage),
        piAssistant("e1", usage),
        piAssistant("e2", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      ]);
      expect((await piUsageReader.read({ offset: 0 }, file)).fresh).toBe(3 + 41 + 5120 + 2);
    });

    it("matches a hand sum over the fixture session", async () => {
      const fixture = path.join(FIXTURES, "pi/session-v3-fix-and-branch.jsonl");
      let hand = 0;
      for (const line of fs.readFileSync(fixture, "utf8").split("\n")) {
        if (!line) continue;
        const o = JSON.parse(line);
        const u = o.type === "message" && o.message?.role === "assistant" ? o.message.usage : undefined;
        if (u) hand += u.input + u.cacheWrite + u.output;
      }
      expect(hand).toBeGreaterThan(0);
      expect((await piUsageReader.read({ offset: 0 }, fixture)).fresh).toBe(hand);
    });

    it("leaves out entries from before the floor", async () => {
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      const file = write("fork.jsonl", [
        piAssistant("old", usage, "2026-10-01T00:00:00.000Z"),
        piAssistant("new", usage, "2026-11-17T10:00:00.000Z"),
      ]);
      const read = await piUsageReader.read({ offset: 0, floor: Date.parse("2026-11-17T00:00:00.000Z") }, file);
      expect(read.fresh).toBe(2);
    });
  });
});
