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

  it("starts over when the hook status moves", () => {
    settle.setStatus("working");
    settle.setTurn("done");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1000);
    settle.setStatus("thinking");
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    expect(settle.settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settle.settled).toBe(true);
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
