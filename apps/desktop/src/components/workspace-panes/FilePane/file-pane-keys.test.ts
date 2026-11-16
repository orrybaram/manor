import { describe, expect, it } from "vitest";
import { filePaneKey, filePaneKeyLabel, openFileKey } from "./file-pane-keys";

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: false,
});

describe("⌘⇧F and ⌘F", () => {
  it("⌘⇧F is the pane's Search, not the open file's find", () => {
    expect(filePaneKey(press("F", { meta: true, shift: true }), true)).toBe("search");
    expect(openFileKey(press("F", { meta: true, shift: true }), true)).toBeNull();
    expect(filePaneKey(press("F", { ctrl: true, shift: true }), false)).toBe("search");
  });

  it("⌘F stays the open file's find", () => {
    expect(openFileKey(press("f", { meta: true }), true)).toBe("find");
    expect(filePaneKey(press("f", { meta: true }), true)).toBeNull();
  });

  it("labels Search for a tooltip", () => {
    expect(filePaneKeyLabel("search", true)).toBe("⇧⌘F");
  });
});
