export function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name}: expected string, got ${typeof value}`);
  }
}

export function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}: expected finite number, got ${typeof value}`);
  }
}

export function assertPositiveInt(value: unknown, name: string): asserts value is number {
  assertNumber(value, name);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}: expected positive integer, got ${value}`);
  }
}
