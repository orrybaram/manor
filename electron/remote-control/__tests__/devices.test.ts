/**
 * The device store is the whole boundary behind the relay, so these tests
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
  const ROOM = "room-a";

  it("pairs a device whose token verifies", () => {
    const s = store();
    const { device, rawToken } = s.pair("Orry's phone", ROOM);
    const verified = s.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(verified?.label).toBe("Orry's phone");
    expect(verified?.relayRoom).toBe(ROOM);
  });

  it("mints a distinct high-entropy token per device", () => {
    const s = store();
    const a = s.pair("a", ROOM).rawToken;
    const b = s.pair("b", ROOM).rawToken;
    expect(a).not.toBe(b);
    // 32 random bytes, base64url — no padding, comfortably over 40 chars.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a mutated token", () => {
    const s = store();
    const { rawToken } = s.pair("phone", ROOM);
    const mutated =
      rawToken.slice(0, -1) + (rawToken.endsWith("A") ? "B" : "A");
    expect(s.verify(mutated)).toBeNull();
  });

  it("rejects a wrong-length or non-string token without throwing", () => {
    const s = store();
    s.pair("phone", ROOM);
    expect(s.verify("")).toBeNull();
    expect(s.verify("short")).toBeNull();
    expect(s.verify("x".repeat(4096))).toBeNull();
    expect(s.verify(undefined)).toBeNull();
    expect(s.verify(null)).toBeNull();
    expect(s.verify(42)).toBeNull();
  });

  it("only matches the device the token belongs to", () => {
    const s = store();
    const first = s.pair("first", ROOM);
    const second = s.pair("second", ROOM);
    expect(s.verify(first.rawToken)?.id).toBe(first.device.id);
    expect(s.verify(second.rawToken)?.id).toBe(second.device.id);
  });

  it("revokes immediately, through a live store", () => {
    const s = store();
    const { device, rawToken } = s.pair("phone", ROOM);
    expect(s.verify(rawToken)).not.toBeNull();
    s.revoke(device.id);
    expect(s.verify(rawToken)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it("revoking one device leaves the others working", () => {
    const s = store();
    const doomed = s.pair("doomed", ROOM);
    const kept = s.pair("kept", ROOM);
    s.revoke(doomed.device.id);
    expect(s.verify(doomed.rawToken)).toBeNull();
    expect(s.verify(kept.rawToken)?.id).toBe(kept.device.id);
  });

  it("never exposes the token hash through list()", () => {
    const s = store();
    s.pair("phone", ROOM);
    const listed = s.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0]).not.toHaveProperty("relayRoom");
  });

  it("round-trips through the file, and never writes the raw token", () => {
    const first = store();
    const { device, rawToken } = first.pair("phone", ROOM);

    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain(rawToken);

    const reopened = new RemoteDeviceStore(file);
    const verified = reopened.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(onDisk).not.toContain('"via"');
    expect(onDisk).not.toContain('"capability"');
  });

  it("writes the device file 0600", () => {
    const s = store();
    s.pair("phone", ROOM);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A second write must not relax it.
    s.pair("laptop", ROOM);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("records lastSeenAt on a successful verify", () => {
    const s = store();
    const { rawToken } = s.pair("phone", ROOM);
    expect(s.list()[0].lastSeenAt).toBeNull();
    s.verify(rawToken);
    expect(s.list()[0].lastSeenAt).toBeTypeOf("number");
  });

  it("refuses to store when the OS cannot encrypt", () => {
    keychain.available = false;
    const s = store();
    expect(() => s.pair("phone", ROOM)).toThrow(EncryptionUnavailableError);
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
   * ADR-207 D5: the relay is the only road and every device reaches the
   * whole bridge, so a row that is not a relay pairing — a Tailscale device,
   * or a Watch or Reply one — is dropped on load and purged from disk. The
   * user re-pairs through the relay.
   */
  describe("rows from older releases", () => {
    /** Write rows straight into the (fake-)encrypted file. */
    function writeRows(rows: unknown[]): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        Buffer.from(`enc:${JSON.stringify(rows)}`, "utf8"),
      );
    }

    const onDisk = () => fs.readFileSync(file, "utf8");

    /** A relay pairing as ADR-206 wrote it: `via` and `capability` and all. */
    const relayRow = (id: string, hashChar = "a") => ({
      id,
      label: id,
      tokenHash: hashChar.repeat(64),
      capability: "full",
      via: "relay",
      relayRoom: ROOM,
      createdAt: 1,
      lastSeenAt: null,
    });

    it("keeps a relay row, and rewrites it without `via` or `capability`", () => {
      writeRows([relayRow("browser")]);
      expect(
        store()
          .list()
          .map((d) => d.id),
      ).toEqual(["browser"]);
      expect(onDisk()).not.toContain('"via"');
      expect(onDisk()).not.toContain('"capability"');
      expect(onDisk()).toContain(`"relayRoom":"${ROOM}"`);
    });

    it("drops a row from before ADR-206, which has no `via`", () => {
      const { via: _via, relayRoom: _room, ...noVia } = relayRow("old");
      writeRows([noVia]);
      expect(store().list()).toEqual([]);
      expect(onDisk()).not.toContain('"old"');
    });

    it("drops a tailscale row, and rewrites the file without it", () => {
      writeRows([
        { ...relayRow("ts", "b"), via: "tailscale", relayRoom: null },
        relayRow("browser"),
      ]);
      expect(
        store()
          .list()
          .map((d) => d.id),
      ).toEqual(["browser"]);
      expect(onDisk()).not.toContain('"ts"');
      expect(onDisk()).not.toContain("tailscale");
    });

    it("drops a read row", () => {
      writeRows([{ ...relayRow("watcher"), capability: "read" }]);
      expect(store().list()).toEqual([]);
      expect(onDisk()).not.toContain("watcher");
    });

    it("drops a send row", () => {
      writeRows([{ ...relayRow("replier"), capability: "send" }]);
      expect(store().list()).toEqual([]);
    });

    it("drops a pre-ADR-178 canSend row", () => {
      const { capability: _capability, ...rest } = relayRow("sender");
      writeRows([{ ...rest, canSend: true }]);
      expect(store().list()).toEqual([]);
      expect(onDisk()).not.toContain("canSend");
    });

    it("drops a relay row with no recorded room", () => {
      writeRows([{ ...relayRow("roomless"), relayRoom: null }]);
      expect(store().list()).toEqual([]);
    });

    it("keeps the token working across the rewrite", () => {
      const before = store();
      const { rawToken } = before.pair("phone", ROOM);
      const stored = JSON.parse(onDisk().replace(/^enc:/, "")) as Record<
        string,
        unknown
      >[];
      writeRows(
        stored.map((row) => ({ ...row, capability: "full", via: "relay" })),
      );
      expect(new RemoteDeviceStore(file).verify(rawToken)?.label).toBe("phone");
      expect(onDisk()).not.toContain('"via"');
    });

    it("leaves an already-clean file alone", () => {
      writeRows([relayRow("browser")]);
      store().list();
      const afterFirst = onDisk();
      const mtime = fs.statSync(file).mtimeMs;
      store().list();
      expect(onDisk()).toBe(afterFirst);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    });

    it("remembers which relay room a device's link points at", () => {
      const s = store();
      const old = s.pair("old", "room-a");
      s.pair("current", "room-b");
      const reloaded = store();
      expect(reloaded.idsInOtherRelayRooms("room-b")).toEqual([old.device.id]);
      expect(reloaded.idsInOtherRelayRooms("room-a")).toHaveLength(1);
      expect(reloaded.ids()).toHaveLength(2);
      expect(JSON.stringify(reloaded.list())).not.toContain("room-");
    });

    it("carries fields it does not know through a rewrite", () => {
      writeRows([{ ...relayRow("browser"), futureField: { x: 1 } }]);
      const s = store();
      s.pair("another", ROOM);
      expect(onDisk()).toContain('"futureField":{"x":1}');
      expect(onDisk()).not.toContain('"via"');
      expect(JSON.stringify(s.list())).not.toContain("futureField");
    });
  });

  it("drops persisted rows that are not well-formed devices", () => {
    const rows = [
      {
        id: "ok",
        label: "l",
        tokenHash: "a".repeat(64),
        relayRoom: ROOM,
        createdAt: 1,
        lastSeenAt: null,
      },
      { id: "no-hash", label: "l", relayRoom: ROOM, createdAt: 1 },
      {
        id: "bad-hash",
        label: "l",
        tokenHash: "zz",
        relayRoom: ROOM,
        createdAt: 1,
      },
      {
        id: "no-room",
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
