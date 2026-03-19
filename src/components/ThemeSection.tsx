import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Check } from "lucide-react";
import { useThemeStore, type Theme } from "../store/theme-store";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import styles from "./SettingsModal.module.css";

interface ThemeEntry {
  name: string;
  displayName: string;
  badge?: string;
}

type ThemeColors = Pick<Theme, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "background" | "foreground">;

export function ThemeSection() {
  const [hasGhostty, setHasGhostty] = useState(false);
  const [query, setQuery] = useState("");
  const [allColors, setAllColors] = useState<Record<string, ThemeColors>>({});
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const selectedThemeName = useThemeStore((s) => s.selectedThemeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const currentTheme = useThemeStore((s) => s.theme);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const didScrollRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery("");
    setHighlightIndex(-1);
    didScrollRef.current = false;
    Promise.all([
      window.electronAPI.hasGhosttyConfig(),
      window.electronAPI.getAllThemeColors(),
    ]).then(([ghostty, colors]) => {
      setHasGhostty(ghostty);
      setAllColors(colors);
    });
  }, []);

  const entries: ThemeEntry[] = useMemo(() => {
    const result: ThemeEntry[] = [];
    if (hasGhostty) {
      result.push({ name: "__ghostty__", displayName: "Match Ghostty", badge: "Ghostty" });
    }
    result.push({ name: "__default__", displayName: "Catppuccin Mocha", badge: "Default" });
    for (const n of Object.keys(allColors).sort()) {
      result.push({ name: n, displayName: n });
    }
    return result;
  }, [allColors, hasGhostty]);

  const filtered = useMemo(() => {
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => e.displayName.toLowerCase().includes(q));
  }, [query, entries]);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [query]);

  useEffect(() => {
    if (didScrollRef.current || Object.keys(allColors).length === 0) return;
    didScrollRef.current = true;
    requestAnimationFrame(() => {
      const el = itemRefs.current.get(selectedThemeName);
      el?.scrollIntoView({ block: "center" });
    });
  }, [allColors, selectedThemeName]);

  useEffect(() => {
    if (highlightIndex < 0 || highlightIndex >= filtered.length) return;
    const name = filtered[highlightIndex].name;
    requestAnimationFrame(() => {
      const el = itemRefs.current.get(name);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [highlightIndex, filtered]);

  const handleSelect = useCallback(async (name: string) => {
    await setTheme(name);
  }, [setTheme]);

  const handleSelectByIndex = useCallback(
    (index: number) => {
      if (filtered[index]) handleSelect(filtered[index].name);
    },
    [filtered, handleSelect]
  );

  const handleKeyDown = useListKeyboardNav(
    filtered.length,
    highlightIndex,
    setHighlightIndex,
    handleSelectByIndex,
  );

  return (
    <div onKeyDown={handleKeyDown}>
      <div className={styles.sectionTitle}>Theme</div>
      <input
        ref={searchRef}
        className={styles.themeSearch}
        type="text"
        placeholder="Search themes..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className={styles.themeList}>
        {filtered.map((entry, idx) => {
          const isSelected = entry.name === selectedThemeName;
          const isHighlighted = idx === highlightIndex;
          const colors = isSelected ? currentTheme : allColors[entry.name] ?? null;
          const dotColors = colors
            ? [colors.red, colors.green, colors.yellow, colors.blue, colors.magenta, colors.cyan]
            : null;
          return (
            <div
              key={entry.name}
              ref={(el) => {
                if (el) itemRefs.current.set(entry.name, el);
                else itemRefs.current.delete(entry.name);
              }}
              className={`${styles.themeItem} ${isSelected ? styles.themeItemSelected : ""} ${isHighlighted ? styles.themeItemHighlighted : ""}`}
              onClick={() => handleSelect(entry.name)}
              onMouseEnter={() => setHighlightIndex(idx)}
            >
              <span className={styles.checkmark}>
                {isSelected ? <Check size={14} /> : ""}
              </span>
              <span className={styles.themeItemLabel}>
                {entry.displayName}
              </span>
              {entry.badge && (
                <span className={styles.themeItemBadge}>{entry.badge}</span>
              )}
              {dotColors && (
                <div className={styles.themePreview}>
                  {dotColors.map((c, i) => (
                    <div key={i} className={styles.colorDot} style={{ background: c }} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            No matching themes
          </div>
        )}
      </div>
    </div>
  );
}
