import { describe, expect, it } from "vitest";

import { defaultShell } from "../session";

describe("defaultShell", () => {
  it("is $SHELL when set", () => {
    expect(defaultShell({ SHELL: "/usr/bin/fish" }, () => "/bin/bash")).toBe("/usr/bin/fish");
  });

  it("is the login shell from the password database without $SHELL (docker exec, kubectl exec)", () => {
    expect(defaultShell({}, () => "/bin/bash")).toBe("/bin/bash");
  });

  it("is zsh when neither says", () => {
    expect(defaultShell({}, () => null)).toBe("/bin/zsh");
  });
});
