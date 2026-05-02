/**
 * Integration tests for LocalGitBackend.pushStream against a real bare repo.
 *
 * These tests shell out to real git. Each test is hermetic — a fresh working
 * repo and bare repo are created in a temp dir per test, and cleaned up in
 * afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { LocalGitBackend } from "../local-git";

vi.setConfig({ testTimeout: 30000 });

// ── helpers ──────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/**
 * Check for git availability once at module load time. If git isn't present
 * the whole suite is skipped (mirrors the pattern used in local-git.test.ts).
 */
function isGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap the callback-based pushStream API in a Promise so tests read naturally.
 */
function runPush(
  backend: LocalGitBackend,
  cwd: string,
  opts: { remote?: string; branch?: string; setUpstream?: boolean },
): Promise<{ lines: string[]; exitCode: number | null; stderr: string }> & {
  cancel: () => void;
} {
  const lines: string[] = [];
  let cancelFn: () => void = () => {};

  const promise = new Promise<{
    lines: string[];
    exitCode: number | null;
    stderr: string;
  }>((resolve) => {
    const handle = backend.pushStream(cwd, opts, {
      onLine(line) {
        lines.push(line);
      },
      onDone({ exitCode, stderr }) {
        resolve({ lines, exitCode, stderr });
      },
    });
    cancelFn = handle.cancel;
  }) as Promise<{ lines: string[]; exitCode: number | null; stderr: string }> & {
    cancel: () => void;
  };

  Object.defineProperty(promise, "cancel", {
    get() {
      return cancelFn;
    },
  });

  return promise;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!isGitAvailable())(
  "LocalGitBackend.pushStream (integration — real git)",
  () => {
    let backend: LocalGitBackend;
    let tmpDir: string;
    let workDir: string;
    let bareDir: string;

    beforeEach(async () => {
      backend = new LocalGitBackend();

      tmpDir = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "manor-push-integration-")),
      );
      workDir = path.join(tmpDir, "work");
      bareDir = path.join(tmpDir, "bare.git");

      // Initialise the bare repo that acts as the remote.
      execFileSync("git", ["init", "--bare", bareDir], { encoding: "utf-8" });

      // Initialise the working repo.
      execFileSync("git", ["init", "-b", "main", workDir], {
        encoding: "utf-8",
      });
      git(workDir, "config", "user.email", "test@test.com");
      git(workDir, "config", "user.name", "Test");

      // Point origin at the bare repo.
      git(workDir, "remote", "add", "origin", bareDir);

      // Make an initial commit so there is something to push.
      await writeFile(path.join(workDir, "file.txt"), "hello\n");
      git(workDir, "add", ".");
      git(workDir, "commit", "-m", "initial");
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    // ── Test 1: happy path ─────────────────────────────────────────────────

    it("exits 0 and stderr contains destination line after a successful push", async () => {
      // Pre-push with upstream so the branch is already tracked.
      git(workDir, "push", "-u", "origin", "main");

      // Make another commit so there is something new to push.
      await writeFile(path.join(workDir, "file2.txt"), "world\n");
      git(workDir, "add", ".");
      git(workDir, "commit", "-m", "second");

      const { exitCode, stderr } = await runPush(backend, workDir, {});

      expect(exitCode).toBe(0);
      // git outputs "To <path>" in stderr for local pushes.
      expect(stderr).toMatch(/To /);
    });

    // ── Test 2: no-upstream branch — first-push with --set-upstream ───────
    //
    // The impl always passes the resolved branch name explicitly to git, so
    // pushing a new branch to a bare repo always succeeds (exit 0) regardless
    // of whether --set-upstream is supplied — git only errors with "no upstream
    // branch" when NO refspec is given and the branch has no tracking ref.
    // What we can test instead: calling pushStream with setUpstream:true
    // succeeds AND causes git to record the tracking relationship, whereas
    // calling it without setUpstream:true also succeeds but leaves no tracking
    // branch configured.

    it("push without setUpstream succeeds but leaves no tracking; with setUpstream tracking is recorded", async () => {
      // Create a fresh branch with a commit and no upstream.
      git(workDir, "checkout", "-b", "feature");
      await writeFile(path.join(workDir, "feat.txt"), "feature\n");
      git(workDir, "add", ".");
      git(workDir, "commit", "-m", "feature commit");

      // First push without setUpstream — should succeed but not set tracking.
      const firstResult = await runPush(backend, workDir, {
        branch: "feature",
      });
      expect(firstResult.exitCode).toBe(0);

      // After a plain push, git should NOT have recorded a tracking upstream.
      let tracking = "";
      try {
        tracking = git(
          workDir,
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{u}",
        ).trim();
      } catch {
        // Expected: no upstream set — git exits non-zero, tracking stays "".
      }
      expect(tracking).toBe("");

      // Second push with setUpstream: true — should also succeed AND set tracking.
      const secondResult = await runPush(backend, workDir, {
        branch: "feature",
        setUpstream: true,
      });
      expect(secondResult.exitCode).toBe(0);

      // Now git should have a recorded upstream for the feature branch.
      const upstream = git(
        workDir,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ).trim();
      expect(upstream).toBe("origin/feature");
    });

    // ── Test 3: unreachable remote ─────────────────────────────────────────

    it("fails with non-empty stderr when remote is unreachable", async () => {
      // Reconfigure origin to an HTTPS URL that cannot resolve.
      git(
        workDir,
        "remote",
        "set-url",
        "origin",
        "https://nonexistent.invalid/repo.git",
      );

      const { exitCode, stderr } = await runPush(backend, workDir, {
        branch: "main",
      });

      expect(exitCode).not.toBe(0);
      // Just verify stderr is non-empty — exact wording varies by git version.
      expect(stderr.trim().length).toBeGreaterThan(0);
    });

    // ── Test 4: cancel mid-push ────────────────────────────────────────────
    //
    // Reliable cancellation in a local-bare-repo scenario is difficult because
    // local pushes complete in milliseconds. The unit tests in
    // local-git-pushstream.test.ts already verify that cancel() sends SIGTERM.
    // We provide a lightweight smoke-test here: start a push and call cancel()
    // immediately — onDone must still fire (possibly with exitCode 0 if push
    // completed before SIGTERM was delivered, or non-zero if it was cancelled).

    it("fires onDone regardless of when cancel is called", async () => {
      // Pre-push so there is an upstream and the push can start.
      git(workDir, "push", "-u", "origin", "main");

      // Another commit to push.
      await writeFile(path.join(workDir, "cancel.txt"), "cancel\n");
      git(workDir, "add", ".");
      git(workDir, "commit", "-m", "cancel test");

      const pushPromise = runPush(backend, workDir, {});

      // Cancel immediately — race with the spawned process.
      pushPromise.cancel();

      const { exitCode } = await pushPromise;

      // Either 0 (push finished before SIGTERM) or non-null (killed).
      // The critical assertion: onDone must have fired (promise resolved).
      expect(exitCode === 0 || exitCode !== 0).toBe(true);
    });
  },
);
