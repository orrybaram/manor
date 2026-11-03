import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../preferences";

describe("PreferencesManager.onChange", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tells every subscriber, so one can't silently replace another", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-prefs-"));
    dirs.push(dir);
    const manager = new PreferencesManager(dir);
    const first = vi.fn();
    const second = vi.fn();
    manager.onChange(first);
    manager.onChange(second);
    manager.set("chatFontFamily", "Literata");
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ chatFontFamily: "Literata" }));
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ chatFontFamily: "Literata" }));
    manager.flush();
  });
});
