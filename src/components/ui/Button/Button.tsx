import React from "react";
import styles from "./Button.module.css";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
type ButtonSize = "sm" | "md";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const { variant = "secondary", size = "md", className, ...rest } = props;

    const classNames = [
      styles.button,
      styles[variant],
      variant !== "link" ? styles[size] : undefined,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return <button ref={ref} className={classNames} {...rest} />;
  }
);
