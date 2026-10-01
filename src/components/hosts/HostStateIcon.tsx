import Cloud from "lucide-react/dist/esm/icons/cloud";
import CloudOff from "lucide-react/dist/esm/icons/cloud-off";
import type { HostDisplay } from "../../lib/host-status";
import styles from "./HostIndicator.module.css";

type HostStateIconProps = {
  display: HostDisplay;
  size: number;
};

/**
 * A remote host's glyph: a cloud, crossed out while away, pulsing while a
 * connect runs. Colour comes from the surrounding tone class.
 */
export function HostStateIcon(props: HostStateIconProps) {
  const { display, size } = props;

  const Icon = display.offline && !display.busy ? CloudOff : Cloud;
  return (
    <Icon
      size={size}
      className={`${styles.glyph} ${display.busy ? styles.pulse : ""}`}
      aria-hidden
    />
  );
}
