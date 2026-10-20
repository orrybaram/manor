/**
 * The key sealing the pairing keys stays the server's: taken
 * out of `process.env` at start, so the daemon the server starts (every
 * shell and agent on the box) and its busy hooks never inherit it, yet
 * handed to the secret box, which seals with it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { serverKeyStatus } from "../secrets-command";
import { takeSecretEnv } from "../supervisor";
import { useHostServerHarness } from "./harness";

describe("the host server's private key environment", () => {
  const h = useHostServerHarness();
  const saved = {
    file: process.env.MANOR_SECRET_KEY_FILE,
    inline: process.env.MANOR_SECRET_KEY,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["MANOR_SECRET_KEY_FILE", saved.file],
      ["MANOR_SECRET_KEY", saved.inline],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps the key out of process.env while the secret box seals with it", async () => {
    const keyFile = path.join(h.tmp, "secret.key");
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    // As a systemd unit's EnvironmentFile would have set it.
    process.env.MANOR_SECRET_KEY_FILE = keyFile;
    delete process.env.MANOR_SECRET_KEY;

    const envFile = path.join(h.tmp, "supervisor.env");
    const { secretEnv } = takeSecretEnv(process.env, envFile);
    expect(process.env.MANOR_SECRET_KEY_FILE).toBeUndefined();
    expect(process.env.MANOR_SECRET_KEY).toBeUndefined();

    const status = serverKeyStatus(secretEnv, {
      envFile,
      defaultKeyFile: path.join(h.tmp, "config", "manor", "secret.key"),
      home: h.tmp,
    });
    const running = await h.serve({ secrets: { env: secretEnv, status } });
    const reported = running.server.status();
    expect(reported.secretBackend).toBe("key-file");
    expect(reported.secretKeyFile).toBe("~/secret.key");
    expect(reported.secretKeyPlace).toBe("home");
    expect(reported.encryptKeyFile).toBe("~/config/manor/secret.key");
    // Still out of what any child would inherit.
    expect(process.env.MANOR_SECRET_KEY_FILE).toBeUndefined();
  });
});
