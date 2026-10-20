import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const serializeImport = vi.hoisted(() => vi.fn());
const serialize = vi.hoisted(() => vi.fn(() => "grid contents"));

vi.mock("@xterm/addon-serialize", () => {
  serializeImport();
  return {
    SerializeAddon: class {
      serialize = serialize;
    },
  };
});

import { registerTerminal, unregisterTerminal } from "../terminal-registry";

function makeTerm() {
  return { loadAddon: vi.fn() } as unknown as Terminal & {
    loadAddon: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  unregisterTerminal("pane-1");
  unregisterTerminal("pane-2");
});

describe("terminal registry", () => {
  it("exposes each registered terminal on the window", () => {
    const term = makeTerm();
    registerTerminal("pane-1", term);

    expect(window.__manorTerminals?.get("pane-1")?.term).toBe(term);

    unregisterTerminal("pane-1");
    expect(window.__manorTerminals?.has("pane-1")).toBe(false);
  });

  it("loads the serializer only when a snapshot is asked for", async () => {
    const term = makeTerm();
    registerTerminal("pane-1", term);
    expect(term.loadAddon).not.toHaveBeenCalled();

    const handle = window.__manorTerminals!.get("pane-1")!;
    await expect(handle.serialize({ scrollback: 100 })).resolves.toBe(
      "grid contents",
    );

    expect(serializeImport).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith({ scrollback: 100 });
  });

  it("loads the serializer onto a terminal once, however many snapshots", async () => {
    const term = makeTerm();
    registerTerminal("pane-2", term);
    const handle = window.__manorTerminals!.get("pane-2")!;

    await Promise.all([handle.serialize(), handle.serialize()]);
    await handle.serialize();

    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });
});
