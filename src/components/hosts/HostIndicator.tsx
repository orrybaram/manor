import Cloud from "lucide-react/dist/esm/icons/cloud";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useHostStore } from "../../store/host-store";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { HostPopover } from "./HostPopover";
import { HostStateIcon } from "./HostStateIcon";
import styles from "./HostIndicator.module.css";

type HostIndicatorProps = {
  /** The host to show; nothing renders for this machine. */
  hostId: string | null | undefined;
  /**
   * - `icon`: the cloud alone, for the sidebar's project rows.
   * - `chip`: cloud + host name, never the state in words; click opens the
   *   host popover. For the status bar.
   * - `banner`: one line over a pane, only while the host is away.
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
  return (
    <Tooltip label={label} side="right">
      <span className={styles.trigger}>
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
      </span>
    </Tooltip>
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

  return (
    <Tooltip label={label} side="top">
      <span className={styles.trigger}>
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
      </span>
    </Tooltip>
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

function HostBanner(props: VariantProps) {
  const { hostId, display, className } = props;
  const retryConnect = useHostStore((s) => s.retryConnect);
  const text = <span className={styles.bannerText}>{display.banner}</span>;
  return (
    <div
      className={`${styles.banner} ${toneClass(display)} ${className ?? ""}`}
      role="status"
      data-testid="host-offline-banner"
    >
      <HostStateIcon display={display} size={12} />
      {display.detail ? <Tooltip label={display.detail}>{text}</Tooltip> : text}
      {display.canRetry && (
        <Button
          size="sm"
          variant="ghost"
          className={styles.retry}
          onClick={() => void retryConnect(hostId)}
        >
          Retry now
        </Button>
      )}
    </div>
  );
}
