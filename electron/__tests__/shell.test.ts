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

function generatedZlogout(): string {
  ShellManager.setupZdotdir();
  return fs.readFileSync(path.join(zdotdir, ".zlogout"), "utf-8");
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

  it("redirects HISTFILE when it is empty or lives inside Manor's ZDOTDIR", () => {
    const zshrc = generatedZshrc();
    expect(zshrc).toContain(
      'if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"/* ]]; then',
    );
    expect(zshrc).toContain('HISTFILE="${REAL_ZDOTDIR:-$HOME}/.zsh_history"');
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

  it("places the HISTFILE redirect after sourcing the user's real .zshrc so their value wins", () => {
    const zshrc = generatedZshrc();
    expect(zshrc.indexOf("source")).toBeLessThan(zshrc.indexOf("HISTFILE="));
  });

  it("generates a .zlogout that sources the user's real .zlogout", () => {
    expect(generatedZlogout()).toContain(
      'source "${REAL_ZDOTDIR:-$HOME}/.zlogout"',
    );
  });
});

describe("ShellManager.realZdotdir — nested-launch sanitization", () => {
  const savedZdotdir = process.env.ZDOTDIR;
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = savedZdotdir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("returns HOME when ZDOTDIR is unset", () => {
    delete process.env.ZDOTDIR;
    process.env.HOME = "/home/user";
    expect(ShellManager.realZdotdir()).toBe("/home/user");
  });

  it("falls back to HOME when ZDOTDIR equals Manor's own zdotdir (nested-launch poison)", () => {
    process.env.ZDOTDIR = ShellManager.zdotdirPath();
    process.env.HOME = "/home/user";
    expect(ShellManager.realZdotdir()).toBe("/home/user");
  });

  it("returns the inherited ZDOTDIR when it is a real, different dir", () => {
    process.env.ZDOTDIR = "/home/user/.config/zsh";
    process.env.HOME = "/home/user";
    expect(ShellManager.realZdotdir()).toBe("/home/user/.config/zsh");
  });
});
