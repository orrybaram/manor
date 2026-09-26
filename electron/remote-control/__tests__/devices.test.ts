/**
 * The device store is the whole boundary once a tunnel is up, so these tests
 * are written against the properties ADR-161 §2 leans on rather than against
 * the implementation: a token verifies once and only as itself, revocation is
 * not cached, the raw token never lands on disk, and a machine that cannot
 * encrypt refuses to store rather than degrading.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `vi.hoisted` because the `electron` mock factory is hoisted above the module
 * body: a plain `let` would still be in its temporal dead zone when the factory
 * first runs.
 */
const keychain = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

import { RemoteDeviceStore, EncryptionUnavailableError } from "../devices";
import { AuthRateLimiter } from "../rate-limit";

describe("RemoteDeviceStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    keychain.available = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-remote-devices-"));
    file = path.join(dir, "nested", "remote-devices.enc");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = () => new RemoteDeviceStore(file);

  it("pairs a device whose token verifies", () => {
    const s = store();
    const { device, rawToken } = s.pair("Orry's phone", "read");
    const verified = s.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(verified?.label).toBe("Orry's phone");
    expect(verified?.capability).toBe("read");
  });

  it("mints a distinct high-entropy token per device", () => {
    const s = store();
    const a = s.pair("a", "read").rawToken;
    const b = s.pair("b", "read").rawToken;
    expect(a).not.toBe(b);
    // 32 random bytes, base64url — no padding, comfortably over 40 chars.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a mutated token", () => {
    const s = store();
    const { rawToken } = s.pair("phone", "read");
    const mutated =
      rawToken.slice(0, -1) + (rawToken.endsWith("A") ? "B" : "A");
    expect(s.verify(mutated)).toBeNull();
  });

  it("rejects a wrong-length or non-string token without throwing", () => {
    const s = store();
    s.pair("phone", "read");
    expect(s.verify("")).toBeNull();
    expect(s.verify("short")).toBeNull();
    expect(s.verify("x".repeat(4096))).toBeNull();
    expect(s.verify(undefined)).toBeNull();
    expect(s.verify(null)).toBeNull();
    expect(s.verify(42)).toBeNull();
  });

  it("only matches the device the token belongs to", () => {
    const s = store();
    const first = s.pair("first", "send");
    const second = s.pair("second", "read");
    expect(s.verify(first.rawToken)?.id).toBe(first.device.id);
    expect(s.verify(second.rawToken)?.id).toBe(second.device.id);
  });

  it("revokes immediately, through a live store", () => {
    const s = store();
    const { device, rawToken } = s.pair("phone", "read");
    expect(s.verify(rawToken)).not.toBeNull();
    s.revoke(device.id);
    expect(s.verify(rawToken)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it("revoking one device leaves the others working", () => {
    const s = store();
    const doomed = s.pair("doomed", "read");
    const kept = s.pair("kept", "read");
    s.revoke(doomed.device.id);
    expect(s.verify(doomed.rawToken)).toBeNull();
    expect(s.verify(kept.rawToken)?.id).toBe(kept.device.id);
  });

  it("never exposes the token hash through list()", () => {
    const s = store();
    s.pair("phone", "send");
    const listed = s.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0].capability).toBe("send");
  });

  it("round-trips through the file, and never writes the raw token", () => {
    const first = store();
    const { device, rawToken } = first.pair("phone", "full");

    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain(rawToken);

    const reopened = new RemoteDeviceStore(file);
    const verified = reopened.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(verified?.capability).toBe("full");
  });

  it("writes the device file 0600", () => {
    const s = store();
    s.pair("phone", "read");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A second write must not relax it.
    s.pair("laptop", "read");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("records lastSeenAt on a successful verify", () => {
    const s = store();
    const { rawToken } = s.pair("phone", "read");
    expect(s.list()[0].lastSeenAt).toBeNull();
    s.verify(rawToken);
    expect(s.list()[0].lastSeenAt).toBeTypeOf("number");
  });

  it("refuses to store when the OS cannot encrypt", () => {
    keychain.available = false;
    const s = store();
    expect(() => s.pair("phone", "read")).toThrow(EncryptionUnavailableError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("starts empty when the file is unreadable rather than throwing", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from("not-encrypted-garbage"));
    const s = store();
    expect(s.list()).toEqual([]);
    expect(s.verify("anything")).toBeNull();
  });

  /**
   * ADR-178 replaced the `canSend` boolean with a three-way tier. Every device
   * paired before it is on disk in the old shape, and a user who re-pairs
   * every phone because of a refactor is a user who was failed by it.
   */
  describe("migrating a pre-ADR-178 record", () => {
    /** Write the old shape straight into the (fake-)encrypted file. */
    function writeLegacy(rows: Record<string, unknown>[]): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        Buffer.from(`enc:${JSON.stringify(rows)}`, "utf8"),
      );
    }

    const legacy = (id: string, canSend: boolean) => ({
      id,
      label: id,
      tokenHash: (id === "sender" ? "a" : "b").repeat(64),
      canSend,
      createdAt: 1,
      lastSeenAt: null,
    });

    it("maps canSend true to send and false to read", () => {
      writeLegacy([legacy("sender", true), legacy("reader", false)]);
      const listed = store().list();
      expect(listed.map((d) => [d.id, d.capability])).toEqual([
        ["sender", "send"],
        ["reader", "read"],
      ]);
    });

    it("never migrates anything up to full", () => {
      writeLegacy([legacy("sender", true)]);
      expect(store().list()[0].capability).not.toBe("full");
    });

    it("writes the new shape back, dropping the old key", () => {
      writeLegacy([legacy("sender", true)]);
      store().list();
      const onDisk = fs.readFileSync(file, "utf8");
      expect(onDisk).toContain('"capability":"send"');
      expect(onDisk).not.toContain("canSend");
    });

    it("leaves an already-migrated file alone", () => {
      writeLegacy([legacy("sender", true)]);
      store().list();
      const afterFirst = fs.readFileSync(file, "utf8");
      const mtime = fs.statSync(file).mtimeMs;
      store().list();
      expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    });

    it("keeps the token working across the migration", () => {
      const before = store();
      const { rawToken } = before.pair("phone", "send");
      // Rewrite the file in the shape the old code would have left it in.
      const stored = JSON.parse(
        fs.readFileSync(file, "utf8").replace(/^enc:/, ""),
      ) as Record<string, unknown>[];
      writeLegacy(
        stored.map(({ capability: _capability, ...rest }) => ({
          ...rest,
          canSend: true,
        })),
      );

      const reopened = new RemoteDeviceStore(file);
      expect(reopened.verify(rawToken)?.capability).toBe("send");
    });

    it("prefers an explicit capability over a stale canSend", () => {
      writeLegacy([{ ...legacy("sender", false), capability: "full" }]);
      expect(store().list()[0].capability).toBe("full");
    });
  });

  it("drops persisted rows that are not well-formed devices", () => {
    const rows = [
      {
        id: "ok",
        label: "l",
        tokenHash: "a".repeat(64),
        capability: "read",
        createdAt: 1,
        lastSeenAt: null,
      },
      { id: "no-hash", label: "l", capability: "read", createdAt: 1 },
      {
        id: "bad-hash",
        label: "l",
        tokenHash: "zz",
        capability: "read",
        createdAt: 1,
      },
      {
        // Neither shape: no tier to migrate from and none declared.
        id: "no-tier",
        label: "l",
        tokenHash: "b".repeat(64),
        createdAt: 1,
      },
      null,
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(`enc:${JSON.stringify(rows)}`, "utf8"));
    expect(
      store()
        .list()
        .map((d) => d.id),
    ).toEqual(["ok"]);
  });
});

describe("AuthRateLimiter", () => {
  let now = 0;
  const limiter = () => new AuthRateLimiter(() => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it("allows an address it has never seen", () => {
    expect(limiter().retryAfterMs("1.2.3.4")).toBe(0);
  });

  it("backs off exponentially from 1s and caps at 60s", () => {
    const l = limiter();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) seen.push(l.recordFailure("1.2.3.4"));
    expect(seen.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(seen[seen.length - 1]).toBe(60_000);
  });

  it("blocks until the delay elapses", () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.retryAfterMs("1.2.3.4")).toBe(1000);
    now += 999;
    expect(l.retryAfterMs("1.2.3.4")).toBe(1);
    now += 1;
    expect(l.retryAfterMs("1.2.3.4")).toBe(0);
  });

  it("tracks addresses independently", () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.retryAfterMs("5.6.7.8")).toBe(0);
  });

  it("clears history on success", () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    l.recordSuccess("1.2.3.4");
    expect(l.retryAfterMs("1.2.3.4")).toBe(0);
    expect(l.failureCount("1.2.3.4")).toBe(0);
  });

  it("sweeps idle entries so the map cannot grow unbounded", () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.size).toBe(1);
    l.sweep();
    expect(l.size).toBe(1); // still blocked — not eligible
    now += 11 * 60_000;
    l.sweep();
    expect(l.size).toBe(0);
  });

  it("stop() is safe without start(), and start() is idempotent", () => {
    const l = limiter();
    expect(() => l.stop()).not.toThrow();
    l.start();
    l.start();
    expect(() => l.stop()).not.toThrow();
  });
});
