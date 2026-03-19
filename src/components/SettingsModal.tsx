import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Check, ChevronDown, ChevronRight, Settings, FolderOpen } from "lucide-react";
import { useThemeStore, type Theme } from "../store/theme-store";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type SettingsPage =
  | { type: "app" }
  | { type: "project"; projectId: string };

// ── Theme Picker (extracted from old modal) ──

interface ThemeEntry {
  name: string;
  displayName: string;
  badge?: string;
}

type ThemeColors = Pick<Theme, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "background" | "foreground">;

function ThemeSection() {
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

  const selectedColors: ThemeColors | null = useMemo(() => {
    if (!currentTheme) return null;
    return {
      red: currentTheme.red, green: currentTheme.green, yellow: currentTheme.yellow,
      blue: currentTheme.blue, magenta: currentTheme.magenta, cyan: currentTheme.cyan,
      background: currentTheme.background, foreground: currentTheme.foreground,
    };
  }, [currentTheme]);

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
  );
}

// ── App Settings Page ──

function AppSettingsPage() {
  return (
    <div className={styles.pageContent}>
      <ThemeSection />

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Font</div>
        <div className={styles.placeholder}>Font family and size settings coming soon.</div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Keybindings</div>
        <div className={styles.placeholder}>Custom keyboard shortcuts coming soon.</div>
      </div>
    </div>
  );
}

// ── Project Settings Page ──

const scriptFields: Array<{
  field: "setupScript" | "teardownScript" | "defaultRunCommand";
  label: string;
  placeholder: string;
}> = [
  { field: "setupScript", label: "Setup Script", placeholder: "Runs when switching to this project" },
  { field: "teardownScript", label: "Teardown Script", placeholder: "Runs when switching away from this project" },
  { field: "defaultRunCommand", label: "Default Run Command", placeholder: "e.g. npm run dev" },
];

function ProjectSettingsPage({ project }: { project: ProjectInfo }) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const nameRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleBlur = useCallback(
    (field: "name" | "setupScript" | "teardownScript" | "defaultRunCommand") => {
      const el = field === "name" ? nameRef.current : fieldRefs.current[field];
      if (!el) return;
      const trimmed = el.value.trim();
      if (field === "name") {
        if (trimmed && trimmed !== project.name) {
          updateProject(project.id, { name: trimmed });
        }
      } else {
        const normalized = trimmed || null;
        if (normalized !== (project[field] ?? null)) {
          updateProject(project.id, { [field]: normalized });
        }
      }
    },
    [project, updateProject]
  );

  return (
    <div className={styles.pageContent}>
      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>General</div>
        <label className={styles.fieldLabel}>Name</label>
        <input
          ref={nameRef}
          className={styles.fieldInput}
          defaultValue={project.name}
          onBlur={() => handleBlur("name")}
        />
        <label className={styles.fieldLabel}>Path</label>
        <div className={styles.fieldStatic}>{project.path}</div>
        <label className={styles.fieldLabel}>Default Branch</label>
        <div className={styles.fieldStatic}>{project.defaultBranch}</div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Scripts</div>
        {scriptFields.map(({ field, label, placeholder }) => (
          <div key={field}>
            <label className={styles.fieldLabel}>{label}</label>
            <input
              ref={(el) => { fieldRefs.current[field] = el; }}
              className={styles.fieldInput}
              defaultValue={project[field] ?? ""}
              onBlur={() => handleBlur(field)}
              placeholder={placeholder}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Settings Modal ──

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const projects = useProjectStore((s) => s.projects);
  const [page, setPage] = useState<SettingsPage>({ type: "app" });
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  useEffect(() => {
    if (open) {
      setPage({ type: "app" });
      setProjectsExpanded(true);
    }
  }, [open]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const currentProject = page.type === "project"
    ? projects.find((p) => p.id === page.projectId)
    : null;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.modal}>
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className={styles.closeButton}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className={styles.layout}>
            {/* Sidebar */}
            <nav className={styles.sidebar}>
              <button
                className={`${styles.navItem} ${page.type === "app" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "app" })}
              >
                <Settings size={14} />
                <span>App Settings</span>
              </button>

              <button
                className={styles.navGroupHeader}
                onClick={() => setProjectsExpanded((v) => !v)}
              >
                {projectsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Projects</span>
              </button>
              {projectsExpanded && projects.map((project) => (
                <button
                  key={project.id}
                  className={`${styles.navItem} ${styles.navItemNested} ${
                    page.type === "project" && page.projectId === project.id ? styles.navItemActive : ""
                  }`}
                  onClick={() => setPage({ type: "project", projectId: project.id })}
                >
                  <FolderOpen size={13} />
                  <span className={styles.navItemLabel}>{project.name}</span>
                </button>
              ))}
              {projectsExpanded && projects.length === 0 && (
                <div className={styles.navEmpty}>No projects</div>
              )}
            </nav>

            {/* Content */}
            <div className={styles.content}>
              {page.type === "app" && <AppSettingsPage />}
              {page.type === "project" && currentProject && (
                <ProjectSettingsPage key={currentProject.id} project={currentProject} />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
