import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_SETTLE_MS, TurnSettle } from "../turn-settle";

describe("TurnSettle", () => {
  let changes: boolean[];
  let settle: TurnSettle;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    settle = new TurnSettle((s) => changes.push(s));
  });

  afterEach(() => {
    settle.dispose();
    vi.useRealTimers();
  });

  it("settles after the transcript says done for 3s while hooks say busy", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    expect(settle.settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settle.settled).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("settles on an interrupted turn too", () => {
    settle.setStatus("thinking");
    settle.setTurn("interrupted");
    vi.advanceTimersByTime(TURN_SETTLE_MS);
    expect(settle.settled).toBe(true);
  });

  it("never settles while the transcript says working, or before it says anything", () => {
    settle.setStatus("working");
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    settle.setTurn("working");
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    expect(changes).toEqual([]);
  });

  it("does nothing when hooks already say the turn is over", () => {
    settle.setStatus("responded");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    expect(settle.settled).toBe(false);
  });

  it("starts over on newer transcript activity", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS);
    expect(settle.settled).toBe(true);
    settle.setTurn("working");
    expect(settle.settled).toBe(false);
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    expect(settle.settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false, true]);
  });

  it("keeps Thinking for a prompt just sent while its line lags behind the last turn's end", () => {
    settle.setStatus("idle");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    // The phone sends a prompt: hooks go busy, the transcript still says done.
    settle.setStatus("thinking");
    vi.advanceTimersByTime(5_000);
    expect(settle.settled).toBe(false);
    // The prompt lands, and its turn ends with the Stop hook lost.
    settle.setTurn("working");
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS);
    expect(settle.settled).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("settles a turn whose Stop hook never came", () => {
    settle.setStatus("idle");
    settle.setStatus("thinking");
    settle.setTurn("working");
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    expect(settle.settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settle.settled).toBe(true);
  });

  it("settles once, on time, while hooks flap between working and thinking", () => {
    settle.setStatus("idle");
    settle.setStatus("working");
    settle.setTurn("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(1000);
    settle.setStatus("thinking");
    vi.advanceTimersByTime(1000);
    settle.setStatus("working");
    vi.advanceTimersByTime(1000);
    expect(settle.settled).toBe(true);
    settle.setStatus("thinking");
    settle.setStatus("working");
    expect(settle.settled).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("clears when hooks go idle, and a new busy stretch doesn't revive an old end", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS);
    expect(settle.settled).toBe(true);
    settle.setStatus("responded");
    expect(settle.settled).toBe(false);
    settle.setStatus("thinking");
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    expect(settle.settled).toBe(false);
  });

  it("ignores the same value told again", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    settle.setTurn("done");
    settle.setStatus("working");
    vi.advanceTimersByTime(1);
    expect(settle.settled).toBe(true);
  });

  it("stops its timer on dispose", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    settle.dispose();
    vi.advanceTimersByTime(TURN_SETTLE_MS * 2);
    expect(changes).toEqual([]);
  });
});
