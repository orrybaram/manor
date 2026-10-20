/**
 * Queued commands for panes no layout holds yet (`../held-commands.ts`):
 * they go with the layout command that names the pane, else home.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeldCommands } from "../held-commands";

function setup() {
  const sent: Array<[string, unknown[]]> = [];
  const held = createHeldCommands<string>({
    send: (target, args) => {
      sent.push([target, args]);
      return Promise.resolve();
    },
    home: () => "home",
    holdMs: 100,
  });
  return { held, sent };
}

describe("held pending commands", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a held command with the layout command that names its pane", async () => {
    const { held, sent } = setup();
    await held.hold(["p1", "ls"]);
    expect(sent).toEqual([]);
    held.releaseFor("layout", "apply", ["/w", { pane: { id: "p2" } }], "box");
    expect(sent).toEqual([]);
    held.releaseFor("layout", "apply", ["/w", { tabs: [{ paneId: "p1" }] }], "box");
    expect(sent).toEqual([["box", ["p1", "ls"]]]);
    held.releaseFor("layout", "apply", ["/w", "p1"], "box");
    expect(sent).toHaveLength(1);
  });

  it("ignores calls other than layout.apply", async () => {
    const { held, sent } = setup();
    await held.hold(["p1", "ls"]);
    held.releaseFor("pty", "write", ["p1", "x"], "box");
    expect(sent).toEqual([]);
  });

  it("sends a command no layout command claimed home, once it has waited", async () => {
    vi.useFakeTimers();
    const { held, sent } = setup();
    await held.hold(["p1", "ls"]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([["home", ["p1", "ls"]]]);
  });

  it("sends a second command for the same pane after the first, which goes home", async () => {
    const { held, sent } = setup();
    await held.hold(["p1", "one"]);
    await held.hold(["p1", "two"]);
    expect(sent).toEqual([["home", ["p1", "one"]]]);
    held.releaseFor("layout", "apply", ["/w", "p1"], "box");
    expect(sent).toEqual([
      ["home", ["p1", "one"]],
      ["box", ["p1", "two"]],
    ]);
  });

  it("sends args with no pane id home at once", async () => {
    const { held, sent } = setup();
    await held.hold([42]);
    expect(sent).toEqual([["home", [42]]]);
  });
});
