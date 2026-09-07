/**
 * Tests for ensureManorCli() (electron/manor-cli-install.ts).
 *
 * HOME/paths stubbing follows the pattern in agent-hooks.test.ts's
 * `ensureHookScript` suite: point process.env.HOME at a temp dir and
 * re-import the module fresh per test so its module-level path consts
 * pick up the stubbed home.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

describe("ensureManorCli", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  // The "bundled" manor-cli.js that ensureManorCli() copies from —
  // resolved relative to electron/manor-cli-install.ts's own directory,
  // same as the real bundledManorCliJsPath() would resolve in a packaged
  // build's dist-electron/ output.
  const bundledJsPath = path.join(__dirname, "..", "manor-cli.js");
  const FAKE_BUNDLE_CONTENT = "#!/usr/bin/env node\nconsole.log('fake manor cli');\n";

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-cli-install-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(bundledJsPath, { force: true });
  });

  async function freshImport() {
    return import(
      `../manor-cli-install?t=${Date.now()}-${crypto.randomUUID()}`
    );
  }

  it("creates ~/.manor/bin if missing", async () => {
    fs.writeFileSync(bundledJsPath, FAKE_BUNDLE_CONTENT);
    const { ensureManorCli } = await freshImport();
    ensureManorCli();

    const binDir = path.join(tmpDir, ".manor", "bin");
    expect(fs.existsSync(binDir)).toBe(true);
  });

  it("writes manor.js with the bundled content and executable permission", async () => {
    fs.writeFileSync(bundledJsPath, FAKE_BUNDLE_CONTENT);
    const { ensureManorCli } = await freshImport();
    ensureManorCli();

    const jsPath = path.join(tmpDir, ".manor", "bin", "manor.js");
    expect(fs.existsSync(jsPath)).toBe(true);
    expect(fs.readFileSync(jsPath, "utf-8")).toBe(FAKE_BUNDLE_CONTENT);

    const stat = fs.statSync(jsPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("writes the manor shim with executable permission", async () => {
    fs.writeFileSync(bundledJsPath, FAKE_BUNDLE_CONTENT);
    const { ensureManorCli } = await freshImport();
    ensureManorCli();

    const shimPath = path.join(tmpDir, ".manor", "bin", "manor");
    expect(fs.existsSync(shimPath)).toBe(true);
    const stat = fs.statSync(shimPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("the shim exec's manor.js with node, forwarding args", async () => {
    fs.writeFileSync(bundledJsPath, FAKE_BUNDLE_CONTENT);
    const { ensureManorCli } = await freshImport();
    ensureManorCli();

    const shimPath = path.join(tmpDir, ".manor", "bin", "manor");
    const content = fs.readFileSync(shimPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain('exec node "$HOME/.manor/bin/manor.js" "$@"');
  });

  it("removes a pre-existing manor-webview wrapper", async () => {
    fs.writeFileSync(bundledJsPath, FAKE_BUNDLE_CONTENT);
    const binDir = path.join(tmpDir, ".manor", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const legacyPath = path.join(binDir, "manor-webview");
    fs.writeFileSync(legacyPath, "#!/bin/bash\necho legacy\n", { mode: 0o755 });

    const { ensureManorCli } = await freshImport();
    ensureManorCli();

    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("does not throw when the bundled manor-cli.js is missing, and leaves an existing manor.js in place", async () => {
    // No bundled file written this time — simulates dev-from-source / unit tests.
    const binDir = path.join(tmpDir, ".manor", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const jsPath = path.join(binDir, "manor.js");
    fs.writeFileSync(jsPath, "// pre-existing manor.js\n");

    const { ensureManorCli } = await freshImport();
    expect(() => ensureManorCli()).not.toThrow();

    // Existing manor.js untouched.
    expect(fs.readFileSync(jsPath, "utf-8")).toBe("// pre-existing manor.js\n");
    // The shim is still written even when the bundle can't be read.
    const shimPath = path.join(binDir, "manor");
    expect(fs.existsSync(shimPath)).toBe(true);
  });
});
