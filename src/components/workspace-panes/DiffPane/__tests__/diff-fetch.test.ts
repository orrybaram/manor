import { describe, it, expect, vi } from "vitest";
import { createSingleFlight } from "../diff-fetch";

/** A fetch that resolves when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  it("never overlaps two fetches for one key, and queues one more at most", async () => {
    const request = createSingleFlight<string>();
    const fetches = [deferred<string>(), deferred<string>()];
    let running = 0;
    let peak = 0;
    const run = vi.fn(() => {
      const d = fetches[run.mock.calls.length - 1];
      running++;
      peak = Math.max(peak, running);
      return d.promise.finally(() => running--);
    });

    const first = request("ws", run);
    const second = request("ws", run);
    const third = request("ws", run);
    expect(run).toHaveBeenCalledTimes(1);
    // The later requests share the one queued fetch.
    expect(third).toBe(second);

    fetches[0].resolve("old");
    await expect(first).resolves.toBe("old");
    expect(run).toHaveBeenCalledTimes(2);

    fetches[1].resolve("new");
    await expect(second).resolves.toBe("new");
    expect(run).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it("runs the queued fetch after a failed one", async () => {
    const request = createSingleFlight<string>();
    const failing = deferred<string>();
    const first = request("ws", () => failing.promise);
    const second = request("ws", async () => "retry");
    failing.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("retry");
  });

  it("keeps different keys independent", async () => {
    const request = createSingleFlight<string>();
    const hang = deferred<string>();
    void request("local", () => hang.promise);
    const other = vi.fn(async () => "full");
    await expect(request("full", other)).resolves.toBe("full");
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("starts afresh once the key is idle", async () => {
    const request = createSingleFlight<string>();
    await request("ws", async () => "a");
    const run = vi.fn(async () => "b");
    await expect(request("ws", run)).resolves.toBe("b");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
