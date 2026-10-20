import { describe, it, expect, vi, beforeEach } from "vitest";
import { ptyAttach } from "../pty";
import { attach, ownerOf, releaseViewer, resetAttachments } from "../../../pty-attachments";
import { HostUnavailableError } from "../../../backend/host-view";
import type { HandlerCtx } from "../../method";

/**
 * `pty.attach`: what a viewer resyncing after a dropped connection
 * sends. It must never spawn a shell — the session may have exited while the
 * viewer was away — and never take the winsize off whoever attached meanwhile.
 */

const SNAPSHOT = {
  screenAnsi: "$ ls\r\n",
  seq: 42,
  scrollbackAnsi: "",
  modes: {},
  cwd: "/tmp",
  cols: 120,
  rows: 40,
};

function setup({
  snapshot = SNAPSHOT as typeof SNAPSHOT | null,
  owner = undefined as string | undefined,
  recoverable = false,
} = {}) {
  const pty = {
    attachExisting: vi.fn(async () => snapshot),
    createOrAttachWith: vi.fn(),
    resize: vi.fn(),
    getSnapshot: vi.fn(async () => snapshot),
  };
  const deps = {
    backend: { pty },
    backendRegistry: {
      sessions: {
        ownerOf: vi.fn(() => owner),
        isRecoverableLoss: vi.fn(() => recoverable),
      },
    },
  };
  const ctx = (id: string, callerClass: "local" | "device" = "device") =>
    ({ deps, caller: { id, callerClass } }) as unknown as HandlerCtx;
  return { pty, ctx };
}

describe("pty.attach", () => {
  beforeEach(() => resetAttachments());

  it("answers a live session with its snapshot, and spawns nothing", async () => {
    const { pty, ctx } = setup();
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toMatchObject({
      ok: true,
      snapshot: "$ ls\r\n",
      snapshotSeq: 42,
      hostId: "local",
    });
    expect(pty.attachExisting).toHaveBeenCalledWith("pane-a");
    expect(pty.createOrAttachWith).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it("answers a session that ended with exited, spawns nothing and attaches no one", async () => {
    const { pty, ctx } = setup({ snapshot: null });
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toEqual({ ok: false, reason: "exited" });
    expect(pty.createOrAttachWith).not.toHaveBeenCalled();
    expect(ownerOf("pane-a")).toBeNull();
  });

  it("answers a remote session a daemon restart took with lost", async () => {
    const { ctx } = setup({ snapshot: null, owner: "box", recoverable: true });
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toEqual({ ok: false, reason: "lost" });
  });

  it("reports the host the session runs on", async () => {
    const { ctx } = setup({ owner: "box" });
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toMatchObject({ ok: true, hostId: "box" });
  });

  it("does not take the winsize off a viewer that attached meanwhile", async () => {
    const { ctx } = setup();
    // Phone A owned the pane; phone B attached after it and took over; then
    // A's socket dropped and came back.
    attach("pane-a", { connectionId: "phone-a", callerClass: "device" });
    attach("pane-a", { connectionId: "phone-b", callerClass: "device" });
    releaseViewer("phone-a");

    const result = await ptyAttach(ctx("phone-a"), "pane-a");

    expect(ownerOf("pane-a")?.connectionId).toBe("phone-b");
    // A follows, at the session's grid.
    expect(result).toMatchObject({ ok: true, winsizeOwner: false, cols: 120, rows: 40 });
  });

  it("owns the winsize when it is the only viewer", async () => {
    const { ctx } = setup();
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(ownerOf("pane-a")?.connectionId).toBe("phone");
    expect(result).toMatchObject({ ok: true, winsizeOwner: true });
  });

  it("leaves a viewer that never let go where it was", async () => {
    const { ctx } = setup();
    // A refresh without a drop: the phone still holds the pane, and owns it.
    attach("pane-a", { connectionId: "phone", callerClass: "device" });
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(ownerOf("pane-a")?.connectionId).toBe("phone");
    expect(result).toMatchObject({ ok: true, winsizeOwner: true });
  });

  it("reports a host that is away, as pty.create does", async () => {
    const { pty, ctx } = setup();
    pty.attachExisting.mockRejectedValueOnce(
      new HostUnavailableError("box", "reconnecting"),
    );
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toMatchObject({ ok: false, reason: "host-unavailable", hostId: "box" });
  });

  it("reports any other failure as an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pty, ctx } = setup();
    pty.attachExisting.mockRejectedValueOnce(new Error("daemon said no"));
    const result = await ptyAttach(ctx("phone"), "pane-a");
    expect(result).toEqual({ ok: false, reason: "error", error: "daemon said no" });
  });
});
