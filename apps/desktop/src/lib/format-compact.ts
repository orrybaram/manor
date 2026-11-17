const UNITS = ["", "k", "M", "B", "T"] as const;

/**
 * A count written short enough to read at a glance: 950, 12.4k, 22.7M, 1.2B.
 * One decimal under 100 of a unit, none from 100 up, a trailing ".0" dropped.
 * Rounding happens before the unit is picked, so 999,950 is "1M", not "1000k".
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  for (let u = 0; u < UNITS.length; u++) {
    const v = abs / 1000 ** u;
    const rounded = u === 0 ? Math.round(v) : Number(v.toFixed(v >= 100 ? 0 : 1));
    if (rounded < 1000 || u === UNITS.length - 1) return `${sign}${rounded}${UNITS[u]}`;
  }
  return `${sign}${abs}`;
}
