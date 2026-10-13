import { describe, expect, it } from "vitest";
import { chatTaskKey, parseChatTaskKey } from "../task-key";

describe("chat.taskEntry keys (ADR-224 D3)", () => {
  it("round-trips a pane and a task", () => {
    expect(parseChatTaskKey(chatTaskKey("pane-1", "toolu_01AB"))).toEqual({
      paneId: "pane-1",
      taskId: "toolu_01AB",
    });
  });

  it("splits at the last separator, so a paneId may hold one", () => {
    expect(parseChatTaskKey(chatTaskKey("a/b", "t1"))).toEqual({ paneId: "a/b", taskId: "t1" });
  });

  it("is null for a key that names no task", () => {
    expect(parseChatTaskKey("pane-1")).toBeNull();
    expect(parseChatTaskKey("/t1")).toBeNull();
    expect(parseChatTaskKey("pane-1/")).toBeNull();
  });
});
