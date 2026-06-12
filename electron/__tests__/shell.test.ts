import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the generated dotfiles into a temp dir so we can assert on the
// .zshrc contents without touching the real zdotdir.
const tmpRoot = path.join(os.tmpdir(), "manor-shell-test");
const zdotdir = path.join(tmpRoot, "zdotdir");

vi.mock("../paths", () => ({
  shellZdotdir: () => zdotdir,
}));

import { ShellManager } from "../shell";

function generatedZshrc(): string {
  ShellManager.setupZdotdir();
  return fs.readFileSync(path.join(zdotdir, ".zshrc"), "utf-8");
}

describe("ShellManager.setupZdotdir — shared history", () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does NOT set HISTFILE to any Manor-owned path", () => {
    expect(generatedZshrc()).not.toContain("shell-history");
  });

  it("provides a :=-fallback for HISTFILE after sourcing the user's .zshrc", () => {
    expect(generatedZshrc()).toContain(': "${HISTFILE:=');
  });

  it("does not depend on the daemon-injected MANOR_HISTFILE env var", () => {
    expect(generatedZshrc()).not.toContain("MANOR_HISTFILE");
  });

  it("enables SHARE_HISTORY so panes sync live", () => {
    expect(generatedZshrc()).toContain("setopt SHARE_HISTORY");
  });

  it("floors HISTSIZE/SAVEHIST without clobbering a larger user value", () => {
    const zshrc = generatedZshrc();
    expect(zshrc).toContain("(( HISTSIZE < 100000 )) && HISTSIZE=100000");
    expect(zshrc).toContain("(( SAVEHIST < 100000 )) && SAVEHIST=100000");
  });

  it("places the HISTFILE fallback after sourcing the user's real .zshrc so their value wins", () => {
    const zshrc = generatedZshrc();
    expect(zshrc.indexOf("source")).toBeLessThan(zshrc.indexOf("HISTFILE:="));
  });
});
