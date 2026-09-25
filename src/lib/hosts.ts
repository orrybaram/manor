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
  /**
   * `"unknown"` is a neutral, unverified state (e.g. Claude login, which has
   * no reliable non-interactive probe) — render it distinctly from `"fail"`,
   * not as a red failure.
   */
  status?: "ok" | "fail" | "unknown";
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}
