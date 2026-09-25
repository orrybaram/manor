import { describe, it, expect, vi } from "vitest";
import { LocalPtyBackend } from "./local-pty";
import type { TerminalHostClient } from "../terminal-host/client";

describe("LocalPtyBackend", () => {
  describe("createOrAttach", () => {
    it("forwards env to the underlying client on fresh spawn", async () => {
      const createOrAttach = vi.fn().mockResolvedValue({
        session: { sessionId: "p1", cwd: "/tmp", cols: 80, rows: 24, alive: true },
        snapshot: null,
      });
      const client = { createOrAttach } as unknown as TerminalHostClient;
      const backend = new LocalPtyBackend(client);

      const env = { MANOR_AGENT_KIND: "codex" };
      await backend.createOrAttach("p1", "/tmp", 80, 24, undefined, env);

      expect(createOrAttach).toHaveBeenCalledWith(
        "p1",
        "/tmp",
        80,
        24,
        undefined,
        env,
      );
    });

    it("works without env (reattach case)", async () => {
      const createOrAttach = vi.fn().mockResolvedValue({
        session: { sessionId: "p1", cwd: "/tmp", cols: 80, rows: 24, alive: true },
        snapshot: { screenAnsi: "", seq: 0 },
      });
      const client = { createOrAttach } as unknown as TerminalHostClient;
      const backend = new LocalPtyBackend(client);

      await backend.createOrAttach("p1", "/tmp", 80, 24);

      expect(createOrAttach).toHaveBeenCalledWith(
        "p1",
        "/tmp",
        80,
        24,
        undefined,
        undefined,
      );
    });
  });
});
