import { describe, it, expect } from "vitest";

// Importing this module at top level is itself the module-import guard: the
// vitest default environment is node (no `window`/`navigator` defined), so if
// `keybinding-defs.ts` referenced either, this import would throw before any
// test body ran.
import {
  BROWSER_RESERVED_COMBOS,
  DEFAULT_KEYBINDINGS,
  comboMatches,
  comboToAccelerator,
  commandsForCombo,
  isBindableCombo,
  isBrowserReservedCombo,
  platformDefaults,
  resolveBindings,
  resolvePageKey,
  type KeyCombo,
} from "../keybinding-defs";

function combo(overrides: Partial<KeyCombo> & { key: string }): KeyCombo {
  return {
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

describe("comboToAccelerator", () => {
  it("renders Cmd+Shift+D for meta+shift+d on mac", () => {
    expect(
      comboToAccelerator(combo({ key: "d", meta: true, shift: true }), "mac"),
    ).toBe("Cmd+Shift+D");
  });

  it("renders Ctrl+Cmd+Down for meta+ctrl+ArrowDown on mac", () => {
    expect(
      comboToAccelerator(
        combo({ key: "ArrowDown", meta: true, ctrl: true }),
        "mac",
      ),
    ).toBe("Ctrl+Cmd+Down");
  });

  it("renders Alt+Cmd+\\ for meta+alt+backslash on mac", () => {
    expect(
      comboToAccelerator(combo({ key: "\\", meta: true, alt: true }), "mac"),
    ).toBe("Alt+Cmd+\\");
  });

  it("maps Escape to Esc", () => {
    expect(
      comboToAccelerator(combo({ key: "Escape", meta: true }), "mac"),
    ).toBe("Cmd+Esc");
  });

  it("maps Enter to Return", () => {
    expect(comboToAccelerator(combo({ key: "Enter", meta: true }), "mac")).toBe(
      "Cmd+Return",
    );
  });

  it('maps " " to Space', () => {
    expect(comboToAccelerator(combo({ key: " ", meta: true }), "mac")).toBe(
      "Cmd+Space",
    );
  });

  it("renders Ctrl+Shift+D for a non-mac combo", () => {
    expect(
      comboToAccelerator(combo({ key: "d", ctrl: true, shift: true }), "other"),
    ).toBe("Ctrl+Shift+D");
  });
});

describe("resolveBindings", () => {
  it("merges an override, marks it overridden, and leaves others at defaults", () => {
    const { bindings, overriddenIds } = resolveBindings(
      { "new-tab": "shift+t" },
      "MacIntel",
    );

    expect(overriddenIds.has("new-tab")).toBe(true);
    expect(overriddenIds.size).toBe(1);
    expect(bindings["new-tab"]).toEqual({
      key: "t",
      meta: false,
      ctrl: false,
      shift: true,
      alt: false,
    });

    // An id not present in overrides keeps the mac default (meta-based).
    expect(bindings["close-pane"]).toEqual({
      key: "w",
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
  });

  it("uses ctrl instead of meta for defaults on a non-mac platform", () => {
    const { bindings } = resolveBindings({}, "Win32");
    expect(bindings["close-pane"]).toEqual({
      key: "w",
      meta: false,
      ctrl: true,
      shift: false,
      alt: false,
    });
  });
});

describe("DEFAULT_KEYBINDINGS", () => {
  it("has unique ids", () => {
    const ids = DEFAULT_KEYBINDINGS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes next-workspace and prev-workspace", () => {
    const ids = DEFAULT_KEYBINDINGS.map((d) => d.id);
    expect(ids).toContain("next-workspace");
    expect(ids).toContain("prev-workspace");
  });
});

describe("comboMatches", () => {
  it("matches letters in either case", () => {
    expect(
      comboMatches(
        combo({ key: "E", meta: true, shift: true }),
        combo({ key: "e", meta: true, shift: true }),
      ),
    ).toBe(true);
  });

  it("requires the modifiers to match exactly", () => {
    expect(
      comboMatches(
        combo({ key: "t", meta: true, shift: true }),
        combo({ key: "t", meta: true }),
      ),
    ).toBe(false);
  });

  it("does not fold case for named keys", () => {
    expect(comboMatches(combo({ key: "f6" }), combo({ key: "F6" }))).toBe(
      false,
    );
  });
});

describe("isBindableCombo", () => {
  it("accepts a modified key", () => {
    expect(isBindableCombo(combo({ key: "k", meta: true }))).toBe(true);
    expect(isBindableCombo(combo({ key: "k", alt: true }))).toBe(true);
  });

  it("accepts a bare function key", () => {
    expect(isBindableCombo(combo({ key: "F6" }))).toBe(true);
  });

  it("rejects a bare or shift-only key", () => {
    expect(isBindableCombo(combo({ key: "k" }))).toBe(false);
    expect(isBindableCombo(combo({ key: "K", shift: true }))).toBe(false);
  });
});

describe("commandsForCombo", () => {
  const { bindings } = resolveBindings({}, "MacIntel");

  it("lists every command bound to the combo, in registry order", () => {
    expect(commandsForCombo(combo({ key: "]", meta: true }), bindings)).toEqual(
      ["next-pane", "browser-forward"],
    );
  });

  it("returns nothing for an unbound or unbindable key", () => {
    expect(commandsForCombo(combo({ key: "c", meta: true }), bindings)).toEqual(
      [],
    );
    expect(commandsForCombo(combo({ key: "t" }), bindings)).toEqual([]);
  });
});

describe("resolvePageKey", () => {
  const mac = resolveBindings({}, "MacIntel").bindings;

  it("keeps the browser's own keys in the page", () => {
    const cases: [KeyCombo, string][] = [
      [combo({ key: "[", meta: true }), "browser-back"],
      [combo({ key: "]", meta: true }), "browser-forward"],
      [combo({ key: "l", meta: true }), "browser-focus-url"],
      [combo({ key: "r", meta: true }), "browser-reload"],
      [combo({ key: "f", meta: true }), "browser-find"],
      [combo({ key: "=", meta: true }), "browser-zoom-in"],
      [combo({ key: "-", meta: true }), "browser-zoom-out"],
      [combo({ key: "0", meta: true }), "browser-zoom-reset"],
    ];
    for (const [c, commandId] of cases) {
      expect(resolvePageKey(c, mac), commandId).toEqual({
        kind: "browser",
        commandId,
      });
    }
  });

  it("forwards any other bound combo to the app", () => {
    expect(resolvePageKey(combo({ key: "k", meta: true }), mac)).toEqual({
      kind: "app",
      commandId: "command-palette",
    });
    expect(
      resolvePageKey(combo({ key: "]", meta: true, shift: true }), mac),
    ).toEqual({ kind: "app", commandId: "next-tab" });
    expect(
      resolvePageKey(combo({ key: "ArrowDown", meta: true, ctrl: true }), mac),
    ).toEqual({ kind: "app", commandId: "next-workspace" });
  });

  it("forwards F6 and Shift+F6", () => {
    expect(resolvePageKey(combo({ key: "F6" }), mac)).toEqual({
      kind: "app",
      commandId: "focus-next-region",
    });
    expect(resolvePageKey(combo({ key: "F6", shift: true }), mac)).toEqual({
      kind: "app",
      commandId: "focus-prev-region",
    });
  });

  it("leaves unbound combos and plain typing to the page", () => {
    expect(resolvePageKey(combo({ key: "c", meta: true }), mac)).toBeNull();
    expect(resolvePageKey(combo({ key: "a" }), mac)).toBeNull();
    expect(resolvePageKey(combo({ key: "Escape" }), mac)).toBeNull();
  });

  it("follows the user's overrides", () => {
    const { bindings } = resolveBindings(
      { "command-palette": "meta+shift+p", "browser-reload": "meta+shift+r" },
      "MacIntel",
    );
    expect(
      resolvePageKey(combo({ key: "k", meta: true }), bindings),
    ).toBeNull();
    expect(
      resolvePageKey(combo({ key: "P", meta: true, shift: true }), bindings),
    ).toEqual({ kind: "app", commandId: "command-palette" });
    expect(
      resolvePageKey(combo({ key: "r", meta: true }), bindings),
    ).toBeNull();
    expect(
      resolvePageKey(combo({ key: "r", meta: true, shift: true }), bindings),
    ).toEqual({ kind: "browser", commandId: "browser-reload" });
  });

  it("never forwards terminal search", () => {
    const { bindings } = resolveBindings(
      { "browser-find": "meta+alt+f" },
      "MacIntel",
    );
    expect(
      resolvePageKey(combo({ key: "f", meta: true }), bindings),
    ).toBeNull();
  });

  it("uses Ctrl bindings off macOS", () => {
    const win = resolveBindings({}, "Win32").bindings;
    expect(resolvePageKey(combo({ key: "r", ctrl: true }), win)).toEqual({
      kind: "browser",
      commandId: "browser-reload",
    });
    expect(resolvePageKey(combo({ key: "k", ctrl: true }), win)).toEqual({
      kind: "app",
      commandId: "command-palette",
    });
  });
});

// ADR-181 D7 — a PC browser keeps the desktop keybindings, minus the ones it
// cannot have.
describe("platformDefaults in a browser, on a Mac", () => {
  const webDefs = platformDefaults("MacIntel", { inBrowser: true });
  const byId = Object.fromEntries(webDefs.map((def) => [def.id, def]));

  it("leaves the browser-reserved commands with no default combo", () => {
    // Cmd+W, Cmd+T and Cmd+N — whichever commands land on them by default.
    for (const def of DEFAULT_KEYBINDINGS) {
      if (def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)) {
        expect(byId[def.id].defaultCombo).toBeUndefined();
      }
    }
    // Confirms the loop above actually exercised something.
    expect(
      DEFAULT_KEYBINDINGS.some(
        (def) => def.defaultCombo && isBrowserReservedCombo(def.defaultCombo),
      ),
    ).toBe(true);
  });

  it("leaves every other default unchanged", () => {
    for (const def of DEFAULT_KEYBINDINGS) {
      if (def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)) {
        continue;
      }
      expect(byId[def.id].defaultCombo).toEqual(def.defaultCombo);
    }
  });

  it("keeps the reserved commands reachable — bindable, just unbound", () => {
    for (const def of DEFAULT_KEYBINDINGS) {
      if (def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)) {
        expect(byId[def.id]).toBeDefined();
      }
    }
  });
});

/**
 * The regression this guards: an earlier version of D7 passed a `"web"`
 * platform that meant "Mac-style", so a Windows or Linux browser got ⌘
 * shortcuts it cannot type. The OS picks ⌘ versus Ctrl; the browser only
 * removes the chords it keeps for itself. Both must hold at once.
 */
describe("platformDefaults in a browser, off a Mac", () => {
  const winBrowser = platformDefaults("Win32", { inBrowser: true });
  const winDesk = platformDefaults("Win32");
  const byId = Object.fromEntries(winBrowser.map((def) => [def.id, def]));

  it("uses Ctrl, not ⌘, for every default it keeps", () => {
    for (const def of winBrowser) {
      if (!def.defaultCombo) continue;
      expect(def.defaultCombo.meta).toBe(false);
    }
  });

  it("drops the Ctrl forms of the reserved chords", () => {
    for (const def of winDesk) {
      if (def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)) {
        expect(byId[def.id].defaultCombo).toBeUndefined();
      }
    }
    expect(
      winDesk.some(
        (def) => def.defaultCombo && isBrowserReservedCombo(def.defaultCombo),
      ),
    ).toBe(true);
  });

  it("otherwise matches the Windows desktop defaults exactly", () => {
    for (const def of winDesk) {
      if (def.defaultCombo && isBrowserReservedCombo(def.defaultCombo)) {
        continue;
      }
      expect(byId[def.id].defaultCombo).toEqual(def.defaultCombo);
    }
  });
});

describe("isBrowserReservedCombo", () => {
  it("flags Cmd+W", () => {
    expect(isBrowserReservedCombo(combo({ key: "w", meta: true }))).toBe(true);
  });

  it("flags Cmd+T and Cmd+N, and their Ctrl equivalents off macOS", () => {
    expect(isBrowserReservedCombo(combo({ key: "t", meta: true }))).toBe(true);
    expect(isBrowserReservedCombo(combo({ key: "n", meta: true }))).toBe(true);
    expect(isBrowserReservedCombo(combo({ key: "w", ctrl: true }))).toBe(true);
    expect(isBrowserReservedCombo(combo({ key: "t", ctrl: true }))).toBe(true);
    expect(isBrowserReservedCombo(combo({ key: "n", ctrl: true }))).toBe(true);
  });

  it("does not flag Cmd+Shift+W (close-tab) or an unrelated key", () => {
    expect(
      isBrowserReservedCombo(combo({ key: "w", meta: true, shift: true })),
    ).toBe(false);
    expect(isBrowserReservedCombo(combo({ key: "k", meta: true }))).toBe(false);
  });

  it("every listed combo round-trips through the export", () => {
    for (const reserved of BROWSER_RESERVED_COMBOS) {
      expect(isBrowserReservedCombo(reserved)).toBe(true);
    }
  });
});
