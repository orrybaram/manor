/**
 * The foreground rules both PTY helpers follow, checked against the cases in
 * `__fixtures__/foreground-parity.json`. The native helper's
 * `foreground.rs` runs the same file in `cargo test`, so a rule changed on one
 * side and not the other fails one of the two.
 */
import { describe, it, expect } from "vitest";
import fixture from "../__fixtures__/foreground-parity.json";
import {
  JS_RUNTIMES,
  VERSION_STRING_RE,
  processBasename,
  shellForegroundName,
  shellScriptName,
} from "../foreground-shell";
import { AGENT_COMMAND_PATTERNS, AGENT_NAMES } from "../pane-facts";

describe("foreground parity cases", () => {
  it("lists the agents pane-facts knows, in match order", () => {
    expect(fixture.agentNames).toEqual(AGENT_NAMES);
  });

  it.each(fixture.processBasename)("processBasename(%j) → %j", (name, want) => {
    expect(processBasename(name)).toBe(want);
  });

  it.each(fixture.shellScriptName as [string[], string | null][])(
    "shellScriptName(%j) → %j",
    (argv, want) => {
      expect(shellScriptName(argv)).toBe(want);
    },
  );

  it.each(
    fixture.shellForegroundName as [
      Parameters<typeof shellForegroundName>[0],
      string | null,
    ][],
  )("shellForegroundName(%j) → %j", (input, want) => {
    expect(shellForegroundName(input)).toBe(want);
  });

  it.each(fixture.agentInCommandLine as [string, string | null][])(
    "agent in %j → %j",
    (line, want) => {
      const hit = AGENT_COMMAND_PATTERNS.find(([pattern]) =>
        pattern.test(line),
      );
      expect(hit?.[1] ?? null).toBe(want);
    },
  );

  it.each(fixture.isVersionString as [string, boolean][])(
    "%j is a version string: %j",
    (name, want) => {
      expect(VERSION_STRING_RE.test(name)).toBe(want);
    },
  );

  it("looks below node, deno and bun", () => {
    expect([...JS_RUNTIMES].sort()).toEqual(["bun", "deno", "node"]);
  });
});
