import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptDefinition } from "../../../src/lib/prompts/catalog";
import { PreferencesManager } from "../../preferences";
import { preferencesSet, preferencesSetPrompt } from "./preferences";
import type { HandlerCtx } from "../method";
import type { ServerDeps } from "../../ipc/types";

describe("preferencesSetPrompt", () => {
  let dir: string;
  let prefs: PreferencesManager;
  let ctx: HandlerCtx<ServerDeps>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-prompts-"));
    prefs = new PreferencesManager(dir);
    ctx = { deps: { preferencesManager: prefs } } as unknown as HandlerCtx<ServerDeps>;
  });

  afterEach(() => {
    prefs.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saves an edit and leaves the others alone", () => {
    preferencesSetPrompt(ctx, "issue", "A {{issue}}");
    preferencesSetPrompt(ctx, "prChecks", "B {{checks}}");
    expect(prefs.get("promptOverrides")).toEqual({ issue: "A {{issue}}", prChecks: "B {{checks}}" });
  });

  it("forgets an edit on reset, and on saving the default text", () => {
    preferencesSetPrompt(ctx, "issue", "A");
    preferencesSetPrompt(ctx, "prChecks", "B");
    preferencesSetPrompt(ctx, "issue", null);
    preferencesSetPrompt(ctx, "prChecks", promptDefinition("prChecks").template);
    expect(prefs.get("promptOverrides")).toEqual({});
  });

  it("keeps a blank session hint, which means no hint", () => {
    preferencesSetPrompt(ctx, "sessionHint", "");
    expect(prefs.get("promptOverrides")).toEqual({ sessionHint: "" });
  });

  it("refuses a blank task prompt, an unknown prompt and text too long", () => {
    expect(() => preferencesSetPrompt(ctx, "issue", "  ")).toThrow(/blank/);
    expect(() => preferencesSetPrompt(ctx, "constructor", "x")).toThrow(/unknown prompt/);
    expect(() => preferencesSetPrompt(ctx, "issue", "x".repeat(20_001))).toThrow(/too long/);
    expect(prefs.get("promptOverrides")).toEqual({});
  });

  it("can't be reached through the generic setter", () => {
    expect(() => preferencesSet(ctx, "promptOverrides" as never, {} as never)).toThrow(/cannot write/);
  });
});
