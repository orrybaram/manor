import { describe, it, expect, vi } from "vitest";
import { setDiffFingerprints, watchDiffFingerprint } from "../diff-fingerprints";
import type { WorkspaceKey } from "../workspace-key";

const key = (k: string) => k as WorkspaceKey;

describe("watchDiffFingerprint", () => {
  it("does not fire for the first fingerprint a watched workspace gets", () => {
    setDiffFingerprints({});
    const onChange = vi.fn();
    const unwatch = watchDiffFingerprint(key("/a"), onChange);

    // The pane already fetched as it opened: no second fetch.
    setDiffFingerprints({ [key("/a")]: "f1" });
    expect(onChange).not.toHaveBeenCalled();

    setDiffFingerprints({ [key("/a")]: "f2" });
    expect(onChange).toHaveBeenCalledTimes(1);
    unwatch();
  });

  it("fires only when its own workspace's fingerprint moves", () => {
    setDiffFingerprints({ [key("/a")]: "f1", [key("/b")]: "g1" });
    const onChange = vi.fn();
    const unwatch = watchDiffFingerprint(key("/a"), onChange);

    setDiffFingerprints({ [key("/a")]: "f1", [key("/b")]: "g2" });
    expect(onChange).not.toHaveBeenCalled();

    setDiffFingerprints({ [key("/a")]: "f2", [key("/b")]: "g2" });
    expect(onChange).toHaveBeenCalledTimes(1);

    unwatch();
    setDiffFingerprints({ [key("/a")]: "f3" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
