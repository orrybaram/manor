// Themes: a project's page in Settings, whose Theme select repaints the whole
// window, as the project's page does in the app (App.tsx's effectiveThemeName).
import "./themes.css";
import { esc, leafPane, tabbedPanel } from "../../shell/chrome";
import { icon } from "../../shell/icons";
import {
  CATPPUCCIN_LATTE,
  DRACULA,
  GITHUB_LIGHT_DEFAULT,
  GRUVBOX_DARK,
  KANAGAWA_WAVE,
  MONOKAI_CLASSIC,
  NIGHT_OWL,
  NORD,
  ROSE_PINE,
  TOKYONIGHT,
} from "../../shell/palettes";
import { DEFAULT_THEME, MANOR_THEME, applyTheme, type Theme } from "../../shell/tokens";
import { SLIDE_MS, type Slide } from "../slide";
import { keepKeysInSettings, settingsModal } from "./settings-modal";

const GLOBAL_THEME = "__global__";

/** Made up, in the shape a custom theme takes: the one row badged `Yours`. */
const PROJECT_INK: Theme = {
  ...DEFAULT_THEME,
  background: "#14161f",
  foreground: "#d4d8e8",
  cursorAccent: "#14161f",
  selectionForeground: "#d4d8e8",
  red: "#ef5f6b",
  green: "#6fcf8e",
  yellow: "#e9c46a",
  blue: "#6c9cf5",
  magenta: "#c58af0",
  cyan: "#5fd0d6",
};

/** The picker's order: electron/theme.ts `catalog()`, built-ins, then custom, then Ghostty's by name. */
const CATALOG: readonly { name: string; badge?: string; theme: Theme }[] = [
  { name: "Catppuccin Mocha", badge: "Built-in", theme: DEFAULT_THEME },
  { name: "Manor", badge: "Built-in", theme: MANOR_THEME },
  { name: "Project Ink", badge: "Yours", theme: PROJECT_INK },
  { name: "Catppuccin Latte", theme: CATPPUCCIN_LATTE },
  { name: "Dracula", theme: DRACULA },
  { name: "GitHub Light Default", theme: GITHUB_LIGHT_DEFAULT },
  { name: "Gruvbox Dark", theme: GRUVBOX_DARK },
  { name: "Kanagawa Wave", theme: KANAGAWA_WAVE },
  { name: "Monokai Classic", theme: MONOKAI_CLASSIC },
  { name: "Night Owl", theme: NIGHT_OWL },
  { name: "Nord", theme: NORD },
  { name: "Rose Pine", theme: ROSE_PINE },
  { name: "TokyoNight", theme: TOKYONIGHT },
];

type Option = { value: string; label: string; trailing: string };

const badge = (text: string) => `<span class="ma-theme-badge">${text}</span>`;

/** ProjectThemeSelector's rows: `Global theme`, then each theme's badge and six palette dots. */
const OPTIONS: readonly Option[] = [
  { value: GLOBAL_THEME, label: "Global theme", trailing: badge("Default") },
  ...CATALOG.map(({ name, badge: label, theme }) => ({
    value: name,
    label: name,
    trailing:
      (label ? badge(label) : "") +
      `<div class="ma-theme-dots">${[theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan]
        .map((c) => `<div style="background: ${c}"></div>`)
        .join("")}</div>`,
  })),
];

/** apps/desktop/src/project-colors.ts: `null` is Default, drawn in the accent. */
const PROJECT_COLORS: readonly { value: string | null; label: string; cssVar: string }[] = [
  { value: null, label: "Default", cssVar: "--accent" },
  { value: "red", label: "Red", cssVar: "--red" },
  { value: "green", label: "Green", cssVar: "--green" },
  { value: "yellow", label: "Yellow", cssVar: "--yellow" },
  { value: "blue", label: "Blue", cssVar: "--blue" },
  { value: "magenta", label: "Magenta", cssVar: "--magenta" },
  { value: "cyan", label: "Cyan", cssVar: "--cyan" },
];

type Project = {
  id: string;
  name: string;
  color: string | null;
  /** The theme's name, or null for the global theme. */
  themeName: string | null;
  workspaces: { id: string; branch: string; isMain?: boolean }[];
  collapsed: boolean;
  hostOpen: boolean;
  previewUrls: boolean;
  /** What's been typed into the page's plain fields. */
  fields: Record<string, string>;
};

function createProjects(): Project[] {
  const project = (id: string, color: string | null, themeName: string, ...branches: string[]): Project => ({
    id,
    name: id,
    color,
    themeName,
    workspaces: [{ id: `${id}-local`, branch: "main", isMain: true }, ...branches.map((b) => ({ id: b, branch: b }))],
    collapsed: false,
    hostOpen: true,
    previewUrls: true,
    fields: {},
  });
  return [
    project("harbor", "cyan", "Manor", "tide-tables", "dock-fees"),
    project("almanac", "magenta", "Catppuccin Latte", "moon-phases"),
    project("lantern", null, "TokyoNight", "wick-trim"),
  ];
}

/** A control in a window that's one image to the keyboard: reached by pointer, or from the select. */
const input = (attrs: string, value: string, placeholder = "") =>
  `<input class="ma-input" type="text" tabindex="-1" spellcheck="false" ${attrs} value="${esc(value)}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}>`;

const field = (p: Project, name: string, placeholder: string) => input(`data-field="${name}"`, p.fields[name] ?? "", placeholder);

const script = (p: Project, name: string, label: string, placeholder: string) =>
  `<div class="ma-stack"><label class="ma-field-label">${label}</label>` +
  `<textarea class="ma-input ma-mono ma-textarea" tabindex="-1" spellcheck="false" rows="4" data-field="${name}" placeholder="${placeholder}">${esc(p.fields[name] ?? "")}</textarea></div>`;

/** ProjectHostRow's `defaultWorktreePath`. */
function worktreeDefault(p: Project): string {
  const slug = p.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `~/.manor/worktrees/${slug}`;
}

/** lib/portless-hostname.ts `portlessHostname`, for a project's main checkout on this machine. */
const previewHostname = (p: Project) =>
  `${p.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)}.localhost`;

function hostsSection(p: Project): string {
  const body =
    `<div class="ma-host-body">` +
    `<div class="ma-stack"><label class="ma-field-label">Default Branch</label><div class="ma-field-static">main</div></div>` +
    `<div class="ma-stack"><label class="ma-field-label">Worktree Path</label>${field(p, "worktreePath", worktreeDefault(p))}` +
    `<div class="ma-field-hint">Directory where new worktrees are created. Defaults to <span data-worktree-default>${esc(worktreeDefault(p))}</span></div></div>` +
    script(p, "worktreeStartScript", "Start Script", "Runs in the terminal when a new worktree is created") +
    script(p, "worktreeTeardownScript", "Teardown Script", "Runs before a worktree is deleted") +
    `<div class="ma-stack"><div class="ma-setting-row"><div class="ma-setting-main" data-preview-urls><span class="ma-setting-text">` +
    `<span class="ma-setting-label">Named preview URLs</span><span class="ma-setting-hint">Route this project's dev servers through the portless proxy so each workspace gets a stable hostname like <code data-preview-host>${esc(previewHostname(p))}</code>. When off, ports open as <code>localhost:&lt;port&gt;</code>.</span></span>` +
    `<button class="ma-switch" type="button" tabindex="-1" role="switch" aria-checked="${p.previewUrls}" data-state="${p.previewUrls ? "checked" : "unchecked"}"><span></span></button>` +
    `</div></div></div>` +
    `<div class="ma-host-footer"><button class="ma-btn ma-link" type="button" tabindex="-1">Open This machine in Hosts</button></div>` +
    `</div>`;
  return (
    `<div class="ma-stack"><div class="ma-section-row"><div class="ma-section-label">Hosts</div>` +
    `<button class="ma-select-trigger" type="button" tabindex="-1" style="max-width: 200px"><div class="ma-select-trigger-content"><span class="ma-select-trigger-text">Set up on…</span></div>${icon("chevron-down", 14)}</button></div>` +
    `<div class="ma-field-hint">Where this project is set up. Each host keeps its own path, worktrees and ports.</div>` +
    `<div class="ma-host-list"><div><div class="ma-host-header"><button class="ma-btn ma-ghost ma-host-toggle" type="button" tabindex="-1" aria-expanded="${p.hostOpen}" data-host-toggle>` +
    `<span class="ma-host-icon">${icon("laptop", 15)}</span><span class="ma-host-text"><span class="ma-host-name">This machine</span>` +
    `<span class="ma-host-status"><span class="ma-host-status-dot"></span>Local</span><span class="ma-host-detail">/Users/you/Code/${p.id}</span></span>` +
    `<span class="ma-host-chevron${p.hostOpen ? " ma-host-chevron-open" : ""}">${icon("chevron-right", 14)}</span></button></div>` +
    (p.hostOpen ? body : "") +
    `</div></div></div>`
  );
}

/** ProjectSettingsPage, for a project with Linear not connected and no commands yet. */
function projectPage(p: Project): string {
  const selected = OPTIONS.find((o) => o.value === (p.themeName ?? GLOBAL_THEME))!;
  const colors = PROJECT_COLORS.map((c) => {
    const on = p.color === c.value;
    return (
      `<button class="ma-color-option${on ? " ma-color-selected" : ""}" type="button" tabindex="-1" style="background: var(${c.cssVar})" title="${c.label}" data-color="${c.value ?? ""}">` +
      (on ? icon("check", 10).replace('stroke="currentColor" stroke-width="2"', 'stroke="var(--bg)" stroke-width="3"') : "") +
      `</button>`
    );
  }).join("");
  return (
    `<div class="ma-settings-page">` +
    `<div class="ma-stack"><div class="ma-section-label">General</div><div class="ma-general-grid">` +
    `<div class="ma-stack"><label class="ma-field-label">Name</label>${input("data-name", p.name)}</div>` +
    `<div class="ma-stack"><label class="ma-field-label" for="project-theme">Theme</label>` +
    `<button id="project-theme" class="ma-select-trigger" type="button" tabindex="-1" role="combobox" aria-expanded="false" data-theme-trigger>` +
    `<div class="ma-select-trigger-content"><span class="ma-select-trigger-text">${selected.label}</span><span class="ma-select-trailing">${selected.trailing}</span></div>${icon("chevron-down", 14)}</button></div>` +
    `</div><div class="ma-stack"><label class="ma-field-label">Color</label><div class="ma-color-picker">${colors}</div></div></div>` +
    `<div class="ma-stack"><div class="ma-section-label">Linear</div><div class="ma-field-hint">Connect Linear in Integrations to link this project to a team.</div></div>` +
    hostsSection(p) +
    `<div class="ma-stack"><div class="ma-section-label">Agent</div><label class="ma-field-label">Agent Command</label>${field(p, "agentCommand", "claude --dangerously-skip-permissions")}</div>` +
    `<div class="ma-stack"><div class="ma-section-label">Commands</div><div class="ma-command-list"><button class="ma-add-command" type="button" tabindex="-1">${icon("plus", 12)}Add Command</button></div></div>` +
    `</div>`
  );
}

export const themes: Slide = {
  id: "themes",
  label: "Themes",
  title: "A different look for each project.",
  description: "Pick from hundreds of themes or make your own. Give a project its own and you always know where you are.",
  hint: "Switch projects in the sidebar, then pick a theme.",
  alt: "An interactive mock of Manor's Settings, open on a project's page with its Name and Theme fields. Each project in the sidebar has its own theme, and switching project repaints the whole window.",
  enter(ctx) {
    const { root } = ctx;
    const projects = createProjects();
    const first = projects[0]!;
    /** The open workspace's id, which picks the sidebar's project. */
    let ws = first.workspaces[0]!.id;
    /** The project whose Settings page is open, or null with Settings shut. */
    let page: Project | null = first;
    let projectsOpen = true;
    let clicked = false;
    let justOpened = false;
    let scrollTop = 0;
    let sinceSwitch = 0;

    const selected = () => projects.find((p) => p.workspaces.some((w) => w.id === ws))!;

    /** App.tsx's effectiveThemeName: the Settings page's project, else the selected one; null is the global theme. */
    const paint = () => {
      const { themeName } = page ?? selected();
      applyTheme(root, CATALOG.find((t) => t.name === themeName)?.theme ?? DEFAULT_THEME);
    };
    paint();

    // ---- the select ---------------------------------------------------------

    type Open = { content: HTMLElement; search: HTMLInputElement; list: HTMLElement; shown: Option[]; active: number };
    let select: Open | null = null;

    const trigger = () => root.querySelector<HTMLElement>("[data-theme-trigger]");

    /** Radix's `side="bottom" align="start" sideOffset={4}`, flipping above when it won't fit. */
    const place = () => {
      const button = trigger();
      if (!select || !button) return;
      const scale = root.getBoundingClientRect().width / root.offsetWidth;
      const origin = root.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const top = (rect.top - origin.top) / scale;
      const below = (rect.bottom - origin.top) / scale + 4;
      const height = select.content.offsetHeight;
      select.content.style.left = `${(rect.left - origin.left) / scale}px`;
      select.content.style.top = `${below + height > root.offsetHeight ? top - 4 - height : below}px`;
    };

    /** SearchableSelect's list: matches by label, the current choice pinned first above a divider. */
    const drawList = (query: string) => {
      if (!select || !page) return;
      const lower = query.toLowerCase();
      const current = page.themeName ?? GLOBAL_THEME;
      const matching = query ? OPTIONS.filter((o) => o.label.toLowerCase().includes(lower)) : OPTIONS;
      const shown = [...matching.filter((o) => o.value === current), ...matching.filter((o) => o.value !== current)];
      const pinned = shown.length > 1 && shown[0]!.value === current;
      select.shown = shown;
      select.active = 0;
      select.list.innerHTML = shown.length
        ? shown
            .map(
              (o, i) =>
                `<div class="ma-select-option${i === 0 ? " ma-select-active" : ""}${i === 0 && pinned ? " ma-select-pinned" : ""}" role="option" aria-selected="${i === 0}" data-row="${i}">` +
                `<span class="ma-select-label">${o.label}</span><span class="ma-select-trailing">${o.trailing}</span>` +
                (o.value === current ? icon("check", 12).replace("<svg ", '<svg class="ma-select-check" ') : "") +
                `</div>`,
            )
            .join("")
        : `<div class="ma-select-empty">No results</div>`;
      select.list.scrollTop = 0;
    };

    /** The highlight, which hover and the arrows share; `scrollIntoView` would move the page too. */
    const highlight = (next: number) => {
      if (!select) return;
      select.active = next;
      for (const row of select.list.querySelectorAll<HTMLElement>("[data-row]")) {
        const on = Number(row.dataset.row) === next;
        row.classList.toggle("ma-select-active", on);
        row.setAttribute("aria-selected", String(on));
        if (on) {
          if (row.offsetTop < select.list.scrollTop) select.list.scrollTop = row.offsetTop;
          const bottom = row.offsetTop + row.offsetHeight - select.list.clientHeight;
          if (bottom > select.list.scrollTop) select.list.scrollTop = bottom;
        }
      }
    };

    const closeSelect = () => {
      if (!select) return;
      const { content } = select;
      select = null; // First: removing a focused field blurs it, which lands back here.
      content.remove();
      trigger()?.setAttribute("aria-expanded", "false");
    };

    const pick = (option: Option | undefined) => {
      if (!option || !page) return;
      page.themeName = option.value === GLOBAL_THEME ? null : option.value;
      closeSelect();
      paint();
      ctx.render();
      trigger()?.focus({ preventScroll: true });
    };

    const openSelect = () => {
      const layer = root.querySelector<HTMLElement>(".ma-select-layer");
      const button = trigger();
      if (select || !layer || !button) return;
      const content = document.createElement("div");
      content.className = "ma-select-content";
      content.innerHTML = `<input class="ma-select-search" type="text" tabindex="-1" spellcheck="false" placeholder="Search..." aria-controls="theme-listbox"><div class="ma-select-list" role="listbox" id="theme-listbox"></div>`;
      layer.append(content);
      const search = content.querySelector("input")!;
      select = { content, search, list: content.querySelector(".ma-select-list")!, shown: [], active: 0 };
      drawList("");
      place();
      button.setAttribute("aria-expanded", "true");

      search.addEventListener("input", () => drawList(search.value));
      // Radix picks on mouse down, and a press anywhere in the list leaves the search focused.
      content.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const row = (e.target as Element).closest<HTMLElement>("[data-row]");
        if (row) pick(select?.shown[Number(row.dataset.row)]);
      });
      content.addEventListener("mouseover", (e) => {
        const row = (e.target as Element).closest<HTMLElement>("[data-row]");
        if (row && select && Number(row.dataset.row) !== select.active) highlight(Number(row.dataset.row));
      });
      // Clicking outside, in the window or on the page. Still the active element means the browser window lost focus, which leaves it open.
      search.addEventListener("blur", () => {
        if (document.activeElement !== search) closeSelect();
      });
      search.focus({ preventScroll: true });
    };

    // ---- the window ---------------------------------------------------------

    const openSettings = (p: Project) => {
      page = p;
      justOpened = true;
      paint();
      ctx.render();
    };

    /** NameField's commit. In place, without a redraw: its blur may be a press on its way to a row. */
    const commitName = (p: Project, value: string) => {
      const name = value.trim();
      if (!name || name === p.name) return;
      p.name = name;
      const row = root.querySelector(`[data-settings-project="${p.id}"] .ma-settings-nav-label`);
      const sidebarRow = root.querySelector(`[data-project="${p.id}"] .ma-project-name`);
      if (row) row.textContent = name;
      if (sidebarRow) sidebarRow.textContent = name;
      if (selected() === p) root.querySelector(".ma-status-left .ma-segment")!.textContent = name;
      if (page !== p) return;
      root.querySelector('[data-field="worktreePath"]')?.setAttribute("placeholder", worktreeDefault(p));
      const worktree = root.querySelector("[data-worktree-default]");
      const host = root.querySelector("[data-preview-host]");
      if (worktree) worktree.textContent = worktreeDefault(p);
      if (host) host.textContent = previewHostname(p);
    };

    const closeSettings = () => {
      // Esc while renaming: the field only blurs once the redraw removes it, too late for the markup.
      const nameField = root.querySelector<HTMLInputElement>("[data-name]");
      if (page && nameField) commitName(page, nameField.value);
      closeSelect();
      page = null;
      paint();
      ctx.render();
    };

    const showPage = (p: Project) => {
      closeSelect();
      page = p;
      paint();
      ctx.render();
    };

    return {
      render: () => {
        scrollTop = root.querySelector(".ma-settings-content")?.scrollTop ?? scrollTop;
        const open = selected();
        const w = open.workspaces.find((x) => x.id === ws)!;
        const prompt = `<span class="g">➜</span>  <span class="c">${esc(open.name)}</span> <span class="b">git:(</span><span class="r">${esc(w.branch)}</span><span class="b">)</span> <span class="ma-cursor"> </span>`;
        return {
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            color: p.color ?? undefined,
            selected: p === open,
            collapsed: p.collapsed,
            workspaces: p.workspaces.map((x) => ({
              id: x.id,
              name: x.isMain ? "local" : x.id,
              branch: x.branch,
              isMain: !!x.isMain,
              active: x.id === ws,
              indicator: null,
            })),
          })),
          agentGroups: [],
          unread: false,
          crumbs: [open.name, w.branch],
          main: tabbedPanel(
            [{ id: w.id, title: w.branch, active: true, status: null, pulse: false }],
            leafPane({ title: open.name, focused: true, hasChat: false, body: prompt }),
          ),
          overlay: page
            ? settingsModal({ projects, activeProject: page.id, projectsOpen, content: projectPage(page) }) + `<div class="ma-select-layer"></div>`
            : undefined,
        };
      },
      drawn: () => {
        const content = root.querySelector<HTMLElement>(".ma-settings-content");
        if (!content || !page) return;
        const shown = page;
        content.scrollTop = scrollTop;
        content.addEventListener("scroll", place);
        // A press on the trigger with the list open mustn't blur it shut, only for the click to open it again.
        trigger()?.addEventListener("mousedown", (e) => {
          if (select) e.preventDefault();
        });
        // Typed into in place: a redraw would take the focus, and the mouse press that moved it.
        content.addEventListener("input", (e) => {
          const el = e.target as HTMLInputElement;
          if (el.dataset.field) shown.fields[el.dataset.field] = el.value;
        });
        // The name commits on blur, as NameField's does.
        content.querySelector<HTMLInputElement>("[data-name]")?.addEventListener("blur", (e) => {
          commitName(shown, (e.target as HTMLInputElement).value);
        });
        // SettingsModal's own scaleIn and the overlay's fadeIn, when it comes back; the slide opens with it already there.
        if (justOpened && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          root.querySelector(".ma-settings-overlay")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
          root.querySelector(".ma-settings-modal")?.animate(
            [
              { opacity: 0, transform: "scale(0.96)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 150, easing: "ease-out" },
          );
        }
        justOpened = false;
        if (clicked) keepKeysInSettings(root);
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t)) return;
        clicked = true;
        const hit = <E extends Element = HTMLElement>(selector: string) => t.closest<E>(selector);
        const toggleButton = hit("[data-theme-trigger]");
        if (toggleButton) {
          if (select) {
            closeSelect();
          } else {
            openSelect();
          }
          return;
        }
        if (hit("[data-close-settings]")) return closeSettings();
        const projectId = hit("[data-settings-project]")?.dataset.settingsProject;
        const navTo = projects.find((p) => p.id === projectId);
        if (navTo) return showPage(navTo);
        if (hit("[data-nav-projects]")) {
          projectsOpen = !projectsOpen;
          return ctx.render();
        }
        const color = hit("[data-color]");
        if (color && page) {
          page.color = color.dataset.color || null;
          return ctx.render();
        }
        if (hit("[data-host-toggle]") && page) {
          page.hostOpen = !page.hostOpen;
          return ctx.render();
        }
        if (hit("[data-preview-urls]") && page) {
          page.previewUrls = !page.previewUrls;
          return ctx.render();
        }
        // The window behind, once Settings is shut.
        const row = hit("[data-project]");
        const rowProject = projects.find((p) => p.id === row?.dataset.project);
        if (rowProject && hit('[aria-label="Project Settings"]')) return openSettings(rowProject);
        // New Workspace and New Folder stop their clicks from reaching the header, as ProjectHeaderActions' do.
        if (hit(".ma-project-actions")) return;
        const wsId = hit("[data-ws]")?.dataset.ws;
        if (wsId) {
          ws = wsId;
          paint();
          return ctx.render();
        }
        if (rowProject && hit(".ma-project-header")) {
          rowProject.collapsed = !rowProject.collapsed;
          ctx.render();
        }
      },
      onKey: (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as Element | null;
        if (select && target === select.search) {
          const n = select.shown.length;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (n) highlight((select.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(select.shown[select.active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeSelect();
            trigger()?.focus({ preventScroll: true });
          }
          return;
        }
        if (!target || !root.contains(target)) return;
        if (e.key === "ArrowDown" && target === trigger()) {
          e.preventDefault();
          openSelect();
        } else if (e.key === "Escape" && page) {
          e.preventDefault();
          closeSettings();
        }
      },
      // Passes through the projects so an untouched slide shows the repaints. Never with a field in use: a redraw would take its focus.
      onFrame: ({ ms, advancing }) => {
        if (!advancing || !page || select || root.contains(document.activeElement)) return;
        sinceSwitch += ms;
        if (sinceSwitch < SLIDE_MS / 3) return;
        sinceSwitch %= SLIDE_MS / 3;
        page = projects[(projects.indexOf(page) + 1) % projects.length]!;
        paint();
        ctx.render();
      },
    };
  },
};
