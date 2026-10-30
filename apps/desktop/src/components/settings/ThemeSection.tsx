import { useCallback, useMemo, useRef, useState } from "react";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Plus from "lucide-react/dist/esm/icons/plus";
import { toast } from "../../toast";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useThemeStore, type Theme } from "../../store/theme-store";
import type { ThemeCatalog, ThemeListEntry } from "../../../electron/theme";
import { Input } from "../ui/Input";
import { SectionTitle } from "./SectionTitle";
import { ThemeEditor } from "./ThemePicker/ThemeEditor";
import {
  THEME_FILTERS,
  THEME_SORTS,
  copyName,
  filterCounts,
  gridMove,
  visibleThemes,
  type ThemeFilter,
  type ThemeSort,
} from "./ThemePicker/theme-picker";
import styles from "./ThemePicker/ThemePicker.module.css";

const EMPTY: ThemeCatalog = { themes: [], recent: [] };
const SORT_KEY = "manor.themeSort";

function savedSort(): ThemeSort {
  try {
    return localStorage.getItem(SORT_KEY) === "color" ? "color" : "name";
  } catch {
    return "name";
  }
}

type Editing = {
  initial: Theme;
  initialName: string;
  /** The custom theme's file name when editing one; absent for a new one. */
  editing?: string;
};

/**
 * Settings › Theme: a rail of filters beside a wall of tiles, each painted in
 * its own theme. "+ New" and a custom tile's pencil swap the wall for the
 * editor.
 */
export function ThemeSection() {
  const [catalog, setCatalog] = useState<ThemeCatalog>(EMPTY);
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<ThemeSort>(savedSort);
  // By name, not index: a reload (recents reorder, a theme saved) moves tiles.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const selectedThemeName = useThemeStore((s) => s.selectedThemeName);
  const projectThemeOverride = useThemeStore((s) => s.projectThemeOverride);
  const setTheme = useThemeStore((s) => s.setTheme);
  const wallRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const reload = useCallback(
    () =>
      window.electronAPI.theme.catalog().then(setCatalog, (err: unknown) => {
        // Not an empty wall: say the themes couldn't be read.
        toast.error("Couldn't load themes", { id: "theme-list", error: err });
      }),
    [],
  );

  useMountEffect(() => {
    reload().then(() => {
      requestAnimationFrame(() => {
        const name = useThemeStore.getState().selectedThemeName;
        tileRefs.current.get(name)?.scrollIntoView({ block: "nearest" });
      });
    });
    // A theme saved, deleted or picked anywhere changes the wall and recents.
    return window.electronAPI.theme.onChanged(() => void reload());
  });

  const visible = useMemo(
    () => visibleThemes(catalog, filter, query, sort),
    [catalog, filter, query, sort],
  );
  const counts = useMemo(() => filterCounts(catalog), [catalog]);
  const highlight = visible.findIndex((t) => t.name === highlighted);
  const setHighlight = (index: number) => setHighlighted(visible[index]?.name ?? null);
  // With no Ghostty config, "Match Ghostty" isn't listed and shows the
  // default theme: outline that one.
  const selected =
    selectedThemeName === "__ghostty__" &&
    !catalog.themes.some((t) => t.name === "__ghostty__")
      ? "__default__"
      : selectedThemeName;

  const select = useCallback(
    async (name: string) => {
      await setTheme(name);
      await reload();
    },
    [setTheme, reload],
  );

  const setSort = (next: ThemeSort) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Not saved; the choice holds until Settings closes.
    }
  };

  const startNew = () => {
    const shown = useThemeStore.getState().theme;
    if (!shown) return;
    const onScreen = projectThemeOverride ?? selectedThemeName;
    const base = catalog.themes.find((t) => t.name === onScreen)?.displayName ?? "Theme";
    setEditing({
      initial: shown,
      initialName: copyName(base, catalog.themes.map((t) => t.displayName)),
    });
  };

  const startEdit = async (entry: ThemeListEntry) => {
    try {
      const theme = await window.electronAPI.theme.preview(entry.name);
      setEditing({ initial: theme, initialName: entry.displayName, editing: entry.displayName });
    } catch (err) {
      toast.error("Couldn't open that theme", { id: "theme-edit", error: err });
    }
  };

  const columns = () => {
    const grid = wallRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
  };

  const moveHighlight = (key: string) => {
    const next = gridMove(highlight, key, columns(), visible.length);
    setHighlight(next);
    const name = visible[next]?.name;
    if (!name) return;
    tileRefs.current.get(name)?.scrollIntoView({ block: "nearest" });
    // The keyboard picks as it moves (the pointer only hovers); a recent
    // pick is still only what's on when Settings closes.
    if (name !== selected) void select(name);
  };

  const onWallKeyDown = (e: React.KeyboardEvent) => {
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      moveHighlight(e.key);
    } else if (e.key === "Enter" && visible[highlight]) {
      e.preventDefault();
      void select(visible[highlight].name);
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && visible.length > 0) {
      e.preventDefault();
      setHighlight(0);
      wallRef.current?.focus();
    } else if (e.key === "Enter" && visible.length > 0) {
      e.preventDefault();
      void select(visible[Math.max(highlight, 0)].name);
    }
  };

  if (editing) {
    return (
      <div>
        <SectionTitle id="app-theme">{editing.editing ? "Edit theme" : "New theme"}</SectionTitle>
        <ThemeEditor
          {...editing}
          onSaved={async (selection) => {
            setEditing(null);
            await select(selection);
          }}
          onDeleted={() => {
            setEditing(null);
            // The draft is still painted, and with a project override
            // showing, the delete's broadcast won't repaint it: put back what
            // the surface should show (the override falls back if it was
            // the deleted theme).
            const { applyProjectTheme, projectThemeOverride: override } =
              useThemeStore.getState();
            void applyProjectTheme(override);
            void reload();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle id="app-theme">Theme</SectionTitle>
      <div className={styles.picker}>
        <nav className={styles.rail} aria-label="Theme filters">
          {THEME_FILTERS.map((f) => {
            const active = filter === f.id && !query;
            return (
              <button
                key={f.id}
                type="button"
                className={`${styles.railButton} ${active ? styles.railButtonActive : ""}`}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  setFilter(f.id);
                  setQuery("");
                  setHighlight(-1);
                }}
                data-testid={`theme-filter-${f.id}`}
              >
                {f.label}
                <span className={styles.railCount}>{counts[f.id]}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={styles.railNew}
            onClick={startNew}
            data-testid="theme-new"
          >
            <Plus size={13} /> New
          </button>
        </nav>
        <div className={styles.wallColumn}>
          <div className={styles.searchRow}>
            <Input
              type="text"
              placeholder="Search all themes…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(-1);
              }}
              onKeyDown={onSearchKeyDown}
              autoFocus
              aria-label="Search themes"
            />
            <div className={styles.sort} role="radiogroup" aria-label="Sort themes">
              {THEME_SORTS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={sort === o.id}
                  className={`${styles.sortButton} ${sort === o.id ? styles.sortButtonActive : ""}`}
                  onClick={() => setSort(o.id)}
                  data-testid={`theme-sort-${o.id}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={wallRef}
            className={styles.wall}
            role="listbox"
            aria-label="Themes"
            tabIndex={0}
            onKeyDown={onWallKeyDown}
            onFocus={() => {
              if (highlight < 0 && visible.length > 0) setHighlight(0);
            }}
            data-testid="theme-wall"
          >
            {visible.map((entry, i) => (
              <ThemeTile
                key={entry.name}
                entry={entry}
                selected={entry.name === selected}
                highlighted={i === highlight}
                tileRef={(el) => {
                  if (el) tileRefs.current.set(entry.name, el);
                  else tileRefs.current.delete(entry.name);
                }}
                onSelect={() => void select(entry.name)}
                onEdit={entry.source === "custom" ? () => void startEdit(entry) : undefined}
                onHover={() => setHighlight(i)}
              />
            ))}
            {visible.length === 0 && (
              <div className={styles.empty}>
                {query
                  ? "No matching themes"
                  : filter === "custom"
                    ? "No themes of your own yet. New makes one from the theme you're on."
                    : filter === "recent"
                      ? "Themes you pick show up here."
                      : "No themes"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type ThemeTileProps = {
  entry: ThemeListEntry;
  selected: boolean;
  highlighted: boolean;
  tileRef: (el: HTMLDivElement | null) => void;
  onSelect: () => void;
  onEdit?: () => void;
  onHover: () => void;
};

/** A theme painted in its own colours: name, badge, and a stripe of its palette. */
function ThemeTile(props: ThemeTileProps) {
  const { entry, selected, highlighted, tileRef, onSelect, onEdit, onHover } = props;
  const { colors } = entry;
  const stripe = [
    colors.red,
    colors.green,
    colors.yellow,
    colors.blue,
    colors.magenta,
    colors.cyan,
    colors.accent ?? colors.blue,
  ];
  const badge = entry.badge ?? (entry.source === "custom" ? "Yours" : undefined);
  return (
    <div
      ref={tileRef}
      className={[
        styles.tile,
        selected ? styles.tileSelected : "",
        highlighted ? styles.tileHighlighted : "",
      ].join(" ")}
      role="option"
      aria-selected={selected}
      title={entry.displayName}
      onClick={onSelect}
      onMouseEnter={onHover}
      data-testid="theme-tile"
      data-theme-name={entry.name}
    >
      <div
        className={styles.tileFace}
        style={{ background: colors.background, color: colors.foreground }}
      >
        <span className={styles.tileName}>{entry.displayName}</span>
        {badge && <span className={styles.tileBadge}>{badge}</span>}
      </div>
      <div className={styles.tileStripe} aria-hidden>
        {stripe.map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
      {onEdit && (
        <button
          type="button"
          className={styles.tileEdit}
          aria-label={`Edit ${entry.displayName}`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          data-testid="theme-edit"
        >
          <Pencil size={11} />
        </button>
      )}
    </div>
  );
}
