import type { ThemeCatalog, ThemeListEntry } from "../../../../electron/theme";

export type ThemeFilter = "recent" | "all" | "dark" | "light" | "custom";

export const THEME_FILTERS: { id: ThemeFilter; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "all", label: "All" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "custom", label: "Yours" },
];

function inFilter(entry: ThemeListEntry, filter: ThemeFilter): boolean {
  switch (filter) {
    case "dark":
    case "light":
      return entry.scheme === filter;
    case "custom":
      return entry.source === "custom";
    default:
      return true;
  }
}

/**
 * The tiles to show. A search looks across every theme whatever the filter;
 * Recent keeps its newest-first order, the rest keep the catalog's.
 */
export function visibleThemes(
  catalog: ThemeCatalog,
  filter: ThemeFilter,
  query: string,
): ThemeListEntry[] {
  const q = query.trim().toLowerCase();
  if (q) {
    return catalog.themes.filter((t) => t.displayName.toLowerCase().includes(q));
  }
  if (filter === "recent") {
    const byName = new Map(catalog.themes.map((t) => [t.name, t]));
    return catalog.recent.flatMap((n) => byName.get(n) ?? []);
  }
  return catalog.themes.filter((t) => inFilter(t, filter));
}

/** How many tiles each filter would show, for the rail's counts. */
export function filterCounts(catalog: ThemeCatalog): Record<ThemeFilter, number> {
  const counts = { recent: 0, all: 0, dark: 0, light: 0, custom: 0 };
  for (const t of catalog.themes) {
    counts.all++;
    counts[t.scheme]++;
    if (t.source === "custom") counts.custom++;
  }
  counts.recent = visibleThemes(catalog, "recent", "").length;
  return counts;
}

/**
 * Where an arrow key moves the highlight in a grid `columns` wide. Up and
 * down step a row and stop at the edges; left and right run on across rows.
 * Nothing highlighted yet starts on the first tile.
 */
export function gridMove(
  index: number,
  key: string,
  columns: number,
  length: number,
): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  const cols = Math.max(1, columns);
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, length - 1);
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "ArrowDown":
      return index + cols < length ? index + cols : index;
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    default:
      return index;
  }
}

/** A name for a copy of `base` that no theme in `taken` already has. */
export function copyName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  const stem = `${base} copy`;
  if (!names.has(stem.toLowerCase())) return stem;
  for (let i = 2; ; i++) {
    const candidate = `${stem} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}
