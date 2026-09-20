/**
 * Moved to `src/lib/layout/panel-tree.ts` (ADR-179 D2). Re-exported here so the
 * renderer's existing import sites keep working; the shim goes away in
 * ADR-179 ticket 3 once nothing imports this path.
 */
export * from "../lib/layout/panel-tree";
