import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushProgressEvent } from "../../../../electron.d";
import { clearRecords, toastStore } from "../../../../toast/toast-store";
import { startPush } from "./push";

let emit: ((evt: PushProgressEvent) => void) | null = null;
const unsubscribe = vi.fn();
const pushApi = {
  start: vi.fn().mockResolvedValue({ pushId: "/ws", startedAt: 0 }),
  cancel: vi.fn().mockResolvedValue(undefined),
  onProgress: vi.fn((cb: (evt: PushProgressEvent) => void) => {
    emit = cb;
    return unsubscribe;
  }),
};

const only = () => {
  const toasts = toastStore.getState().toasts;
  expect(toasts).toHaveLength(1);
  return toasts[0];
};

beforeEach(() => {
  vi.useFakeTimers();
  clearRecords();
  emit = null;
  unsubscribe.mockClear();
  pushApi.start.mockClear();
  pushApi.onProgress.mockClear();
  (window.electronAPI as unknown as Record<string, unknown>).git = {
    push: pushApi,
  };
});

afterEach(() => {
  clearRecords();
  vi.useRealTimers();
});

describe("startPush", () => {
  it("counts up, shows git's latest line, then settles as Pushed and stops listening", async () => {
    await startPush("/ws");
    expect(pushApi.start).toHaveBeenCalledWith({ wsPath: "/ws", setUpstream: undefined });
    expect(only()).toMatchObject({ status: "loading", message: "Pushing… 0s" });

    vi.advanceTimersByTime(2000);
    emit?.({ pushId: "/ws", type: "line", line: "Writing objects" });
    expect(only()).toMatchObject({ message: "Pushing… 2s", detail: "Writing objects" });

    emit?.({ pushId: "/ws", type: "done", exitCode: 0, stderr: "" });
    expect(only()).toMatchObject({ status: "success", message: "Pushed" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores another workspace's progress", async () => {
    await startPush("/ws");
    emit?.({ pushId: "/other", type: "done", exitCode: 0, stderr: "" });
    expect(only().status).toBe("loading");
    emit?.({ pushId: "/ws", type: "done", exitCode: 0, stderr: "" });
  });

  it("does nothing while the workspace's push is still running", async () => {
    await startPush("/ws");
    await startPush("/ws");
    expect(pushApi.start).toHaveBeenCalledTimes(1);
    emit?.({ pushId: "/ws", type: "done", exitCode: 0, stderr: "" });
  });

  it("reports a cancel as cancelled, not as git's error", async () => {
    await startPush("/ws");
    only().action?.onClick();
    expect(pushApi.cancel).toHaveBeenCalledWith("/ws");
    emit?.({ pushId: "/ws", type: "done", exitCode: 143, stderr: "killed" });
    expect(only()).toMatchObject({ status: "error", message: "Push cancelled" });
  });

  it("offers to set the upstream when the branch has none, and pushes with it", async () => {
    await startPush("/ws");
    const stderr = "fatal: The current branch feat has no upstream branch.";
    emit?.({ pushId: "/ws", type: "done", exitCode: 128, stderr });
    const failed = only();
    expect(failed).toMatchObject({ status: "error", detail: stderr });
    expect(failed.action).toBeDefined();

    failed.action?.onClick();
    await vi.waitFor(() =>
      expect(pushApi.start).toHaveBeenLastCalledWith({ wsPath: "/ws", setUpstream: true }),
    );
    emit?.({ pushId: "/ws", type: "done", exitCode: 0, stderr: "" });
  });

  it("fails the toast when the host refuses to start", async () => {
    pushApi.start.mockRejectedValueOnce(new Error("A push is already in progress"));
    await startPush("/ws");
    expect(only()).toMatchObject({ status: "error" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
