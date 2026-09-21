/**
 * `ptyCreate` typing a pane's queued command.
 *
 * The consumer end of `PendingCommands`: the moment a pane has a shell, the
 * line someone queued for it is written — once, by whichever viewer's
 * `pty.create` got there first, and never on a reattach to a session that was
 * already running.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ptyCreate } from "../pty";
import { localCtx } from "../../method";
import { resetAttachments } from "../../../pty-attachments";
import type { HostDeps } from "../../../ipc/types";
import { PendingCommands } from "../../../layout/pending-commands";

const PANE = "pane-1";

describe("ptyCreate and pending commands", () => {
  let pendingCommands: PendingCommands;
  let writes: Array<[string, string]>;
  let afterReady: Array<[string, string]>;
  /** What `createOrAttach` reports: a snapshot means the session existed. */
  let snapshot: { screenAnsi: string; seq: number } | null;
  let adopted: Set<string>;
  let deps: HostDeps;

  beforeEach(() => {
    pendingCommands = new PendingCommands();
    writes = [];
    afterReady = [];
    snapshot = null;
    adopted = new Set();
    deps = {
      backend: {
        pty: {
          createOrAttach: async () => ({ session: {}, snapshot }),
          write: (paneId: string, data: string) => {
            writes.push([paneId, data]);
          },
          writeAfterReady: async (paneId: string, data: string) => {
            afterReady.push([paneId, data]);
          },
        },
      },
      layoutStore: { pendingCommands },
      prewarmManager: {
        claimAdopted: (paneId: string) => adopted.delete(paneId),
      },
    } as unknown as HostDeps;
  });

  // A successful create attaches its caller as a viewer of the pane.
  afterEach(() => resetAttachments());

  it("writes the queued command when the session is fresh", async () => {
    pendingCommands.set(PANE, "echo hello");

    const result = await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(result.ok).toBe(true);
    // `\r`, not `\n`: that is what an Enter keypress sends, and zsh's line
    // editor does not reliably accept `\n`.
    expect(afterReady).toEqual([[PANE, "echo hello\r"]]);
    expect(writes).toEqual([]);
  });

  it("writes it exactly once — a second viewer finds nothing to take", async () => {
    pendingCommands.set(PANE, "echo hello");

    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);
    // The second viewer's create reattaches to the session the first one made.
    snapshot = { screenAnsi: "hello", seq: 1 };
    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(afterReady).toEqual([[PANE, "echo hello\r"]]);
  });

  it("writes nothing when the pane has no queued command", async () => {
    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(afterReady).toEqual([]);
  });

  it("does not write on a reattach to a session that already existed", async () => {
    // A browser opening a pane the desktop has had open for an hour. Anything
    // still queued for it belongs to a mount that already happened.
    snapshot = { screenAnsi: "old output", seq: 7 };
    pendingCommands.set(PANE, "echo hello");

    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(afterReady).toEqual([]);
    expect(pendingCommands.take(PANE)).not.toBeNull();
  });

  it("writes into an adopted prewarmed session, which is a cold start in disguise", async () => {
    // The prewarm manager warmed this session in the background, so it
    // reports a snapshot — but the pane adopting it has never run anything,
    // and `startNewAgent` only queues a line when the warm session was not
    // already given one.
    snapshot = { screenAnsi: "", seq: 0 };
    adopted.add(PANE);
    pendingCommands.set(PANE, "claude", "agent-startup");

    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(afterReady).toEqual([[PANE, "claude\r"]]);
  });

  it("does not write again for a second viewer of an adopted prewarmed pane", async () => {
    snapshot = { screenAnsi: "", seq: 0 };
    adopted.add(PANE);
    pendingCommands.set(PANE, "claude", "agent-startup");

    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);
    pendingCommands.set(PANE, "claude", "agent-startup");
    await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    expect(afterReady).toEqual([[PANE, "claude\r"]]);
  });

  it("still answers ok when the write fails", async () => {
    pendingCommands.set(PANE, "echo hello");
    (
      deps.backend.pty as unknown as { writeAfterReady: () => Promise<void> }
    ).writeAfterReady = async () => {
      throw new Error("daemon went away");
    };

    const result = await ptyCreate(localCtx(deps), PANE, "/repo", 80, 24);

    // The caller has its session; a command that did not land is not a reason
    // to fail the pane it was meant for.
    expect(result.ok).toBe(true);
  });
});
