import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../../electron.d";
import { createLatestSearch } from "../useAgentSearch";

const agent = (id: string) => ({ id }) as AgentInfo;

describe("createLatestSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for typing to pause, then asks once with the last query", async () => {
    const run = vi.fn(async (q: string) => [agent(q)]);
    const onResult = vi.fn();
    const s = createLatestSearch(run, onResult, 150);
    s.search("t");
    s.search("to");
    s.search("toast");
    await vi.advanceTimersByTimeAsync(149);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledExactlyOnceWith("toast");
    expect(onResult).toHaveBeenCalledWith([agent("toast")]);
  });

  it("drops a reply that lands after a newer query was sent", async () => {
    const replies: Record<string, (a: AgentInfo[]) => void> = {};
    const run = (q: string) => new Promise<AgentInfo[]>((resolve) => (replies[q] = resolve));
    const onResult = vi.fn();
    const s = createLatestSearch(run, onResult, 10);
    s.search("old");
    await vi.advanceTimersByTimeAsync(10);
    s.search("new");
    await vi.advanceTimersByTimeAsync(10);
    replies.new([agent("new")]);
    await vi.advanceTimersByTimeAsync(0);
    replies.old([agent("old")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult.mock.calls).toEqual([[[agent("new")]]]);
  });

  it("clears at once for an empty query and ignores replies after dispose", async () => {
    let resolve: (a: AgentInfo[]) => void = () => {};
    const run = () => new Promise<AgentInfo[]>((r) => (resolve = r));
    const onResult = vi.fn();
    const s = createLatestSearch(run, onResult, 10);
    s.search("");
    expect(onResult).toHaveBeenCalledWith([]);
    s.search("x");
    await vi.advanceTimersByTimeAsync(10);
    s.dispose();
    resolve([agent("x")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
