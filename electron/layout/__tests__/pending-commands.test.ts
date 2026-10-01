/**
 * `PendingCommands` — the server-side map a pane's first command waits in
 * (ADR-179 ticket 11).
 *
 * Small on purpose: the guarantee that matters is "once". Every producer sets
 * before the pane exists and every `pty.create` takes, so a second viewer
 * mounting the same pane must find nothing.
 */

import { describe, it, expect } from "vitest";
import { PendingCommands } from "../pending-commands";

describe("PendingCommands", () => {
  it("hands a queued command back once", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "pnpm dev");

    expect(pending.take("pane-1")).toEqual({
      text: "pnpm dev",
      kind: "shell",
      submit: true,
    });
    expect(pending.take("pane-1")).toBeNull();
    expect(pending.size).toBe(0);
  });

  it("answers null for a pane nobody queued anything for", () => {
    expect(new PendingCommands().take("pane-unknown")).toBeNull();
  });

  it("keeps the kind it was given", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "claude", "agent-startup");

    expect(pending.take("pane-1")?.kind).toBe("agent-startup");
  });

  it("keeps text that is only to be typed, not run (ADR-183)", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "brew install gh", "shell", { submit: false });

    expect(pending.take("pane-1")?.submit).toBe(false);
  });

  it("keeps panes apart", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "one");
    pending.set("pane-2", "two");

    expect(pending.take("pane-1")?.text).toBe("one");
    expect(pending.take("pane-2")?.text).toBe("two");
  });

  it("replaces a pane's command rather than queuing two", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "first");
    pending.set("pane-1", "second");

    expect(pending.take("pane-1")?.text).toBe("second");
    expect(pending.take("pane-1")).toBeNull();
  });

  it("clears a command whose pane never happened", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "pnpm dev");
    pending.clear("pane-1");

    expect(pending.take("pane-1")).toBeNull();
    expect(pending.size).toBe(0);
  });

  it("requeues a taken command, marked, but never over a newer one", () => {
    const pending = new PendingCommands();
    pending.set("pane-1", "claude", "agent-startup", { submit: true });
    const taken = pending.take("pane-1")!;
    expect(pending.isRequeued("pane-1")).toBe(false);

    pending.requeue("pane-1", taken);
    expect(pending.isRequeued("pane-1")).toBe(true);
    expect(pending.take("pane-1")).toEqual({
      text: "claude",
      kind: "agent-startup",
      submit: true,
      requeued: true,
    });

    pending.set("pane-1", "newer");
    pending.requeue("pane-1", taken);
    expect(pending.take("pane-1")?.text).toBe("newer");
  });
});
