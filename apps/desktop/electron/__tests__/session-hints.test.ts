import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSessionHints } from "../session-hints";
import { assertPromptOverrides } from "../host-server/owner";

const hook = createRequire(import.meta.url)("../scripts/agent-hook.js") as {
  getSessionStartHint(
    env: Record<string, string>,
    homeDir: string,
  ): { hookSpecificOutput: { additionalContext: string } } | null;
  SESSION_START_HINT: unknown;
  REMOTE_SESSION_START_HINT: unknown;
};

describe("the session start hint", () => {
  let home: string;
  const localFile = () => path.join(home, ".manor", "session-hints.json");
  const remoteFile = () => path.join(home, ".manor", "remote", "session-hints.json");
  const remoteEnv = () => ({
    MANOR_CONTROL_PORT_FILE: path.join(home, ".manor", "remote", "control-port"),
    MANOR_HOOK_PORT_FILE: path.join(home, ".manor", "remote", "hook-port"),
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "manor-hints-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("is the built-in text with no edits", () => {
    expect(hook.getSessionStartHint({}, home)).toEqual(hook.SESSION_START_HINT);
    expect(hook.getSessionStartHint(remoteEnv(), home)).toEqual(hook.REMOTE_SESSION_START_HINT);
  });

  it("follows the edit its own server wrote", () => {
    writeSessionHints(localFile(), { sessionHint: "local words", sessionHintRemote: "unused here" });
    writeSessionHints(remoteFile(), { sessionHint: "unused here", sessionHintRemote: "remote words" });
    expect(hook.getSessionStartHint({}, home)?.hookSpecificOutput.additionalContext).toBe("local words");
    expect(hook.getSessionStartHint(remoteEnv(), home)?.hookSpecificOutput.additionalContext).toBe(
      "remote words",
    );
  });

  it("prints nothing when blanked", () => {
    writeSessionHints(localFile(), { sessionHint: " " });
    expect(hook.getSessionStartHint({}, home)).toBeNull();
  });

  it("goes back to the built-in text when the edit is reset", () => {
    writeSessionHints(localFile(), { sessionHint: "words" });
    writeSessionHints(localFile(), {});
    expect(hook.getSessionStartHint({}, home)).toEqual(hook.SESSION_START_HINT);
  });

  it("uses the built-in text when the file can't be read", () => {
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.writeFileSync(localFile(), "{not json");
    expect(hook.getSessionStartHint({}, home)).toEqual(hook.SESSION_START_HINT);
    fs.writeFileSync(localFile(), JSON.stringify({ sessionHint: 7 }));
    expect(hook.getSessionStartHint({}, home)).toEqual(hook.SESSION_START_HINT);
  });

  it("only keeps the hints in the file", () => {
    writeSessionHints(localFile(), { issue: "not for the hook", sessionHint: "x" });
    expect(JSON.parse(fs.readFileSync(localFile(), "utf-8"))).toEqual({ sessionHint: "x" });
  });
});

describe("assertPromptOverrides", () => {
  it("takes known prompts and refuses the rest", () => {
    expect(() => assertPromptOverrides({ issue: "x" })).not.toThrow();
    expect(() => assertPromptOverrides({ nope: "x" })).toThrow(/unknown prompt/);
    expect(() => assertPromptOverrides({ issue: 7 })).toThrow();
    expect(() => assertPromptOverrides(null)).toThrow();
    expect(() => assertPromptOverrides({ issue: "x".repeat(20_001) })).toThrow(/too long/);
  });
});
