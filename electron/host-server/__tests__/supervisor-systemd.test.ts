/**
 * The systemd supervisor against this machine's real user manager (ADR-229
 * D4). Linux CI has no user systemd, so it runs only with
 * `MANOR_TEST_SYSTEMD=1`. It writes and enables the two units in the real
 * `~/.config/systemd/user` without starting them, then uninstalls; it skips
 * itself on a machine that already has them. `install` also runs `loginctl
 * enable-linger`, which polkit may grant: lingering then stays on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SYSTEMD_UNITS, SystemdSupervisor, detectSystemd } from "../supervisor/systemd";
import { runCommand } from "../supervisor/types";

// The isolated test home is not where the user manager looks.
const unitDir = path.join(os.userInfo().homedir, ".config", "systemd", "user");
const alreadyThere = Object.values(SYSTEMD_UNITS).some((u) => fs.existsSync(path.join(unitDir, u)));

describe.skipIf(process.env.MANOR_TEST_SYSTEMD !== "1" || alreadyThere)(
  "SystemdSupervisor on a real user manager",
  () => {
    it("installs, enables, reports and uninstalls the units", async () => {
      expect(await detectSystemd(runCommand)).toBe(true);
      const supervisor = new SystemdSupervisor({
        run: runCommand,
        unitDir,
        user: os.userInfo().username,
        // Never start them: the shim may not be installed here.
        isRunning: () => true,
      });
      try {
        await supervisor.install();
        for (const unit of Object.values(SYSTEMD_UNITS)) {
          const enabled = await runCommand("systemctl", ["--user", "is-enabled", unit]);
          expect(enabled.stdout.trim()).toBe("enabled");
        }
        const status = await supervisor.status();
        expect(status.kind).toBe("systemd");
        expect(typeof status.linger).toBe("boolean");
      } finally {
        await supervisor.uninstall();
      }
      for (const unit of Object.values(SYSTEMD_UNITS)) {
        expect(fs.existsSync(path.join(unitDir, unit))).toBe(false);
      }
    });
  },
);
