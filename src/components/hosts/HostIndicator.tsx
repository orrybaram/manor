import Cloud from "lucide-react/dist/esm/icons/cloud";
import CloudOff from "lucide-react/dist/esm/icons/cloud-off";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useHostStore } from "../../store/host-store";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import type { HostDisplay } from "../../lib/host-status";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { requestUi } from "../../utils/ui-request";
import styles from "./HostIndicator.module.css";

type HostIndicatorProps = {
  /** The host to show; nothing renders for this machine. */
  hostId: string | null | undefined;
  /**
   * - `icon`: the cloud alone, for the sidebar's project rows.
   * - `chip`: cloud + host name, adding the state when not connected; click
   *   retries. For the status bar and project settings.
   * - `banner`: one line over a pane, only while the host is away.
   * - `label`: the chip's look, inert and without a tooltip, for use inside
   *   another control (the New Workspace host picker).
   */
  variant: "icon" | "chip" | "banner" | "label";
  /**
   * The project this indicator speaks for. When set, clicking the icon or
   * chip opens that project's Host settings; without it the chip retries
   * the connection instead (the settings page's own chip), and the icon is
   * inert.
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

type VariantProps = {
  hostId: string;
  display: HostDisplay;
  projectId?: string;
  className?: string;
};

function openHostSettings(projectId: string): void {
  requestUi({ type: "open-project-settings", projectId, section: "project-host" });
}

function toneClass(display: HostDisplay): string {
  return [styles[display.tone], display.busy ? styles.busy : ""].join(" ");
}

function StateIcon(props: { display: HostDisplay; size: number }) {
  const { display, size } = props;
  const Icon = display.offline && !display.busy ? CloudOff : Cloud;
  return <Icon size={size} className={styles.glyph} aria-hidden />;
}

function tooltipFor(display: HostDisplay, action: string | null): string {
  const parts = [`${display.target} · ${display.status}`];
  if (display.detail) parts.push(display.detail);
  if (action) parts.push(action);
  return parts.join(". ");
}

function HostIcon(props: VariantProps) {
  const { display, projectId, className } = props;
  const label = tooltipFor(display, null);
  const iconClass = `${styles.icon} ${toneClass(display)} ${className ?? ""}`;
  return (
    <Tooltip label={label} side="right">
      {projectId ? (
        <Button
          variant="link"
          className={`${iconClass} ${styles.clickable}`}
          aria-label={label}
          data-testid="host-indicator-icon"
          onClick={(e) => {
            // The icon sits inside rows that toggle or select on click.
            e.stopPropagation();
            openHostSettings(projectId);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <StateIcon display={display} size={12} />
        </Button>
      ) : (
        <span className={iconClass} aria-label={label} data-testid="host-indicator-icon">
          <StateIcon display={display} size={12} />
        </span>
      )}
    </Tooltip>
  );
}

function ChipContent(props: { display: HostDisplay }) {
  const { display } = props;

  return (
    <>
      <StateIcon display={display} size={11} />
      <span className={styles.target}>{display.target}</span>
      {display.offline && (
        <span className={styles.state}>· {display.status.toLowerCase()}</span>
      )}
    </>
  );
}

function chipClassFor(display: HostDisplay, className?: string): string {
  return `${styles.chip} ${toneClass(display)} ${className ?? ""}`;
}

function HostChip(props: VariantProps) {
  const { hostId, display, projectId, className } = props;
  const retryConnect = useHostStore((s) => s.retryConnect);
  const onClick = projectId
    ? () => openHostSettings(projectId)
    : display.canRetry
      ? () => void retryConnect(hostId)
      : null;
  const label = tooltipFor(
    display,
    !projectId && onClick ? "Click to retry." : null,
  );
  const content = <ChipContent display={display} />;
  const chipClass = chipClassFor(display, className);

  return (
    <Tooltip label={label} side="top">
      {onClick ? (
        <Button
          variant="link"
          className={`${chipClass} ${styles.clickable}`}
          onClick={onClick}
          aria-label={label}
          data-testid="host-indicator-chip"
        >
          {content}
        </Button>
      ) : (
        <span className={chipClass} aria-label={label} data-testid="host-indicator-chip">
          {content}
        </span>
      )}
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
      <StateIcon display={display} size={12} />
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
