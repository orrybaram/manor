import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Tooltip } from "../Tooltip/Tooltip";
import styles from "./ToggleGroup.module.css";

type ToggleOption<T extends string> = {
  value: T;
  label: ReactNode;
  /**
   * When set, the option is shown but can't be chosen. The reason is its
   * tooltip, and also its accessible description, which is always present.
   */
  disabledReason?: string;
};

type ToggleGroupProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: ToggleOption<T>[];
  size?: "sm" | "md" | "lg";
  /** Id of the element that names the group. */
  "aria-labelledby"?: string;
  "data-testid"?: string;
};

const STEP_KEYS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * One choice among a few options, as a radio group. It has a single tab
 * stop (the chosen option). Arrow keys, Home and End move and choose, and
 * skip disabled options.
 */
export function ToggleGroup<T extends string>(props: ToggleGroupProps<T>) {
  const {
    value,
    onChange,
    options,
    size = "md",
    "aria-labelledby": labelledBy,
    "data-testid": testId,
  } = props;

  const reasonIdPrefix = useId();
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const enabled = options.filter((o) => !o.disabledReason);
  const tabStop = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;

  const choose = (next: T) => {
    buttons.current.get(next)?.focus();
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const at = Math.max(0, enabled.findIndex((o) => o.value === tabStop));
    let target: number | null = null;
    if (e.key === "Home") target = 0;
    else if (e.key === "End") target = enabled.length - 1;
    else if (e.key in STEP_KEYS) {
      target = (at + STEP_KEYS[e.key] + enabled.length) % enabled.length;
    }
    if (target === null) return;
    e.preventDefault();
    choose(enabled[target].value);
  };

  return (
    <div
      className={`${styles.toggleGroup} ${styles[size]}`}
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {options.map((opt, index) => {
        const reason = opt.disabledReason;
        const reasonId = reason ? `${reasonIdPrefix}-reason-${index}` : undefined;
        const button = (
          <button
            ref={(el) => {
              if (el) buttons.current.set(opt.value, el);
              else buttons.current.delete(opt.value);
            }}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            // aria-disabled, not disabled, so the tooltip still opens on hover.
            aria-disabled={reason ? true : undefined}
            aria-describedby={reasonId}
            tabIndex={opt.value === tabStop ? 0 : -1}
            data-value={opt.value}
            className={`${styles.toggleButton} ${value === opt.value ? styles.active : ""}`}
            onClick={() => {
              if (!reason) choose(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
        if (!reason) return <Fragment key={opt.value}>{button}</Fragment>;
        return (
          <Fragment key={opt.value}>
            <Tooltip label={reason} side="top">
              {button}
            </Tooltip>
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
