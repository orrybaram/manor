/**
 * Pins `orchestratorPrimer()` and the SessionStart hint in
 * `electron/scripts/agent-hook.js` to the same fan-out command names.
 *
 * The hint is a deliberately shorter summary of the primer, so this does not
 * assert string equality — only that the commands load-bearing to the
 * fan-out playbook appear in both.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { orchestratorPrimer } from "../orchestrator-primer";

const AGENT_HOOK_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "electron",
  "scripts",
  "agent-hook.js",
);

/** Extract `additionalContext`'s string literal from the hook script's source. */
function readSessionStartHint(): string {
  const source = fs.readFileSync(AGENT_HOOK_PATH, "utf-8");
  const match = source.match(/additionalContext:\s*\n?\s*"([^"]+)"/);
  if (!match) {
    throw new Error("Could not find additionalContext in agent-hook.js");
  }
  return match[1]!;
}

// Commands ticket-3 requires both the primer and the hint to name as part of
// the fan-out path.
const FAN_OUT_COMMANDS = ["batch-create-workspaces", "list-agents"];

describe("orchestratorPrimer", () => {
  const primer = orchestratorPrimer();

  it("covers the observe/act tool catalog", () => {
    for (const cmd of [
      "list-projects",
      "list-workspaces",
      "list-issues",
      "get-issue-detail",
      "list-panes",
      "list-agents",
      "read-session",
      "create-workspace",
      "batch-create-workspaces",
      "start-agent",
      "send-to-session",
    ]) {
      expect(primer).toContain(cmd);
    }
  });

  it("documents the house rules", () => {
    expect(primer).toMatch(/4 agents/);
    expect(primer.toLowerCase()).toContain("destructive");
    expect(primer.toLowerCase()).toContain("orchestrate");
  });

  it("warns that send-to-session interrupts the target", () => {
    expect(primer.toLowerCase()).toContain("interrupt");
  });
});

describe("agent-hook.js SessionStart hint agrees with the primer", () => {
  it("names every fan-out command the primer names", () => {
    const hint = readSessionStartHint();
    for (const cmd of FAN_OUT_COMMANDS) {
      expect(hint).toContain(cmd);
    }
  });

  it("still points to manor --help", () => {
    const hint = readSessionStartHint();
    expect(hint).toContain("manor --help");
  });

  it("still prefers the CLI over mcp__manor__* tools", () => {
    const hint = readSessionStartHint();
    expect(hint).toContain("mcp__manor__*");
  });
});
