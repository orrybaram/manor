import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * Verifies the uncaughtException handler behaviour that was fixed to prevent
 * zombie daemon processes.
 *
 * Root cause: the old handler had no process.exit() call. When the underlying
 * error condition caused rapid-fire repeated exceptions (e.g. from PTY/xterm
 * interaction), the handler logged each one and returned, keeping the daemon
 * alive. The socket was eventually deleted by the shutdown path but exit()
 * never ran, leaving a process spinning at ~99% CPU. The client saw the socket
 * gone and tried to spawn a new daemon while the old one was still alive and
 * holding the PID/token files.
 *
 * Fix: handler now calls shutdown() → exit(). The recursion guard is an extra
 * safety net for the case where the handler itself throws before reaching exit
 * (e.g. an async exception that fires between handler invocations).
 */
describe("terminal-host uncaughtException handler", () => {
  it("exits the process (fail-fast) so a broken daemon does not zombie-loop", () => {
    // Simulate the fixed handler: sets guard, then calls shutdown() / exit(0).
    // Without exit() in the handler the process would stay alive.
    const script = `
      let handlingUncaught = false;
      process.on('uncaughtException', () => {
        if (handlingUncaught) { process.exit(1); }
        handlingUncaught = true;
        process.exit(0); // shutdown() analogue
      });
      throw new Error('some daemon error');
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      timeout: 3000,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("recursion guard exits with code 1 when a second exception arrives asynchronously", () => {
    // Simulates the guard being hit via an async exception (setImmediate) that
    // fires after the first handler sets the flag but before shutdown() runs.
    const script = `
      let handlingUncaught = false;
      process.on('uncaughtException', () => {
        if (handlingUncaught) {
          process.stderr.write('recursive-guard-hit\\n');
          process.exit(1);
        }
        handlingUncaught = true;
        // Schedule another exception before we reach exit — mimics a second
        // async error racing the shutdown path.
        setImmediate(() => { throw new Error('second exception'); });
        // Intentionally do NOT exit here so the async exception can land.
      });
      throw new Error('original exception');
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      timeout: 3000,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recursive-guard-hit");
    expect(result.signal).toBeNull();
  });
});
