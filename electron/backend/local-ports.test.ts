import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalPortsBackend } from "./local-ports";

// Access private methods for unit testing the parsers
function getParseLsofPorts(backend: LocalPortsBackend) {
  return (backend as any).parseLsofPorts.bind(backend) as (
    output: string,
  ) => ReturnType<LocalPortsBackend["scan"]> extends Promise<infer T> ? T : never;
}

function getCwdsByPid(backend: LocalPortsBackend) {
  return (backend as any).cwdsByPid.bind(backend) as (
    pids: number[],
  ) => Promise<Map<number, string>>;
}

describe("LocalPortsBackend", () => {
  let backend: LocalPortsBackend;

  beforeEach(() => {
    backend = new LocalPortsBackend();
  });

  describe("parseLsofPorts", () => {
    const parse = () => getParseLsofPorts(backend);

    it("parses standard lsof -F pcn output", () => {
      const output = [
        "p1234",
        "cnode",
        "n*:3000",
        "",
      ].join("\n");

      const result = parse()(output);
      expect(result).toEqual([
        {
          port: 3000,
          processName: "node",
          pid: 1234,
          workspacePath: null,
          hostname: null,
        },
      ]);
    });

    it("parses multiple processes", () => {
      const output = [
        "p100",
        "cnode",
        "n127.0.0.1:3000",
        "p200",
        "cpython3",
        "n*:8000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(2);
      expect(result[0].port).toBe(3000);
      expect(result[0].processName).toBe("node");
      expect(result[0].pid).toBe(100);
      expect(result[1].port).toBe(8000);
      expect(result[1].processName).toBe("python3");
      expect(result[1].pid).toBe(200);
    });

    it("deduplicates ports", () => {
      const output = [
        "p100",
        "cnode",
        "n*:3000",
        "n127.0.0.1:3000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(1);
    });

    it("handles IPv6 addresses", () => {
      const output = [
        "p100",
        "cnode",
        "n[::1]:4000",
      ].join("\n");

      const result = parse()(output);
      expect(result).toHaveLength(1);
      expect(result[0].port).toBe(4000);
    });

    it("returns empty array for empty output", () => {
      expect(parse()("")).toEqual([]);
    });

    it("skips lines without port info", () => {
      const output = [
        "p100",
        "cnode",
        "n*:",
      ].join("\n");

      const result = parse()(output);
      expect(result).toEqual([]);
    });
  });

  describe("cwdsByPid", () => {
    it("returns empty map for empty pid list", async () => {
      const cwds = getCwdsByPid(backend);
      const result = await cwds([]);
      expect(result.size).toBe(0);
    });
  });
});
