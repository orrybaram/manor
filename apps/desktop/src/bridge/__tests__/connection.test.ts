import { describe, expect, it } from "vitest";

import { settleResult } from "../../../electron/bridge/settle";
import {
  getActiveRoom,
  getConnection,
  isHostServer,
  recordHello,
  setActiveRoom,
  subscribeConnection,
} from "../connection";

describe("connection facts", () => {
  it("is a host server exactly when the hello says hostServer", () => {
    expect(isHostServer()).toBe(false);
    let calls = 0;
    const unsubscribe = subscribeConnection(() => calls++);

    // An older desktop's hello names nothing.
    recordHello({ hostName: null, hostServer: false });
    expect(isHostServer()).toBe(false);
    expect(calls).toBe(0);

    recordHello({ hostName: "Studio", hostServer: true });
    expect(getConnection()).toMatchObject({ hostName: "Studio", isHostServer: true });
    expect(calls).toBe(1);

    // A repeat hello after a reconnect changes nothing.
    const before = getConnection();
    recordHello({ hostName: "Studio", hostServer: true });
    expect(getConnection()).toBe(before);
    expect(calls).toBe(1);

    unsubscribe();
    recordHello({ hostName: null, hostServer: false });
  });

  it("is not a host server when the desktop names itself", () => {
    // The desktop sends its hostname too, without `hostServer`.
    recordHello({ hostName: "desk.local", hostServer: false });
    expect(getConnection()).toMatchObject({
      hostName: "desk.local",
      isHostServer: false,
    });
    recordHello({ hostName: null, hostServer: false });
  });

  it("does not learn it is on a host server from a refused call", () => {
    expect(() =>
      settleResult({ id: 1, kind: "result", ok: false, error: "no", code: "unavailable:host" }),
    ).toThrow();
    expect(isHostServer()).toBe(false);
  });

  it("records the room this page dials", () => {
    setActiveRoom("room");
    expect(getActiveRoom()).toBe("room");
    setActiveRoom(null);
  });
});
