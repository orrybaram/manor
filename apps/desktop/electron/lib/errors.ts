/** Normalize a caught `unknown` value to a message: `Error.message`, else `String(err)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
