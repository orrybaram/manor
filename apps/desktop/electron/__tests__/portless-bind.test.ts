import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../paths", () => ({
  portlessProxyPortFile: () =>
    path.join(os.tmpdir(), `manor-portless-bind-${process.pid}`, "port"),
}));

import { PortlessManager } from "../portless";

describe("PortlessManager", () => {
  const manager = new PortlessManager();
  afterEach(() => manager.stop());

  it("listens on loopback only, never every interface", async () => {
    await manager.start(41355);
    const address = (manager.server as unknown as { address(): AddressInfo }).address();
    expect(address.address).toBe("127.0.0.1");
  });
});
