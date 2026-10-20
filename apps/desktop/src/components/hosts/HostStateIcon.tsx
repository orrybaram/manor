import Cloud from "lucide-react/dist/esm/icons/cloud";
import CloudOff from "lucide-react/dist/esm/icons/cloud-off";
import Moon from "lucide-react/dist/esm/icons/moon";
import type { HostDisplay } from "../../lib/host-status";
import styles from "./HostIndicator.module.css";

type HostStateIconProps = {
  display: HostDisplay;
  size: number;
};

/**
 * A remote host's glyph: a cloud, crossed out while away, pulsing while a
 * connect runs; a moon while it is asleep, which is not being
 * away. Colour comes from the surrounding tone class.
 */
export function HostStateIcon(props: HostStateIconProps) {
  const { display, size } = props;

  const Icon =
    display.tone === "asleep" ? Moon : display.offline && !display.busy ? CloudOff : Cloud;
  return (
    <Icon
      size={size}
      className={`${styles.glyph} ${display.busy ? styles.pulse : ""}`}
      aria-hidden
    />
  );
}
