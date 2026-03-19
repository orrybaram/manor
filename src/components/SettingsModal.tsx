import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Check } from "lucide-react";
import { useThemeStore, type Theme } from "../store/theme-store";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ThemeEntry {
  name: string;
  displayName: string;
  badge?: string;
}

type ThemeColors = Pick<Theme, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "background" | "foreground">;

export function SettingsModal({ open, onClose }: SettingsModalProps) {
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
    if (!open) return;
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
  }, [open]);

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

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [query]);

  // Scroll selected item into view once after data loads
  useEffect(() => {
    if (!open || didScrollRef.current || Object.keys(allColors).length === 0) return;
    didScrollRef.current = true;
    requestAnimationFrame(() => {
      const el = itemRefs.current.get(selectedThemeName);
      el?.scrollIntoView({ block: "center" });
    });
  }, [open, allColors, selectedThemeName]);

  // Scroll highlighted item into view
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlightIndex >= 0 && filtered[highlightIndex]) {
          handleSelect(filtered[highlightIndex].name);
        }
      }
    },
    [filtered, highlightIndex, handleSelect]
  );

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      searchRef.current?.focus();
    },
    []
  );

  const selectedColors: ThemeColors | null = useMemo(() => {
    if (!currentTheme) return null;
    return {
      red: currentTheme.red, green: currentTheme.green, yellow: currentTheme.yellow,
      blue: currentTheme.blue, magenta: currentTheme.magenta, cyan: currentTheme.cyan,
      background: currentTheme.background, foreground: currentTheme.foreground,
    };
  }, [currentTheme]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.modal}
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className={styles.closeButton}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className={styles.body}>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Theme</div>
              <input
                ref={searchRef}
                className={styles.themeSearch}
                type="text"
                placeholder="Search themes..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className={styles.themeList}>
                {filtered.map((entry, idx) => {
                  const isSelected = entry.name === selectedThemeName;
                  const isHighlighted = idx === highlightIndex;
                  const colors = isSelected ? selectedColors : allColors[entry.name] ?? null;
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
