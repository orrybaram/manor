import { describe, it, expect } from "vitest";
import {
  assertGhRepo,
  assertGroupUpdates,
  assertNumber,
  assertPositiveInt,
  assertString,
  assertWorkspaceMeta,
} from "./ipc-validate";

describe("assertString", () => {
  it("passes for a normal string", () => {
    expect(() => assertString("hello", "fieldName")).not.toThrow();
  });

  it("passes for an empty string", () => {
    expect(() => assertString("", "fieldName")).not.toThrow();
  });

  it("throws for undefined", () => {
    expect(() => assertString(undefined, "fieldName")).toThrow(
      "fieldName: expected string, got undefined",
    );
  });

  it("throws for null", () => {
    expect(() => assertString(null, "fieldName")).toThrow(
      "fieldName: expected string, got object",
    );
  });

  it("throws for number", () => {
    expect(() => assertString(123, "fieldName")).toThrow(
      "fieldName: expected string, got number",
    );
  });

  it("throws for boolean", () => {
    expect(() => assertString(true, "fieldName")).toThrow(
      "fieldName: expected string, got boolean",
    );
  });

  it("throws for object", () => {
    expect(() => assertString({}, "fieldName")).toThrow(
      "fieldName: expected string, got object",
    );
  });

  it("throws for array", () => {
    expect(() => assertString([], "fieldName")).toThrow(
      "fieldName: expected string, got object",
    );
  });

  it("includes the field name in the error message", () => {
    expect(() => assertString(42, "myCustomField")).toThrow(
      "myCustomField: expected string, got number",
    );
  });
});

describe("assertNumber", () => {
  it("passes for positive number", () => {
    expect(() => assertNumber(42, "fieldName")).not.toThrow();
  });

  it("passes for zero", () => {
    expect(() => assertNumber(0, "fieldName")).not.toThrow();
  });

  it("passes for negative number", () => {
    expect(() => assertNumber(-100, "fieldName")).not.toThrow();
  });

  it("throws for NaN", () => {
    expect(() => assertNumber(NaN, "fieldName")).toThrow(
      "fieldName: expected finite number, got number",
    );
  });

  it("throws for Infinity", () => {
    expect(() => assertNumber(Infinity, "fieldName")).toThrow(
      "fieldName: expected finite number, got number",
    );
  });

  it("throws for -Infinity", () => {
    expect(() => assertNumber(-Infinity, "fieldName")).toThrow(
      "fieldName: expected finite number, got number",
    );
  });

  it("throws for string", () => {
    expect(() => assertNumber("123", "fieldName")).toThrow(
      "fieldName: expected finite number, got string",
    );
  });

  it("throws for null", () => {
    expect(() => assertNumber(null, "fieldName")).toThrow(
      "fieldName: expected finite number, got object",
    );
  });

  it("throws for undefined", () => {
    expect(() => assertNumber(undefined, "fieldName")).toThrow(
      "fieldName: expected finite number, got undefined",
    );
  });

  it("throws for boolean", () => {
    expect(() => assertNumber(true, "fieldName")).toThrow(
      "fieldName: expected finite number, got boolean",
    );
  });
});

describe("assertPositiveInt", () => {
  it("passes for 1", () => {
    expect(() => assertPositiveInt(1, "fieldName")).not.toThrow();
  });

  it("passes for 100", () => {
    expect(() => assertPositiveInt(100, "fieldName")).not.toThrow();
  });

  it("throws for 0", () => {
    expect(() => assertPositiveInt(0, "fieldName")).toThrow(
      "fieldName: expected positive integer, got 0",
    );
  });

  it("throws for -1", () => {
    expect(() => assertPositiveInt(-1, "fieldName")).toThrow(
      "fieldName: expected positive integer, got -1",
    );
  });

  it("throws for 1.5", () => {
    expect(() => assertPositiveInt(1.5, "fieldName")).toThrow(
      "fieldName: expected positive integer, got 1.5",
    );
  });

  it("throws for string (delegates to assertNumber first)", () => {
    expect(() => assertPositiveInt("123", "fieldName")).toThrow(
      "fieldName: expected finite number, got string",
    );
  });

  it("throws for null (delegates to assertNumber first)", () => {
    expect(() => assertPositiveInt(null, "fieldName")).toThrow(
      "fieldName: expected finite number, got object",
    );
  });

  it("throws for undefined (delegates to assertNumber first)", () => {
    expect(() => assertPositiveInt(undefined, "fieldName")).toThrow(
      "fieldName: expected finite number, got undefined",
    );
  });

  it("throws for boolean (delegates to assertNumber first)", () => {
    expect(() => assertPositiveInt(true, "fieldName")).toThrow(
      "fieldName: expected finite number, got boolean",
    );
  });

  it("includes the field name and actual value in the error message", () => {
    expect(() => assertPositiveInt(0, "myField")).toThrow(
      "myField: expected positive integer, got 0",
    );
  });
});

describe("assertGroupUpdates", () => {
  const TEAM = { teamId: "t1", teamName: "Team", teamKey: "TM" };

  it("passes for a well-formed update, a partial one and nulls", () => {
    expect(() =>
      assertGroupUpdates(
        { name: "App", color: "blue", agentCommand: "codex", linearAssociations: [TEAM] },
        "updates",
      ),
    ).not.toThrow();
    expect(() => assertGroupUpdates({}, "updates")).not.toThrow();
    expect(() =>
      assertGroupUpdates({ color: null, agentCommand: null, linearAssociations: null }, "updates"),
    ).not.toThrow();
  });

  it("throws for a non-object", () => {
    expect(() => assertGroupUpdates(null, "updates")).toThrow("updates: expected object, got null");
    expect(() => assertGroupUpdates("x", "updates")).toThrow("updates: expected object");
    expect(() => assertGroupUpdates([], "updates")).toThrow("updates: expected object");
  });

  it("throws for a field of the wrong type", () => {
    expect(() => assertGroupUpdates({ name: null }, "updates")).toThrow("updates.name");
    expect(() => assertGroupUpdates({ color: 3 }, "updates")).toThrow("updates.color");
    expect(() => assertGroupUpdates({ agentCommand: {} }, "updates")).toThrow(
      "updates.agentCommand",
    );
    expect(() => assertGroupUpdates({ linearAssociations: "TM" }, "updates")).toThrow(
      "updates.linearAssociations",
    );
  });

  it("throws for a malformed Linear association", () => {
    expect(() => assertGroupUpdates({ linearAssociations: [TEAM, null] }, "updates")).toThrow(
      "updates.linearAssociations[1]",
    );
    expect(() =>
      assertGroupUpdates({ linearAssociations: [{ ...TEAM, teamKey: 1 }] }, "updates"),
    ).toThrow("updates.linearAssociations[0]");
  });
});

describe("assertGhRepo", () => {
  it("passes for a path and a host", () => {
    expect(() => assertGhRepo({ path: "/a", hostId: "box" }, "repo")).not.toThrow();
  });

  it("throws for a bare path or a missing host", () => {
    expect(() => assertGhRepo("/a", "repo")).toThrow("repo: expected object, got string");
    expect(() => assertGhRepo({ path: "/a" }, "repo")).toThrow(
      "repo.hostId: expected string, got undefined",
    );
  });
});

describe("assertWorkspaceMeta", () => {
  const entry = {
    path: "/a",
    hostId: "local",
    projectName: null,
    branch: "main",
    isMain: true,
    portlessEnabled: true,
  };

  it("passes for well-formed entries", () => {
    expect(() => assertWorkspaceMeta([entry, { ...entry, projectName: "x" }], "meta")).not.toThrow();
  });

  it("throws for an entry without a host", () => {
    const { hostId: _hostId, ...noHost } = entry;
    expect(() => assertWorkspaceMeta([noHost], "meta")).toThrow(
      "meta[0].hostId: expected string, got undefined",
    );
  });

  it("throws for a mistyped field", () => {
    expect(() => assertWorkspaceMeta([{ ...entry, branch: 1 }], "meta")).toThrow(
      "meta[0].branch: expected string or null, got number",
    );
    expect(() => assertWorkspaceMeta([{ ...entry, isMain: "yes" }], "meta")).toThrow(
      "meta[0].isMain: expected boolean, got string",
    );
  });
});
