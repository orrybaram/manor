import { describe, it, expect } from "vitest";
import { isLocalhostHttpUrl } from "../hosts";

describe("isLocalhostHttpUrl", () => {
  it("matches http(s) loopback and portless URLs only", () => {
    expect(isLocalhostHttpUrl("http://localhost:3000")).toBe(true);
    expect(isLocalhostHttpUrl("https://127.0.0.1:8443/x")).toBe(true);
    expect(isLocalhostHttpUrl("http://[::1]:5173/")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost?x=1")).toBe(true);
    expect(isLocalhostHttpUrl("http://localhost.evil.com:3000")).toBe(false);
    expect(isLocalhostHttpUrl("http://feat.acme.localhost:1355/")).toBe(true);
    expect(isLocalhostHttpUrl("file:///tmp")).toBe(false);
  });
});
