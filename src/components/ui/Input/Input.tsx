import React, { type ComponentPropsWithoutRef } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./Input.module.css";

type InputProps = {
  variant?: "default" | "ghost";
  monospace?: boolean;
} & ComponentPropsWithoutRef<"input">;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (props, ref) => {
    const { variant, monospace, className, ...rest } = props;

    const classes = [
      styles.input,
      variant === "ghost" ? styles.ghost : null,
      monospace ? styles.monospace : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return <input ref={ref} className={classes} {...rest} />;
  }
);

Input.displayName = "Input";

type TextareaProps = {
  monospace?: boolean;
} & ComponentPropsWithoutRef<"textarea">;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (props, ref) => {
    const { monospace, className, ...rest } = props;

    const classes = [
      styles.input,
      styles.textarea,
      monospace ? styles.monospace : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return <textarea ref={ref} className={classes} {...rest} />;
  }
);

Textarea.displayName = "Textarea";

type SelectProps = ComponentPropsWithoutRef<"select">;

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (props, ref) => {
    const { className, ...rest } = props;

    const classes = [styles.select, className].filter(Boolean).join(" ");

    return (
      <div className={styles.selectWrapper}>
        <select ref={ref} className={classes} {...rest} />
        <span className={styles.selectIcon}>
          <ChevronDown size={14} />
        </span>
      </div>
    );
  }
);

Select.displayName = "Select";
