import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts).

describe("setPaneRecordingStartedAt", () => {
  beforeEach(() => {
    useAppStore.setState({ paneRecordingStartedAt: {} });
  });

  it("records a start timestamp for the pane", () => {
    useAppStore.getState().setPaneRecordingStartedAt("pane-1", 1000);

    expect(useAppStore.getState().paneRecordingStartedAt).toEqual({
      "pane-1": 1000,
    });
  });

  it("clears the pane's entry when passed null", () => {
    useAppStore.getState().setPaneRecordingStartedAt("pane-1", 1000);
    useAppStore.getState().setPaneRecordingStartedAt("pane-1", null);

    expect(useAppStore.getState().paneRecordingStartedAt).toEqual({});
  });

  it("clearing a pane with no active recording is a no-op", () => {
    const before = useAppStore.getState().paneRecordingStartedAt;
    useAppStore.getState().setPaneRecordingStartedAt("pane-1", null);

    expect(useAppStore.getState().paneRecordingStartedAt).toBe(before);
  });

  it("tracks multiple panes independently", () => {
    useAppStore.getState().setPaneRecordingStartedAt("pane-1", 1000);
    useAppStore.getState().setPaneRecordingStartedAt("pane-2", 2000);

    expect(useAppStore.getState().paneRecordingStartedAt).toEqual({
      "pane-1": 1000,
      "pane-2": 2000,
    });

    useAppStore.getState().setPaneRecordingStartedAt("pane-1", null);

    expect(useAppStore.getState().paneRecordingStartedAt).toEqual({
      "pane-2": 2000,
    });
  });
});
