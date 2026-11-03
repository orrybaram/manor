// SettingsModal, shared by the slides that open Settings: its header, nav and content area, with the page as a parameter.
import "./settings-modal.css";
import { esc } from "../../shell/chrome";
import { icon, type IconName } from "../../shell/icons";

const NAV: readonly [IconName, string][] = [
  ["settings", "General"],
  ["palette", "Appearance"],
  ["keyboard", "Keybindings"],
  ["bell", "Notifications"],
  ["link", "Integrations"],
  ["server", "Hosts"],
  ["smartphone", "Devices"],
  ["calendar-clock", "Automations"],
  ["message-square-text", "Prompts"],
];

type SettingsModal = {
  projects: readonly { id: string; name: string }[];
  /** The nav row that's open: one of `NAV`'s labels, or `activeProject`. */
  activePage?: string;
  activeProject?: string;
  projectsOpen: boolean;
  /** The open page, as HTML. */
  content: string;
};

/**
 * After a redraw that a click caused: the clicked control has gone and the keyboard fell to the page, so Esc wouldn't reach the slide. Hand it to the modal.
 * Not on a slide's own opening, which mustn't take the page's keys; and once the modal shuts, the keyboard is the page's again.
 */
export function keepKeysInSettings(root: HTMLElement): void {
  if (root.contains(document.activeElement)) return;
  root.querySelector<HTMLElement>(".ma-settings-modal")?.focus({ preventScroll: true });
}

/** SettingsModal, and the dim behind it. Rows for its projects carry `data-settings-project`; the close button and dim, `data-close-settings`. */
export function settingsModal({ projects, activePage, activeProject, projectsOpen, content }: SettingsModal): string {
  const nav = NAV.map(([name, label]) => {
    const active = label === activePage;
    return `<button class="ma-settings-nav-item${active ? " ma-settings-nav-active" : ""}" type="button" tabindex="-1"${active ? ' aria-current="page"' : ""}>${icon(name, 14)}<span>${label}</span></button>`;
  }).join("");
  const rows = projectsOpen
    ? projects
        .map((p) => {
          const active = p.id === activeProject;
          return `<button class="ma-settings-nav-item ma-settings-nav-nested${active ? " ma-settings-nav-active" : ""}" type="button" tabindex="-1" data-settings-project="${p.id}"${active ? ' aria-current="page"' : ""}><span class="ma-settings-nav-label">${esc(p.name)}</span></button>`;
        })
        .join("")
    : "";
  return (
    `<div class="ma-settings-overlay" data-close-settings></div>` +
    `<div class="ma-settings-modal" tabindex="-1">` +
    `<div class="ma-settings-header"><div class="ma-settings-title">Settings</div>` +
    `<button class="ma-btn ma-ghost ma-sm" type="button" tabindex="-1" aria-label="Close settings" data-close-settings>${icon("x", 16)}</button></div>` +
    `<div class="ma-settings-layout"><div class="ma-settings-sidebar">` +
    `<div class="ma-settings-search">${icon("search", 13)}<input class="ma-input ma-settings-search-input" type="text" tabindex="-1" readonly placeholder="Search settings..."></div>` +
    `<nav class="ma-settings-nav">${nav}<button class="ma-settings-nav-group" type="button" tabindex="-1" data-nav-projects>${icon(projectsOpen ? "chevron-down" : "chevron-right", 14)}<span>Projects</span></button>${rows}</nav></div>` +
    `<div class="ma-settings-content">${content}</div></div>` +
    `</div>`
  );
}
