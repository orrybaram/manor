import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkInstanceIdentity, currentInstanceId } from "../instance";

describe("currentInstanceId", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-instance-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const supervisor = (kind: string) => {
    const file = path.join(dir, "supervisor.json");
    fs.writeFileSync(file, JSON.stringify({ kind }));
    return file;
  };
  const machineIdFile = () => {
    const file = path.join(dir, "machine-id");
    fs.writeFileSync(file, "abc123\n");
    return file;
  };
  const ioreg = () => '    | "IOPlatformUUID" = "UUID-1234"\n';

  it("prefers MANOR_INSTANCE_ID", () => {
    expect(
      currentInstanceId({
        env: { MANOR_INSTANCE_ID: " pod-1 " },
        supervisorFile: supervisor("systemd"),
        machineIdFile: machineIdFile(),
      }),
    ).toBe("pod-1");
  });

  it("uses machine-id only under systemd", () => {
    const base = { env: {}, machineIdFile: machineIdFile(), ioreg };
    expect(currentInstanceId({ ...base, supervisorFile: supervisor("systemd") })).toBe("abc123");
    expect(currentInstanceId({ ...base, supervisorFile: supervisor("container") })).toBeNull();
  });

  it("uses IOPlatformUUID only under launchd", () => {
    const base = { env: {}, machineIdFile: machineIdFile(), ioreg };
    expect(currentInstanceId({ ...base, supervisorFile: supervisor("launchd") })).toBe("UUID-1234");
  });

  it("is null with no supervisor file, or an unreadable one", () => {
    const base = { env: {}, machineIdFile: machineIdFile(), ioreg };
    expect(currentInstanceId({ ...base, supervisorFile: path.join(dir, "absent") })).toBeNull();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(currentInstanceId({ ...base, supervisorFile: bad })).toBeNull();
  });
});

describe("checkInstanceIdentity", () => {
  let dir: string;
  let instanceFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-instance-"));
    instanceFile = path.join(dir, "instance.json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stored = () =>
    (JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { instanceId: string })
      .instanceId;

  it("resets the sealed stores on a different id, keeping projects", async () => {
    fs.writeFileSync(instanceFile, JSON.stringify({ instanceId: "old" }));
    fs.writeFileSync(path.join(dir, "projects.json"), "[]");
    const sealed = path.join(dir, "relay-identity.enc");
    fs.writeFileSync(sealed, "sealed");
    const resetSealedStores = vi.fn(async () => {
      fs.rmSync(sealed);
    });
    const result = await checkInstanceIdentity({
      instanceFile,
      currentId: "new",
      resetSealedStores,
    });
    expect(result).toBe("cloned");
    expect(resetSealedStores).toHaveBeenCalledOnce();
    expect(fs.existsSync(sealed)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "projects.json"), "utf8")).toBe("[]");
    expect(stored()).toBe("new");
  });

  it("keeps the old id when the reset fails, so the next start retries", async () => {
    fs.writeFileSync(instanceFile, JSON.stringify({ instanceId: "old" }));
    await expect(
      checkInstanceIdentity({
        instanceFile,
        currentId: "new",
        resetSealedStores: async () => {
          throw new Error("disk");
        },
      }),
    ).rejects.toThrow("disk");
    expect(stored()).toBe("old");
  });

  it("records the id without a reset when none was stored", async () => {
    const resetSealedStores = vi.fn(async () => {});
    expect(
      await checkInstanceIdentity({ instanceFile, currentId: "new", resetSealedStores }),
    ).toBeNull();
    expect(resetSealedStores).not.toHaveBeenCalled();
    expect(stored()).toBe("new");
  });

  it("does nothing for equal ids, or when there is no current id", async () => {
    fs.writeFileSync(instanceFile, JSON.stringify({ instanceId: "same" }));
    const resetSealedStores = vi.fn(async () => {});
    expect(
      await checkInstanceIdentity({ instanceFile, currentId: "same", resetSealedStores }),
    ).toBeNull();
    expect(
      await checkInstanceIdentity({ instanceFile, currentId: null, resetSealedStores }),
    ).toBeNull();
    expect(resetSealedStores).not.toHaveBeenCalled();
    expect(stored()).toBe("same");
  });
});
