import type { ReactNode } from "react";
import styles from "./ToggleGroup.module.css";

type ToggleOption<T extends string> = {
  value: T;
  label: ReactNode;
};

type ToggleGroupProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: ToggleOption<T>[];
  size?: "sm" | "md" | "lg";
};

export function ToggleGroup<T extends string>(props: ToggleGroupProps<T>) {
  const { value, onChange, options, size = "md" } = props;
  return (
    <div className={`${styles.toggleGroup} ${styles[size]}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`${styles.toggleButton} ${value === opt.value ? styles.active : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
