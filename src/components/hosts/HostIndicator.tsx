import Cloud from "lucide-react/dist/esm/icons/cloud";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useHostStore } from "../../store/host-store";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { HostPopover } from "./HostPopover";
import { HostStateIcon } from "./HostStateIcon";
import { HEADSTONE } from "./headstone";
import { useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { requestUi } from "../../utils/ui-request";
import styles from "./HostIndicator.module.css";

type HostIndicatorProps = {
  /** The host to show; nothing renders for this machine. */
  hostId: string | null | undefined;
  /**
   * - `icon`: the cloud alone, for the sidebar's project rows.
   * - `chip`: cloud + host name, never the state in words; hover or click opens the
   *   host popover. For the status bar.
   * - `banner`: covers a pane, only while the host is away.
   * - `label`: the chip's look, inert and without a tooltip, for use inside
   *   another control (the New Workspace host picker).
   */
  variant: "icon" | "chip" | "banner" | "label";
  /**
   * The project this indicator speaks for. When set, the icon opens the
   * host popover (and the popover links to this project's Host settings);
   * without it the icon is inert and the chip's popover has no link.
   */
  projectId?: string;
  className?: string;
};

/**
 * The one way Manor shows a remote host: a cloud (crossed out while not
 * connected), tinted by `describeHost`'s tone, named by its ssh target.
 */
export function HostIndicator(props: HostIndicatorProps) {
  const { hostId, variant, projectId, className } = props;
  const display = useHostDisplay(hostId);
  if (!hostId || !display) return null;
  if (variant === "banner" && !display.offline) return null;

  const common = { hostId, display, projectId, className };
  if (variant === "icon") return <HostIcon {...common} />;
  if (variant === "chip") return <HostChip {...common} />;
  if (variant === "label") return <HostLabel {...common} />;
  return <HostBanner {...common} />;
}

/**
 * This machine's counterpart to a remote host's chip, where a list shows
 * every host of a linked group (ADR-192): the sidebar's host sections and
 * the New Workspace host picker.
 */
export function LocalHostLabel() {
  return (
    <span className={styles.local} data-testid="local-host-label">
      <Laptop size={11} aria-hidden />
      This machine
    </span>
  );
}

/**
 * A remote host drawn like `LocalHostLabel`: cloud + ssh target, no chip,
 * so the two sit side by side as equals (the New Folder host toggle).
 */
export function RemoteHostLabel(props: { hostId: string }) {
  const { hostId } = props;
  const target = useHostStore(
    (s) => s.hosts.find((h) => h.hostId === hostId)?.spec?.target ?? hostId,
  );
  return (
    <span className={styles.local} data-testid="remote-host-label">
      <Cloud size={11} aria-hidden />
      {target}
    </span>
  );
}

type VariantProps = {
  hostId: string;
  display: HostDisplay;
  projectId?: string;
  className?: string;
};

function toneClass(display: HostDisplay): string {
  return styles[display.tone];
}

/** Hover text: the state and its summary; the popover adds the actions. */
function tooltipFor(display: HostDisplay): string {
  const state = `${display.target} · ${display.status}`;
  return display.summary ? `${state}. ${display.summary}` : state;
}

function HostIcon(props: VariantProps) {
  const { hostId, display, projectId, className } = props;
  const label = tooltipFor(display);
  const iconClass = `${styles.icon} ${toneClass(display)} ${className ?? ""}`;
  if (!projectId) {
    return (
      <Tooltip label={label} side="right">
        <span className={iconClass} aria-label={label} data-testid="host-indicator-icon">
          <HostStateIcon display={display} size={12} />
        </span>
      </Tooltip>
    );
  }
  // No tooltip: the popover opens on hover and says the same, and more.
  return (
    <HostPopover hostId={hostId} projectId={projectId} side="right">
      <Button
        variant="link"
        className={`${iconClass} ${styles.clickable}`}
        aria-label={label}
        data-testid="host-indicator-icon"
        // The icon sits inside rows that toggle or select on click.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <HostStateIcon display={display} size={12} />
      </Button>
    </HostPopover>
  );
}

/** A chip names the host and nothing else; glyph and tone carry the state. */
function ChipContent(props: { display: HostDisplay }) {
  const { display } = props;

  return (
    <>
      <HostStateIcon display={display} size={11} />
      <span className={styles.target}>{display.target}</span>
    </>
  );
}

function chipClassFor(display: HostDisplay, className?: string): string {
  return `${styles.chip} ${toneClass(display)} ${className ?? ""}`;
}

function HostChip(props: VariantProps) {
  const { hostId, display, projectId, className } = props;
  const label = tooltipFor(display);

  // No tooltip: the popover opens on hover and says the same, and more.
  return (
    <HostPopover hostId={hostId} projectId={projectId} side="top">
      <Button
        variant="link"
        className={`${chipClassFor(display, className)} ${styles.clickable}`}
        aria-label={label}
        data-testid="host-indicator-chip"
      >
        <ChipContent display={display} />
      </Button>
    </HostPopover>
  );
}

function HostLabel(props: VariantProps) {
  const { display, className } = props;

  return (
    <span className={chipClassFor(display, className)} data-testid="host-indicator-label">
      <ChipContent display={display} />
    </span>
  );
}

/** The raw ssh output, when it says more than the summary does. */
function rawDetail(display: HostDisplay): string | null {
  const summary = display.summary ?? display.detail;
  return display.detail && display.detail !== summary ? display.detail : null;
}

/**
 * Covers a pane while its host is away, written as more terminal output:
 * a headstone, the ssh command and what ssh said, Manor's verdict, and a
 * keyboard menu (retry, host settings).
 * Calm by default; only the status word takes the host's tone.
 */
function HostBanner(props: VariantProps) {
  const { hostId, display, projectId, className } = props;
  const raw = rawDetail(display);
  const mark = display.tone === "error" ? "\u2717" : "\u2026";
  return (
    <div
      className={`${styles.banner} ${toneClass(display)} ${className ?? ""}`}
      role="status"
      data-testid="host-offline-banner"
    >
      <pre className={`${styles.headstone} ${display.busy ? styles.pulse : ""}`} aria-hidden>
        {HEADSTONE}
      </pre>
      <div className={styles.output}>
        <pre className={styles.line}>
          <span className={styles.prompt}>manor {"\u276f"}</span> ssh {display.target}
          {raw && (
            <>
              {"\n"}
              <span className={styles.muted}>{raw}</span>
            </>
          )}
        </pre>
        <pre className={styles.line}>
          <span className={styles.status}>
            {mark} {display.status.toLowerCase()}
          </span>
          {"  "}
          {display.banner}
          {display.summary && (
            <>
              {"\n"}
              <span className={styles.muted}>{display.summary}</span>
            </>
          )}
        </pre>
        <HostAwayMenu hostId={hostId} display={display} projectId={projectId} />
      </div>
    </div>
  );
}

type MenuOption = { label: string; disabled?: boolean; run: () => void };

const NEXT_KEYS = new Set(["ArrowDown", "j"]);
const PREV_KEYS = new Set(["ArrowUp", "k"]);

/**
 * The away pane's choices, as a terminal select prompt: arrows (or j/k)
 * move, Enter picks. Keys are caught on the whole pane, not just the menu:
 * the terminal underneath takes focus back on its own (on mount, when the
 * pane is focused), and it ignores input while its host is away anyway.
 */
function HostAwayMenu(props: { hostId: string; display: HostDisplay; projectId?: string }) {
  const { hostId, display, projectId } = props;
  const retryConnect = useHostStore((s) => s.retryConnect);

  const options: MenuOption[] = [];
  // Kept while a connect runs (disabled) so the list, and focus, stay put.
  if (display.canRetry || display.busy) {
    options.push({
      label: display.busy ? "retrying\u2026" : "retry now",
      disabled: display.busy,
      run: () => void retryConnect(hostId),
    });
  }
  if (projectId) {
    options.push({
      label: "host settings",
      run: () => requestUi({ type: "open-project-settings", projectId, section: "project-host" }),
    });
  }

  const [active, setActive] = useState(0);
  const index = Math.min(active, options.length - 1);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The pane's key listener is bound once; it reads the current render's
  // options through this.
  const latest = useRef({ options, index });
  latest.current = { options, index };

  const pick = (option: MenuOption | undefined) => {
    if (option && !option.disabled) option.run();
  };

  useMountEffect(() => {
    // The pane the overlay covers: the banner's container.
    const pane = menuRef.current?.closest(`.${styles.banner}`)?.parentElement;
    if (!pane) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Leave real text fields (the terminal's search bar) alone; xterm's
      // own hidden textarea is fair game.
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        (target.tagName === "TEXTAREA" && !target.classList.contains("xterm-helper-textarea"))
      ) {
        return;
      }
      const { options, index } = latest.current;
      if (options.length === 0) return;
      let next: number | null = null;
      if (NEXT_KEYS.has(e.key)) next = (index + 1) % options.length;
      else if (PREV_KEYS.has(e.key)) next = (index - 1 + options.length) % options.length;
      else if (e.key === "Enter" || e.key === " ") pick(options[index]);
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (next !== null) {
        setActive(next);
        buttonRefs.current[next]?.focus();
      }
    };
    // Clicking the overlay's text focuses nothing, which leaves the keyboard
    // on <body>, outside the pane. Put it on the menu, unless the click was
    // the end of selecting text (the ssh output) to copy.
    const banner = menuRef.current?.closest(`.${styles.banner}`);
    const onClick = (e: Event) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (window.getSelection()?.isCollapsed === false) return;
      buttonRefs.current[latest.current.index]?.focus();
    };
    // When the pane takes the keyboard (its tab or workspace was clicked and
    // the terminal focused itself), pass it on to the menu so the focus ring
    // shows where the keys will go.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (menuRef.current?.contains(target) || target.tagName === "INPUT") return;
      buttonRefs.current[latest.current.index]?.focus();
    };
    pane.addEventListener("keydown", onKeyDown, true);
    pane.addEventListener("focusin", onFocusIn);
    banner?.addEventListener("click", onClick);
    // Already holding the keyboard when the host went away.
    if (document.activeElement && pane.contains(document.activeElement)) {
      buttonRefs.current[latest.current.index]?.focus();
    }
    return () => {
      pane.removeEventListener("keydown", onKeyDown, true);
      pane.removeEventListener("focusin", onFocusIn);
      banner?.removeEventListener("click", onClick);
    };
  });

  // Rendered even when empty: the mount effect finds the pane through it.
  return (
    <div ref={menuRef} className={styles.menu} role="group" aria-label="Host actions">
      {options.map((option, i) => (
        <Button
          key={option.label}
          ref={(el) => {
            buttonRefs.current[i] = el;
          }}
          variant="link"
          className={`${styles.option} ${i === index ? styles.optionActive : ""}`}
          tabIndex={i === index ? 0 : -1}
          aria-disabled={option.disabled || undefined}
          onFocus={() => setActive(i)}
          onPointerEnter={() => setActive(i)}
          onClick={() => pick(option)}
        >
          <span className={styles.caret} aria-hidden>
            {i === index ? "\u276f" : " "}
          </span>
          {option.label}
        </Button>
      ))}
    </div>
  );
}
