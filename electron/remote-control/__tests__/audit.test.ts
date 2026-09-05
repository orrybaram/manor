/**
 * The audit log's job is to be readable after the fact and to contain nothing
 * that would make it worth stealing. Both are tested here; the "one line per
 * send" behaviour is tested against the real listener in `server.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAuditLog, hashText, type RemoteAuditEntry } from "../audit";

function entry(over: Partial<RemoteAuditEntry> = {}): RemoteAuditEntry {
  return {
    at: "2026-08-23T00:00:00.000Z",
    deviceId: "dev-1",
    deviceLabel: "phone",
    route: "POST /sessions/send",
    target: "agent-1",
    textLength: 5,
    textSha256: hashText("hello"),
    interrupt: false,
    outcome: "sent",
    status: 200,
    ...over,
  };
}

describe("RemoteAuditLog", () => {
  let dir: string;
  let file: string;
  let log: RemoteAuditLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-audit-"));
    file = path.join(dir, "nested", "remote-audit.jsonl");
    log = new RemoteAuditLog(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads back nothing before anything is written", () => {
    expect(log.read()).toEqual([]);
  });

  it("appends one JSON line per entry, in order", () => {
    log.append(entry({ target: "a" }));
    log.append(entry({ target: "b" }));
    expect(log.read().map((e) => e.target)).toEqual(["a", "b"]);
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("creates the file 0600 and keeps it there", () => {
    log.append(entry());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    log.append(entry());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates once past the cap, keeping one generation", () => {
    // Fill past 512 KB with entries that are individually small.
    const big = entry({ target: "x".repeat(1024) });
    while (!fs.existsSync(file) || fs.statSync(file).size < 512 * 1024) {
      log.append(big);
    }
    const beforeRotation = log.read().length;
    log.append(entry({ target: "after-rotation" }));

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    const live = log.read();
    expect(live).toHaveLength(1);
    expect(live[0].target).toBe("after-rotation");
    expect(beforeRotation).toBeGreaterThan(1);
    expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
  });

  it("skips a torn line rather than throwing", () => {
    log.append(entry({ target: "good" }));
    fs.appendFileSync(file, '{"at":"2026-08-2');
    expect(log.read().map((e) => e.target)).toEqual(["good"]);
  });

  it("never throws when the path cannot be written", () => {
    const unwritable = new RemoteAuditLog(path.join(dir, "\0bad", "a.jsonl"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => unwritable.append(entry())).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("hashText", () => {
  it("is a stable sha256 hex digest", () => {
    expect(hashText("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
