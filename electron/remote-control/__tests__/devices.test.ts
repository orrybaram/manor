/**
 * The device store is the whole boundary behind the relay, so these tests
 * are written against the properties ADR-161 §2 leans on rather than against
 * the implementation: a token verifies once and only as itself, revocation is
 * not cached, the raw token never lands on disk, and a machine that cannot
 * encrypt refuses to store rather than degrading.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteDeviceStore } from "../devices";
import { EncryptionUnavailableError } from "../../platform/sealed-store";
import {
  plainFileSecretBox,
  SecretBoxUnavailableError,
  type SecretBox,
} from "../../platform/secret-box";
import { switchableBox } from "../../platform/__tests__/switchable-box";
import { AuthRateLimiter } from "../rate-limit";

describe("RemoteDeviceStore", () => {
  let dir: string;
  let file: string;
  const keychain = switchableBox();
  let opened: RemoteDeviceStore[] = [];

  beforeEach(() => {
    keychain.setAvailable(true);
    opened = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-remote-devices-"));
    file = path.join(dir, "nested", "remote-devices.enc");
  });

  afterEach(async () => {
    await Promise.all(opened.map((s) => s.flush()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A store over the file, initialised the way the app does it. */
  const store = async () => {
    const s = new RemoteDeviceStore(keychain, file);
    await s.init();
    opened.push(s);
    return s;
  };
  /** The file's contents once every queued write has landed. */
  const diskText = async () => {
    await Promise.all(opened.map((s) => s.flush()));
    return fs.readFileSync(file, "utf8");
  };
  const ROOM = "room-a";

  it("pairs a device whose token verifies", async () => {
    const s = await store();
    const { device, rawToken } = await s.pair("Orry's phone", ROOM);
    const verified = s.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(verified?.label).toBe("Orry's phone");
    expect(verified?.relayRoom).toBe(ROOM);
  });

  it("mints a distinct high-entropy token per device", async () => {
    const s = await store();
    const a = (await s.pair("a", ROOM)).rawToken;
    const b = (await s.pair("b", ROOM)).rawToken;
    expect(a).not.toBe(b);
    // 32 random bytes, base64url — no padding, comfortably over 40 chars.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a mutated token", async () => {
    const s = await store();
    const { rawToken } = await s.pair("phone", ROOM);
    const mutated =
      rawToken.slice(0, -1) + (rawToken.endsWith("A") ? "B" : "A");
    expect(s.verify(mutated)).toBeNull();
  });

  it("rejects a wrong-length or non-string token without throwing", async () => {
    const s = await store();
    await s.pair("phone", ROOM);
    expect(s.verify("")).toBeNull();
    expect(s.verify("short")).toBeNull();
    expect(s.verify("x".repeat(4096))).toBeNull();
    expect(s.verify(undefined)).toBeNull();
    expect(s.verify(null)).toBeNull();
    expect(s.verify(42)).toBeNull();
  });

  it("only matches the device the token belongs to", async () => {
    const s = await store();
    const first = await s.pair("first", ROOM);
    const second = await s.pair("second", ROOM);
    expect(s.verify(first.rawToken)?.id).toBe(first.device.id);
    expect(s.verify(second.rawToken)?.id).toBe(second.device.id);
  });

  it("revokes immediately, through a live store", async () => {
    const s = await store();
    const { device, rawToken } = await s.pair("phone", ROOM);
    expect(s.verify(rawToken)).not.toBeNull();
    await s.revoke(device.id);
    expect(s.verify(rawToken)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it("revoking one device leaves the others working", async () => {
    const s = await store();
    const doomed = await s.pair("doomed", ROOM);
    const kept = await s.pair("kept", ROOM);
    await s.revoke(doomed.device.id);
    expect(s.verify(doomed.rawToken)).toBeNull();
    expect(s.verify(kept.rawToken)?.id).toBe(kept.device.id);
  });

  it("never exposes the token hash through list()", async () => {
    const s = await store();
    await s.pair("phone", ROOM);
    const listed = s.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0]).not.toHaveProperty("relayRoom");
  });

  it("round-trips through the file, and never writes the raw token", async () => {
    const first = await store();
    const { device, rawToken } = await first.pair("phone", ROOM);

    const onDisk = await diskText();
    expect(onDisk).not.toContain(rawToken);

    const reopened = await store();
    const verified = reopened.verify(rawToken);
    expect(verified?.id).toBe(device.id);
    expect(onDisk).not.toContain('"via"');
    expect(onDisk).not.toContain('"capability"');
  });

  it("writes the device file 0600", async () => {
    const s = await store();
    await s.pair("phone", ROOM);
    await s.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A second write must not relax it.
    await s.pair("laptop", ROOM);
    await s.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("records lastSeenAt on a successful verify", async () => {
    const s = await store();
    const { rawToken } = await s.pair("phone", ROOM);
    expect(s.list()[0].lastSeenAt).toBeNull();
    s.verify(rawToken);
    expect(s.list()[0].lastSeenAt).toBeTypeOf("number");
  });

  it("refuses to store when the OS cannot encrypt", async () => {
    keychain.setAvailable(false);
    const s = await store();
    await expect(s.pair("phone", ROOM)).rejects.toThrow(
      EncryptionUnavailableError,
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("starts empty when the file is unreadable rather than throwing", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from("not-encrypted-garbage"));
    const s = await store();
    expect(s.list()).toEqual([]);
    expect(s.verify("anything")).toBeNull();
  });

  it("leaves the file alone when the secret box could not run", async () => {
    await (await store()).pair("phone", ROOM);
    const before = await diskText();
    const broken: SecretBox = {
      ...plainFileSecretBox,
      decrypt: async () => {
        throw new SecretBoxUnavailableError("helper timed out");
      },
    };
    const s = new RemoteDeviceStore(broken, file);
    await expect(s.init()).rejects.toThrow(SecretBoxUnavailableError);
    expect(() => s.list()).toThrow(/init/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  describe("a write that fails", () => {
    let failWrites = false;
    const flaky: SecretBox = {
      ...plainFileSecretBox,
      encrypt: async (plain) => {
        if (failWrites) throw new Error("disk full");
        return Buffer.from(plain);
      },
    };
    beforeEach(() => {
      failWrites = false;
    });

    it("rejects the pair, drops the device, and keeps refusing", async () => {
      const s = new RemoteDeviceStore(flaky, file);
      await s.init();
      failWrites = true;
      await expect(s.pair("phone", ROOM)).rejects.toThrow("disk full");
      expect(s.list()).toEqual([]);
      failWrites = false;
      // The store's disk state is unknown now; it does not pretend otherwise.
      await expect(s.pair("tablet", ROOM)).rejects.toThrow("disk full");
      await expect(s.flush()).rejects.toThrow("disk full");
      expect(fs.existsSync(file)).toBe(false);
    });

    it("rejects the revoke, which still takes effect in memory", async () => {
      const s = new RemoteDeviceStore(flaky, file);
      await s.init();
      const { device, rawToken } = await s.pair("phone", ROOM);
      failWrites = true;
      await expect(s.revoke(device.id)).rejects.toThrow("disk full");
      expect(s.verify(rawToken)).toBeNull();
      // On disk it is still paired, which is why the caller must hear this.
      const reopened = await store();
      expect(reopened.list().map((d) => d.id)).toEqual([device.id]);
    });

    it("does not turn a valid hello away over a lastSeenAt write", async () => {
      const s = new RemoteDeviceStore(flaky, file);
      await s.init();
      const { device, rawToken } = await s.pair("phone", ROOM);
      failWrites = true;
      expect(s.verify(rawToken)?.id).toBe(device.id);
    });
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
        Buffer.from(JSON.stringify(rows), "utf8"),
      );
    }


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

    it("keeps a relay row, and rewrites it without `via` or `capability`", async () => {
      writeRows([relayRow("browser")]);
      expect(
        (await store())
          .list()
          .map((d) => d.id),
      ).toEqual(["browser"]);
      expect((await diskText())).not.toContain('"via"');
      expect((await diskText())).not.toContain('"capability"');
      expect((await diskText())).toContain(`"relayRoom":"${ROOM}"`);
    });

    it("drops a row from before ADR-206, which has no `via`", async () => {
      const { via: _via, relayRoom: _room, ...noVia } = relayRow("old");
      writeRows([noVia]);
      expect((await store()).list()).toEqual([]);
      expect((await diskText())).not.toContain('"old"');
    });

    it("drops a tailscale row, and rewrites the file without it", async () => {
      writeRows([
        { ...relayRow("ts", "b"), via: "tailscale", relayRoom: null },
        relayRow("browser"),
      ]);
      expect(
        (await store())
          .list()
          .map((d) => d.id),
      ).toEqual(["browser"]);
      expect((await diskText())).not.toContain('"ts"');
      expect((await diskText())).not.toContain("tailscale");
    });

    it("drops a read row", async () => {
      writeRows([{ ...relayRow("watcher"), capability: "read" }]);
      expect((await store()).list()).toEqual([]);
      expect((await diskText())).not.toContain("watcher");
    });

    it("drops a send row", async () => {
      writeRows([{ ...relayRow("replier"), capability: "send" }]);
      expect((await store()).list()).toEqual([]);
    });

    it("drops a pre-ADR-178 canSend row", async () => {
      const { capability: _capability, ...rest } = relayRow("sender");
      writeRows([{ ...rest, canSend: true }]);
      expect((await store()).list()).toEqual([]);
      expect((await diskText())).not.toContain("canSend");
    });

    it("drops a relay row with no recorded room", async () => {
      writeRows([{ ...relayRow("roomless"), relayRoom: null }]);
      expect((await store()).list()).toEqual([]);
    });

    it("keeps the token working across the rewrite", async () => {
      const before = await store();
      const { rawToken } = await before.pair("phone", ROOM);
      const stored = JSON.parse((await diskText())) as Record<
        string,
        unknown
      >[];
      writeRows(
        stored.map((row) => ({ ...row, capability: "full", via: "relay" })),
      );
      expect((await store()).verify(rawToken)?.label).toBe("phone");
      expect((await diskText())).not.toContain('"via"');
    });

    it("leaves an already-clean file alone", async () => {
      writeRows([relayRow("browser")]);
      (await store()).list();
      const afterFirst = (await diskText());
      const mtime = fs.statSync(file).mtimeMs;
      (await store()).list();
      expect((await diskText())).toBe(afterFirst);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    });

    it("remembers which relay room a device's link points at", async () => {
      const s = await store();
      const old = await s.pair("old", "room-a");
      await s.pair("current", "room-b");
      await s.flush();
      const reloaded = await store();
      expect(reloaded.idsInOtherRelayRooms("room-b")).toEqual([old.device.id]);
      expect(reloaded.idsInOtherRelayRooms("room-a")).toHaveLength(1);
      expect(reloaded.ids()).toHaveLength(2);
      expect(JSON.stringify(reloaded.list())).not.toContain("room-");
    });

    it("carries fields it does not know through a rewrite", async () => {
      writeRows([{ ...relayRow("browser"), futureField: { x: 1 } }]);
      const s = await store();
      await s.pair("another", ROOM);
      expect((await diskText())).toContain('"futureField":{"x":1}');
      expect((await diskText())).not.toContain('"via"');
      expect(JSON.stringify(s.list())).not.toContain("futureField");
    });
  });

  it("drops persisted rows that are not well-formed devices", async () => {
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
    fs.writeFileSync(file, Buffer.from(JSON.stringify(rows), "utf8"));
    expect(
      (await store())
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

  it("allows an address it has never seen", async () => {
    expect(limiter().retryAfterMs("1.2.3.4")).toBe(0);
  });

  it("backs off exponentially from 1s and caps at 60s", async () => {
    const l = limiter();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) seen.push(l.recordFailure("1.2.3.4"));
    expect(seen.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(seen[seen.length - 1]).toBe(60_000);
  });

  it("blocks until the delay elapses", async () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.retryAfterMs("1.2.3.4")).toBe(1000);
    now += 999;
    expect(l.retryAfterMs("1.2.3.4")).toBe(1);
    now += 1;
    expect(l.retryAfterMs("1.2.3.4")).toBe(0);
  });

  it("tracks addresses independently", async () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.retryAfterMs("5.6.7.8")).toBe(0);
  });

  it("clears history on success", async () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    l.recordSuccess("1.2.3.4");
    expect(l.retryAfterMs("1.2.3.4")).toBe(0);
    expect(l.failureCount("1.2.3.4")).toBe(0);
  });

  it("sweeps idle entries so the map cannot grow unbounded", async () => {
    const l = limiter();
    l.recordFailure("1.2.3.4");
    expect(l.size).toBe(1);
    l.sweep();
    expect(l.size).toBe(1); // still blocked — not eligible
    now += 11 * 60_000;
    l.sweep();
    expect(l.size).toBe(0);
  });

  it("stop() is safe without start(), and start() is idempotent", async () => {
    const l = limiter();
    expect(() => l.stop()).not.toThrow();
    l.start();
    l.start();
    expect(() => l.stop()).not.toThrow();
  });
});
