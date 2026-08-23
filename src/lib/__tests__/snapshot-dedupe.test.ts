import { describe, it, expect } from "vitest";
import { outputAfterSnapshot, type QueuedOutput } from "../snapshot-dedupe";

const chunks = (...entries: Array<[string, number?]>): QueuedOutput[] =>
  entries.map(([data, seq]) => (seq === undefined ? { data } : { data, seq }));

const texts = (queued: readonly QueuedOutput[]) => queued.map((c) => c.data);

describe("outputAfterSnapshot", () => {
  it("drops what the snapshot already shows", () => {
    const queued = chunks(["banner", 1], ["repaint", 2], ["later", 3]);
    expect(texts(outputAfterSnapshot(queued, 2))).toEqual(["later"]);
  });

  it("drops everything when the snapshot is fully caught up", () => {
    const queued = chunks(["a", 1], ["b", 2]);
    expect(outputAfterSnapshot(queued, 2)).toEqual([]);
  });

  it("keeps everything for a session with no snapshot", () => {
    const queued = chunks(["a", 1], ["b", 2]);
    expect(texts(outputAfterSnapshot(queued, undefined))).toEqual(["a", "b"]);
  });

  it("keeps chunks that carry no position of their own", () => {
    const queued = chunks(["unnumbered"], ["covered", 1], ["fresh", 5]);
    expect(texts(outputAfterSnapshot(queued, 3))).toEqual([
      "unnumbered",
      "fresh",
    ]);
  });

  it("preserves arrival order rather than sorting by position", () => {
    const queued = chunks(["second", 9], ["first", 8]);
    expect(texts(outputAfterSnapshot(queued, 7))).toEqual(["second", "first"]);
  });

  it("treats position zero as covering nothing", () => {
    const queued = chunks(["a", 1]);
    expect(texts(outputAfterSnapshot(queued, 0))).toEqual(["a"]);
  });

  it("handles an empty queue", () => {
    expect(outputAfterSnapshot([], 5)).toEqual([]);
  });

  it("does not mutate the queue it was given", () => {
    const queued = chunks(["a", 1], ["b", 2]);
    outputAfterSnapshot(queued, 1);
    expect(texts(queued)).toEqual(["a", "b"]);
  });

  it("returns the queue untouched when there is nothing to drop", () => {
    // The cold-start path runs on every new pane; it should not copy.
    const queued = chunks(["a", 1]);
    expect(outputAfterSnapshot(queued, undefined)).toBe(queued);
  });
});
