import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { KeybindingsManager } from "./keybindings";

// Uses a temp dataDir (electron/__tests__/setup-isolated-home.ts also
// isolates $HOME globally, but KeybindingsManager accepts an explicit
// dataDir so tests don't touch the isolated-home fixture directly).
describe("KeybindingsManager", () => {
  let tmpDir: string;
  let manager: KeybindingsManager;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-keybindings-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new KeybindingsManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("onChange", () => {
    it("supports two listeners, both firing on set", () => {
      const seenA: Record<string, string>[] = [];
      const seenB: Record<string, string>[] = [];
      manager.onChange((overrides) => seenA.push(overrides));
      manager.onChange((overrides) => seenB.push(overrides));

      manager.set("new-tab", "meta+t");

      expect(seenA).toEqual([{ "new-tab": "meta+t" }]);
      expect(seenB).toEqual([{ "new-tab": "meta+t" }]);
    });

    it("stops a listener once its unsubscribe function runs", () => {
      const seenA: Record<string, string>[] = [];
      const seenB: Record<string, string>[] = [];
      const unsubscribeA = manager.onChange((overrides) => seenA.push(overrides));
      manager.onChange((overrides) => seenB.push(overrides));

      manager.set("new-tab", "meta+t");
      unsubscribeA();
      manager.set("close-pane", "meta+w");

      expect(seenA).toEqual([{ "new-tab": "meta+t" }]);
      expect(seenB).toEqual([
        { "new-tab": "meta+t" },
        { "new-tab": "meta+t", "close-pane": "meta+w" },
      ]);
    });

    it("notifies listeners on reset and resetAll too", () => {
      const seen: Record<string, string>[] = [];
      manager.onChange((overrides) => seen.push(overrides));

      manager.set("new-tab", "meta+t");
      manager.reset("new-tab");
      manager.set("close-pane", "meta+w");
      manager.resetAll();

      expect(seen).toEqual([
        { "new-tab": "meta+t" },
        {},
        { "close-pane": "meta+w" },
        {},
      ]);
    });
  });
});
