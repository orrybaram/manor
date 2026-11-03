import { describe, expect, it } from "vitest";
import { DEV_SERVER_WAIT_MS, retryDelay, waitsForDevServer } from "./dev-server-wait";

describe("retryDelay", () => {
  it("backs off 1s, 1s, 2s, 3s, 5s, then every 5s", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelay(attempt, 0));
    expect(delays).toEqual([1_000, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000]);
  });

  it("stops once a retry would land past two minutes", () => {
    expect(retryDelay(30, DEV_SERVER_WAIT_MS - 5_000)).toBe(5_000);
    expect(retryDelay(30, DEV_SERVER_WAIT_MS - 4_999)).toBeNull();
  });

  it("retries 26 times over the whole wait: 12s for the first five, then every 5s", () => {
    let elapsed = 0;
    let attempt = 1;
    for (let delay = retryDelay(attempt, elapsed); delay !== null; delay = retryDelay(attempt, elapsed)) {
      elapsed += delay;
      attempt += 1;
    }
    expect(attempt - 1).toBe(26);
    expect(elapsed).toBeLessThanOrEqual(DEV_SERVER_WAIT_MS);
  });
});

describe("waitsForDevServer", () => {
  const REFUSED = -102;

  it("waits on a refused http load of this machine's loopback", () => {
    expect(waitsForDevServer("http://localhost:3000/", REFUSED)).toBe(true);
    expect(waitsForDevServer("http://127.0.0.1:5173/app?x=1", REFUSED)).toBe(true);
    expect(waitsForDevServer("http://[::1]:8080/", REFUSED)).toBe(true);
    expect(waitsForDevServer("http://localhost/", REFUSED)).toBe(true);
  });

  it("never for another error", () => {
    expect(waitsForDevServer("http://localhost:3000/", -105)).toBe(false);
    expect(waitsForDevServer("http://localhost:3000/", -324)).toBe(false);
  });

  it("never for another host or scheme", () => {
    expect(waitsForDevServer("http://example.com:3000/", REFUSED)).toBe(false);
    expect(waitsForDevServer("http://localhost.example.com/", REFUSED)).toBe(false);
    expect(waitsForDevServer("http://10.0.0.2:3000/", REFUSED)).toBe(false);
    expect(waitsForDevServer("https://localhost:3000/", REFUSED)).toBe(false);
  });

  it("for a remote pane, also waits on how its port forward reports the box refused", () => {
    const FORWARD = "http://127.0.0.1:49152/";
    for (const code of [REFUSED, -324, -100, -101]) {
      expect(waitsForDevServer(FORWARD, code, true)).toBe(true);
    }
    expect(waitsForDevServer(FORWARD, -105, true)).toBe(false);
    expect(waitsForDevServer(FORWARD, -118, true)).toBe(false);
  });

  it("for a local pane, a closed or reset connection is a real error", () => {
    for (const code of [-324, -100, -101]) {
      expect(waitsForDevServer("http://localhost:3000/", code)).toBe(false);
      expect(waitsForDevServer("http://localhost:3000/", code, false)).toBe(false);
    }
  });

  it("for a remote pane, still only a loopback http load", () => {
    expect(waitsForDevServer("http://example.com:3000/", -324, true)).toBe(false);
    expect(waitsForDevServer("https://127.0.0.1:49152/", -324, true)).toBe(false);
  });
});
