/**
 * Body validators for the `/panes` and `/tabs` routes, moved from
 * `src/lib/app-commands.ts` with the routes they guard. A bad argument is a
 * throw, which the route answers as a 400 before the store is touched.
 */

export const SPLIT_CONTENT_TYPES = ["terminal", "browser", "diff", "agent"] as const;

export const TAB_CONTENT_TYPES = ["terminal", "browser"] as const;

const SPLIT_DIRECTIONS = ["horizontal", "vertical"] as const;
const SPLIT_POSITIONS = ["first", "second"] as const;

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Argument ${key} must be a string`);
  }
  return value;
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Argument ${key} must be a boolean`);
  }
  return value;
}

export function requireStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`Argument ${key} must be an array of strings`);
  }
  return value as string[];
}

export function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `Argument ${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

export function parseOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return parseEnum(value, allowed, key);
}

/** The split direction and position every split-shaped route takes. */
export function parseSplitPlacement(body: Record<string, unknown>): {
  direction: (typeof SPLIT_DIRECTIONS)[number];
  position: (typeof SPLIT_POSITIONS)[number];
} {
  return {
    direction: parseEnum(body.direction, SPLIT_DIRECTIONS, "direction"),
    position:
      parseOptionalEnum(body.position, SPLIT_POSITIONS, "position") ?? "second",
  };
}
