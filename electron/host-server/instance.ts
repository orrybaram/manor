/**
 * One identity per instance (ADR-229 D6).
 *
 * An image snapshotted after the server ran hands every clone the same relay
 * identity, so every clone would join the same relay room and each one's
 * phones would see the others' agents. The server therefore records the
 * `instanceId` it was created under in `instance.json`; a different id on a
 * later start means the data dir was copied, and the sealed stores are reset
 * (projects, agents and layout are kept).
 *
 * The id is deliberately absent when nothing trustworthy names the machine:
 * containers often share an image's `/etc/machine-id` or invent a new one per
 * start, and a false "cloned" would unpair every phone on every restart.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../lib/fs-atomic";
import { remoteNamespaceDir } from "../paths";

export type IdentityReset = "cloned";

export interface InstanceEnv {
  env?: NodeJS.ProcessEnv;
  /** `~/.manor/remote/supervisor.json`, written by `manor-host install` (ADR-229 D8). */
  supervisorFile?: string;
  machineIdFile?: string;
  /** Runs `ioreg -rd1 -c IOPlatformExpertDevice`; its stdout. Throws when it cannot run. */
  ioreg?: () => string;
}

function supervisorKind(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { kind?: unknown };
    return typeof parsed.kind === "string" ? parsed.kind : null;
  } catch {
    // Absent or unreadable: no supervisor, so no machine-derived id.
    return null;
  }
}

/** macOS's own tool; named in a constant, as the other helper binaries are. */
const IOREG = "ioreg";

function defaultIoreg(): string {
  return execFileSync(IOREG, ["-rd1", "-c", "IOPlatformExpertDevice"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * This instance's id, or null when there is none to check against:
 * `MANOR_INSTANCE_ID`; else `/etc/machine-id` under a `systemd` supervisor;
 * else the macOS `IOPlatformUUID` under `launchd`.
 */
export function currentInstanceId(opts: InstanceEnv = {}): string | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.MANOR_INSTANCE_ID?.trim();
  if (fromEnv) return fromEnv;

  const kind = supervisorKind(
    opts.supervisorFile ?? path.join(remoteNamespaceDir(), "supervisor.json"),
  );
  try {
    if (kind === "systemd") {
      const id = fs
        .readFileSync(opts.machineIdFile ?? "/etc/machine-id", "utf8")
        .trim();
      return id || null;
    }
    if (kind === "launchd") {
      const out = (opts.ioreg ?? defaultIoreg)();
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function readStoredId(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      instanceId?: unknown;
    };
    return typeof parsed.instanceId === "string" ? parsed.instanceId : null;
  } catch {
    return null;
  }
}

function writeStoredId(file: string, instanceId: string): void {
  writeFileAtomic(file, JSON.stringify({ instanceId }), { mode: 0o600 });
}

/**
 * Compare the stored id with `currentId` (call once the sealed stores are
 * readable). Both non-null and different: `resetSealedStores` runs, the new id
 * is recorded, and `"cloned"` comes back. A stored null with a current id just
 * records it, and never resets. A reset that throws leaves the stored id as it
 * was, so the next start tries again.
 */
export async function checkInstanceIdentity(opts: {
  instanceFile: string;
  currentId: string | null;
  resetSealedStores: () => Promise<void>;
}): Promise<IdentityReset | null> {
  const { instanceFile, currentId } = opts;
  if (currentId === null) return null;
  const stored = readStoredId(instanceFile);
  if (stored === currentId) return null;
  if (stored === null) {
    writeStoredId(instanceFile, currentId);
    return null;
  }
  await opts.resetSealedStores();
  writeStoredId(instanceFile, currentId);
  console.warn("[host-server] cloned data dir: identity reset");
  return "cloned";
}
