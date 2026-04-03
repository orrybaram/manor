import { describe, it, expect } from "vitest";
import { assertString, assertNumber, assertPositiveInt } from "./ipc-validate";

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
