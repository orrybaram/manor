import React from "react";
import styles from "./Link.module.css";

type LinkVariant = "inline" | "plain";

type LinkProps = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target"
> & {
  /** http(s) only — Electron's window-open handler ignores other schemes. */
  href: string;
  variant?: LinkVariant;
};

/**
 * `attachWindowOpenHandler` in `electron/window.ts` routes any
 * `target="_blank"` navigation with an http(s) URL to `shell.openExternal`
 * and denies the in-app popup, so a plain anchor with `target="_blank"`
 * opens in the default browser with no renderer-side click handling needed.
 */
export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  function Link(props, ref) {
    const { href, variant = "inline", className, ...rest } = props;

    const classNames = [styles.link, styles[variant], className]
      .filter(Boolean)
      .join(" ");

    return (
      <a
        ref={ref}
        href={href}
        className={classNames}
        {...rest}
        target="_blank"
        rel="noreferrer"
      />
    );
  }
);
