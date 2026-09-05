import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { PreferencesManager } from "../preferences";

describe("PreferencesManager tasks → agents key migration (ADR-166)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-prefs-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adopts taskRetentionDays / taskPruneNoticeShown when the new keys are absent", () => {
    fs.writeFileSync(
      path.join(tmpDir, "preferences.json"),
      JSON.stringify({ taskRetentionDays: 7, taskPruneNoticeShown: true }),
    );

    const prefs = new PreferencesManager(tmpDir);

    expect(prefs.get("agentRetentionDays")).toBe(7);
    expect(prefs.get("agentPruneNoticeShown")).toBe(true);
    expect(prefs.getAll()).not.toHaveProperty("taskRetentionDays");
    expect(prefs.getAll()).not.toHaveProperty("taskPruneNoticeShown");
  });

  it("keeps the new keys when both old and new are present", () => {
    fs.writeFileSync(
      path.join(tmpDir, "preferences.json"),
      JSON.stringify({ taskRetentionDays: 7, agentRetentionDays: 30 }),
    );

    const prefs = new PreferencesManager(tmpDir);

    expect(prefs.get("agentRetentionDays")).toBe(30);
  });
});
