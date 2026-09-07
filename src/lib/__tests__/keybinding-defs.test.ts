import { describe, it, expect } from "vitest";

// Importing this module at top level is itself the module-import guard: the
// vitest default environment is node (no `window`/`navigator` defined), so if
// `keybinding-defs.ts` referenced either, this import would throw before any
// test body ran.
import {
  DEFAULT_KEYBINDINGS,
  comboToAccelerator,
  resolveBindings,
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
    expect(comboToAccelerator(combo({ key: "Escape", meta: true }), "mac")).toBe(
      "Cmd+Esc",
    );
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
      comboToAccelerator(
        combo({ key: "d", ctrl: true, shift: true }),
        "other",
      ),
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
