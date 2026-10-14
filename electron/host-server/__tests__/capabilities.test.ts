import { describe, expect, it } from "vitest";

import {
  HOST_SERVER_CAPABILITIES,
  hasViewerBridge,
  reportedCapabilities,
} from "../capabilities";

describe("host server capabilities (ADR-228 D3)", () => {
  it("reports its own unless the E2E stands in for an older server", () => {
    expect(reportedCapabilities({})).toEqual([...HOST_SERVER_CAPABILITIES]);
    expect(hasViewerBridge({ capabilities: reportedCapabilities({}) })).toBe(true);
    expect(reportedCapabilities({ MANOR_E2E_HOST_CAPABILITIES: "" })).toEqual([]);
    expect(reportedCapabilities({ MANOR_E2E_HOST_CAPABILITIES: " a , b" })).toEqual(["a", "b"]);
  });
});
