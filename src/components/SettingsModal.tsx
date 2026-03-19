import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { X, Check, ChevronDown, ChevronRight, Settings, FolderOpen, Link, Unlink } from "lucide-react";
import { useThemeStore, type Theme } from "../store/theme-store";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type SettingsPage =
  | { type: "app" }
  | { type: "integrations" }
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

// ── Integrations Page ──

function IntegrationsPage() {
  return (
    <div className={styles.pageContent}>
      <LinearIntegrationSection />
    </div>
  );
}

function LinearIntegrationSection() {
  const [connected, setConnected] = useState(false);
  const [viewer, setViewer] = useState<{ name: string; email: string } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    window.electronAPI.linearIsConnected().then(async (isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        try {
          const v = await window.electronAPI.linearGetViewer();
          setViewer(v);
        } catch {
          // token may be stale
        }
      }
    });
  }, []);

  const handleConnect = async () => {
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const v = await window.electronAPI.linearConnect(apiKey.trim());
      setViewer(v);
      setConnected(true);
      setApiKey("");
      // Auto-match projects
      const matches = await window.electronAPI.linearAutoMatch();
      const count = Object.keys(matches).length;
      setMatchCount(count);
      loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await window.electronAPI.linearDisconnect();
    setConnected(false);
    setViewer(null);
    setMatchCount(null);
  };

  return (
    <div className={styles.settingsGroup}>
      <div className={styles.sectionTitle}>Linear</div>
      {connected ? (
        <div className={styles.linearConnected}>
          <div className={styles.linearStatus}>
            <Link size={14} />
            <span>Connected as {viewer?.name ?? "..."}</span>
          </div>
          {matchCount !== null && matchCount > 0 && (
            <div className={styles.linearMatchInfo}>
              Auto-matched {matchCount} project{matchCount !== 1 ? "s" : ""} to Linear teams
            </div>
          )}
          <button className={styles.linearButton} onClick={handleDisconnect}>
            <Unlink size={13} />
            Disconnect
          </button>
        </div>
      ) : (
        <div className={styles.linearDisconnected}>
          <div className={styles.linearInputRow}>
            <input
              className={styles.fieldInput}
              type="password"
              placeholder="Paste your Linear API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
            />
            <button
              className={styles.linearButton}
              onClick={handleConnect}
              disabled={loading || !apiKey.trim()}
            >
              {loading ? "Connecting..." : "Connect"}
            </button>
          </div>
          {error && <div className={styles.linearError}>{error}</div>}
          <div className={styles.fieldHint}>
            Get your API key from{" "}
            <a
              className={styles.linearLink}
              href="#"
              onClick={(e) => { e.preventDefault(); window.electronAPI.openExternal("https://linear.app/trytango/settings/account/security"); }}
            >
              Linear Settings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Linear Project Section (Project Settings) ──

function LinearProjectSection({ project }: { project: ProjectInfo }) {
  const [connected, setConnected] = useState(false);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const updateProject = useProjectStore((s) => s.updateProject);

  const selectedIds = new Set(project.linearAssociations.map((a) => a.teamId));

  useEffect(() => {
    window.electronAPI.linearIsConnected().then(async (isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        try {
          const t = await window.electronAPI.linearGetTeams();
          setTeams(t);
        } catch {
          // ignore
        }
      }
      setLoading(false);
    });
  }, []);

  const handleToggleTeam = (team: { id: string; name: string; key: string }) => {
    const current = project.linearAssociations;
    const exists = current.some((a) => a.teamId === team.id);
    const next = exists
      ? current.filter((a) => a.teamId !== team.id)
      : [...current, { teamId: team.id, teamName: team.name, teamKey: team.key }];
    updateProject(project.id, { linearAssociations: next });
  };

  if (loading) return null;

  const label = selectedIds.size === 0
    ? "Select teams..."
    : project.linearAssociations.map((a) => a.teamKey).join(", ");

  return (
    <div className={styles.settingsGroup}>
      <div className={styles.sectionTitle}>Linear</div>
      {!connected ? (
        <div className={styles.fieldHint}>
          Connect Linear in Integrations to link this project to a team.
        </div>
      ) : (
        <>
          <label className={styles.fieldLabel}>Teams</label>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <button className={styles.multiSelectTrigger}>
                <span className={styles.multiSelectLabel}>{label}</span>
                <ChevronDown size={14} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className={styles.multiSelectContent} sideOffset={4} align="start">
                {teams.map((team) => {
                  const isSelected = selectedIds.has(team.id);
                  return (
                    <button
                      key={team.id}
                      className={`${styles.multiSelectItem} ${isSelected ? styles.multiSelectItemSelected : ""}`}
                      onClick={() => handleToggleTeam(team)}
                    >
                      <span className={styles.multiSelectCheck}>
                        {isSelected && <Check size={13} />}
                      </span>
                      <span>{team.key} — {team.name}</span>
                    </button>
                  );
                })}
                {teams.length === 0 && (
                  <div className={styles.multiSelectEmpty}>No teams found</div>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </>
      )}
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
  field: "defaultRunCommand";
  label: string;
  placeholder: string;
}> = [
  { field: "defaultRunCommand", label: "Default Run Command", placeholder: "e.g. npm run dev" },
];

const worktreeScriptFields: Array<{
  field: "worktreeStartScript" | "worktreeTeardownScript";
  label: string;
  placeholder: string;
}> = [
  { field: "worktreeStartScript", label: "Start Script", placeholder: "Runs in the terminal when a new worktree is created" },
  { field: "worktreeTeardownScript", label: "Teardown Script", placeholder: "Runs before a worktree is deleted" },
];

function defaultWorktreePath(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `~/.manor/worktrees/${slug}`;
}

function ProjectSettingsPage({ project }: { project: ProjectInfo }) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const nameRef = useRef<HTMLInputElement>(null);
  const worktreePathRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const handleBlur = useCallback(
    (field: "name" | "worktreePath" | "defaultRunCommand" | "worktreeStartScript" | "worktreeTeardownScript") => {
      if (field === "name") {
        const el = nameRef.current;
        if (!el) return;
        const trimmed = el.value.trim();
        if (trimmed && trimmed !== project.name) {
          updateProject(project.id, { name: trimmed });
        }
      } else if (field === "worktreePath") {
        const el = worktreePathRef.current;
        if (!el) return;
        const normalized = el.value.trim() || null;
        if (normalized !== (project.worktreePath ?? null)) {
          updateProject(project.id, { worktreePath: normalized });
        }
      } else {
        const el = fieldRefs.current[field];
        if (!el) return;
        const normalized = el.value.trim() || null;
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
        <div className={styles.sectionTitle}>Worktrees</div>
        <label className={styles.fieldLabel}>Worktree Path</label>
        <input
          ref={worktreePathRef}
          className={styles.fieldInput}
          defaultValue={project.worktreePath ?? ""}
          onBlur={() => handleBlur("worktreePath")}
          placeholder={defaultWorktreePath(project.name)}
        />
        <div className={styles.fieldHint}>
          Directory where new worktrees are created. Defaults to {defaultWorktreePath(project.name)}
        </div>
        {worktreeScriptFields.map(({ field, label, placeholder }) => (
          <div key={field}>
            <label className={styles.fieldLabel}>{label}</label>
            <textarea
              ref={(el) => { fieldRefs.current[field] = el; }}
              className={`${styles.fieldInput} ${styles.fieldTextarea}`}
              defaultValue={project[field] ?? ""}
              onBlur={() => handleBlur(field)}
              placeholder={placeholder}
              rows={4}
            />
          </div>
        ))}
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Scripts</div>
        {scriptFields.map(({ field, label, placeholder }) => (
          <div key={field}>
            <label className={styles.fieldLabel}>{label}</label>
            <textarea
              ref={(el) => { fieldRefs.current[field] = el; }}
              className={`${styles.fieldInput} ${styles.fieldTextarea}`}
              defaultValue={project[field] ?? ""}
              onBlur={() => handleBlur(field)}
              placeholder={placeholder}
              rows={4}
            />
          </div>
        ))}
      </div>

      <LinearProjectSection project={project} />
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
        <Dialog.Content className={styles.modal} onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => { e.preventDefault(); document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus(); }}>
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
                className={`${styles.navItem} ${page.type === "integrations" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "integrations" })}
              >
                <Link size={14} />
                <span>Integrations</span>
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
              {page.type === "integrations" && <IntegrationsPage />}
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
