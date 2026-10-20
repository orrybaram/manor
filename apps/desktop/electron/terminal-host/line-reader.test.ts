import { describe, it, expect } from "vitest";
import { createLineReader } from "./line-reader";

function collect(): { lines: string[]; read: (chunk: Buffer) => void } {
  const lines: string[] = [];
  return { lines, read: createLineReader((line) => lines.push(line)) };
}

describe("createLineReader", () => {
  it("splits lines within one chunk and skips blank ones", () => {
    const { lines, read } = collect();
    read(Buffer.from('{"a":1}\n\n  \n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("joins a line split across chunks", () => {
    const { lines, read } = collect();
    read(Buffer.from('{"a":'));
    read(Buffer.from("12"));
    read(Buffer.from('3}\n{"b"'));
    expect(lines).toEqual(['{"a":123}']);
    read(Buffer.from(":4}\n"));
    expect(lines).toEqual(['{"a":123}', '{"b":4}']);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const { lines, read } = collect();
    const bytes = Buffer.from("日本\n");
    read(bytes.subarray(0, 4)); // "日" plus the first byte of "本"
    read(bytes.subarray(4));
    expect(lines).toEqual(["日本"]);
  });

  /**
   * A snapshot reply is one multi-megabyte line arriving in small chunks.
   * Re-scanning everything pending on each chunk takes minutes here; reading
   * only each new chunk takes milliseconds.
   */
  it("reads a many-megabyte line in small chunks in linear time", () => {
    const { lines, read } = collect();
    const chunk = Buffer.from("x".repeat(1024));
    const chunks = 16 * 1024; // 16 MB

    const started = performance.now();
    for (let i = 0; i < chunks; i++) read(chunk);
    read(Buffer.from("\n"));
    const elapsed = performance.now() - started;

    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBe(chunks * chunk.length);
    expect(elapsed).toBeLessThan(2_000);
  });
});
