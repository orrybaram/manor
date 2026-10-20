import { describe, expect, it } from "vitest";
import { pendingDisplay, type HostDisplay } from "../../../lib/host-status";
import { LOCAL_HOST_ID } from "../../../lib/hosts";
import { projectHostStatus } from "./project-host-status";

// One word per project host row.
describe("projectHostStatus", () => {
  it("shows Local, in no tone, for this machine", () => {
    expect(projectHostStatus(LOCAL_HOST_ID, undefined)).toEqual({ word: "Local", tone: null });
  });

  it("shows a remote host's status in its tone", () => {
    const display = { target: "wsl-box", offline: false, busy: false, tone: "ok", status: "Connected", banner: "", canRetry: false } as HostDisplay;
    expect(projectHostStatus("wsl-box", display)).toEqual({ word: "Connected", tone: "ok" });
  });

  it("falls back to the pending display for a remote host not yet reported", () => {
    const pending = pendingDisplay("wsl-box");
    expect(projectHostStatus("wsl-box", undefined)).toEqual({ word: pending.status, tone: pending.tone });
  });
});
