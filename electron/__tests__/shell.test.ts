import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the generated dotfiles into a temp dir and pin the shared history
// path so we can assert on the .zshrc contents.
const tmpRoot = path.join(os.tmpdir(), "manor-shell-test");
const zdotdir = path.join(tmpRoot, "zdotdir");
const historyFile = path.join(tmpRoot, "Application Support", "shell-history");

vi.mock("../paths", () => ({
  shellZdotdir: () => zdotdir,
  shellHistoryFile: () => historyFile,
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

  it("sets HISTFILE to the shared history file, quoted to survive the space in the path", () => {
    expect(generatedZshrc()).toContain(`HISTFILE='${historyFile}'`);
  });

  it("does not depend on the daemon-injected MANOR_HISTFILE env var", () => {
    // The bug: HISTFILE was gated on $MANOR_HISTFILE, which a stale detached
    // daemon kept pointing at a per-pane file. The path must be owned by .zshrc.
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

  it("sets HISTFILE after sourcing the user's real .zshrc so it wins", () => {
    const zshrc = generatedZshrc();
    expect(zshrc.indexOf("source")).toBeLessThan(zshrc.indexOf("HISTFILE="));
  });
});
