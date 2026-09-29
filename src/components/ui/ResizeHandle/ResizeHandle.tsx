import type { HTMLAttributes } from "react";
import styles from "./ResizeHandle.module.css";

type ResizeHandleProps = HTMLAttributes<HTMLDivElement> & {
  /**
   * Which way the edge runs: `horizontal` resizes up and down (a line across),
   * `vertical` resizes left and right (a line down).
   */
  orientation: "horizontal" | "vertical";
  /** Keeps the glow lit, e.g. for the whole of a drag. */
  active?: boolean;
};

/**
 * A drag handle for a resizable edge. The caller positions it (absolute, via
 * `className`) and sizes its grab area. On hover or while `active`, it draws
 * a thin accent line with a soft glow that fades out towards both ends.
 *
 * The line is centred in the grab area by default. Set `--resize-line` on the
 * handle to move it, as a `left` (vertical) or `top` (horizontal) offset.
 */
export function ResizeHandle(props: ResizeHandleProps) {
  const { orientation, active = false, className, ...rest } = props;
  return (
    <div
      {...rest}
      className={`${styles.handle} ${styles[orientation]} ${active ? styles.active : ""} ${className ?? ""}`}
    />
  );
}
