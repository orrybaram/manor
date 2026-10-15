import { describe, expect, it, vi } from "vitest";
import type { BridgeTransport } from "../client";
import { recordPairingHello, upsertPairing } from "../pairings";
import { hostSentenceName, memberDisplayName, servers } from "../server-set";
import { base64urlEncode } from "../../lib/relay-crypto";

const hosts = [{ hostId: "box", spec: { kind: "ssh" as const, target: "me@box" } }];


/** A phone whose home server is the relay room of a desktop called desk.local. */
function onPhone(): () => void {
  const map = new Map<string, string>();
  const prior = (globalThis as { localStorage?: Storage }).localStorage;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  const room = "AbCdEfGhIjKlMnOpQr_-01";
  upsertPairing({ roomId: room, serverKey: base64urlEncode(new Uint8Array(32)), token: "t" });
  recordPairingHello(room, { hostName: "desk.local", hostServer: false });
  const transport = { invoke: () => new Promise(() => {}), subscribe: () => () => {} };
  servers.add(room, transport as unknown as BridgeTransport, { home: true, roomId: room });
  return () => {
    servers.remove(room);
    vi.stubGlobal("localStorage", prior);
  };
}

describe("memberDisplayName and hostSentenceName", () => {
  it("keep the usual labels on the desktop", () => {
    expect(memberDisplayName("local", hosts)).toBe("This machine");
    expect(hostSentenceName("local", hosts)).toBe("this machine");
    expect(memberDisplayName("box", hosts)).toBe("me@box");
    expect(hostSentenceName("box", hosts)).toBe("me@box");
  });

  it("name the desktop on a phone, for its own projects only", () => {
    const off = onPhone();
    try {
      expect(memberDisplayName("local", hosts)).toBe("desk.local");
      expect(hostSentenceName("local", hosts)).toBe("desk.local");
      expect(memberDisplayName("box", hosts)).toBe("me@box");
    } finally {
      off();
    }
  });
});
