/**
 * Mirrors `LOCAL_HOST_ID` in `electron/backend/types.ts` — the host every
 * project without a `hostId` lives on: this machine.
 */
export const LOCAL_HOST_ID = "local";

/** Mirrors `HealthCheckResult` in `electron/backend/health-check.ts`. */
export interface HealthCheckResult {
  id: "origin" | "claude" | "codex" | "gh";
  label: string;
  ok: boolean;
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}
