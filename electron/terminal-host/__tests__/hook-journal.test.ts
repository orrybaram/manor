import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { HookJournal } from "../hook-journal";

const payload = (n: number) => ({ paneId: `p${n}`, eventType: "Stop", kind: "claude" });

describe("HookJournal", () => {
  let dir: string;
  let file: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-hook-journal-"));
    file = path.join(dir, "daemon", "hook-journal.ndjson");
    now = 1_000_000;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function lines(): unknown[] {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("hands out consecutive seqs from 1 and replays after a seq", () => {
    const journal = new HookJournal(file, { now: clock });
    journal.open();
    expect(journal.lastSeq).toBe(0);
    expect(journal.append(payload(1)).seq).toBe(1);
    expect(journal.append(payload(2)).seq).toBe(2);
    expect(journal.append(payload(3)).seq).toBe(3);
    expect(journal.since(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(journal.since(0).map((e) => e.payload)).toEqual([payload(1), payload(2), payload(3)]);
  });

  it("writes the file with mode 0600", () => {
    const journal = new HookJournal(file, { now: clock });
    journal.open();
    journal.append(payload(1));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("recovers the last seq across a restart", () => {
    const first = new HookJournal(file, { now: clock });
    first.open();
    for (let i = 1; i <= 5; i++) first.append(payload(i));

    const second = new HookJournal(file, { now: clock });
    second.open();
    expect(second.lastSeq).toBe(5);
    expect(second.since(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(second.append(payload(6)).seq).toBe(6);
  });

  it("tolerates a torn last line, and the next append does not land on it", () => {
    const first = new HookJournal(file, { now: clock });
    first.open();
    first.append(payload(1));
    first.append(payload(2));
    // A crash mid-append: half a line, no newline.
    fs.appendFileSync(file, '{"seq":3,"receivedAt":1000000,"payl');

    const second = new HookJournal(file, { now: clock });
    second.open();
    expect(second.lastSeq).toBe(2);
    expect(second.append(payload(3)).seq).toBe(3);

    const third = new HookJournal(file, { now: clock });
    third.open();
    expect(third.lastSeq).toBe(3);
    expect(third.since(0).map((e) => e.payload)).toEqual([payload(1), payload(2), payload(3)]);
  });

  it("caps the entry count, keeping the newest, on compaction", () => {
    const journal = new HookJournal(file, { now: clock, maxEntries: 3, compactEvery: 1000 });
    journal.open();
    for (let i = 1; i <= 10; i++) journal.append(payload(i));
    journal.compact();
    expect(journal.since(0).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(journal.lastSeq).toBe(10);
  });

  it("compacts every N appends", () => {
    const journal = new HookJournal(file, { now: clock, maxEntries: 3, compactEvery: 5 });
    journal.open();
    for (let i = 1; i <= 5; i++) journal.append(payload(i));
    // The fifth append compacted: watermark + the newest three.
    expect(lines()).toHaveLength(4);
  });

  it("drops entries older than the age cap", () => {
    const journal = new HookJournal(file, { now: clock, maxAgeMs: 1000 });
    journal.open();
    journal.append(payload(1));
    now += 600;
    journal.append(payload(2));
    now += 600;
    // Entry 1 is past the cap even before compaction runs.
    expect(journal.since(0).map((e) => e.seq)).toEqual([2]);
    journal.compact();
    expect(journal.since(0).map((e) => e.seq)).toEqual([2]);
  });

  it("keeps seq monotonic when every entry has aged out (watermark)", () => {
    const first = new HookJournal(file, { now: clock, maxAgeMs: 1000 });
    first.open();
    for (let i = 1; i <= 4; i++) first.append(payload(i));
    now += 5000;

    const second = new HookJournal(file, { now: clock, maxAgeMs: 1000 });
    second.open(); // compacts: nothing survives
    expect(second.since(0)).toEqual([]);
    expect(second.lastSeq).toBe(4);

    const third = new HookJournal(file, { now: clock, maxAgeMs: 1000 });
    third.open();
    expect(third.lastSeq).toBe(4);
    expect(third.append(payload(5)).seq).toBe(5);
  });

  it("opens a missing file as an empty journal", () => {
    const journal = new HookJournal(file, { now: clock });
    journal.open();
    expect(journal.lastSeq).toBe(0);
    expect(journal.since(0)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});
