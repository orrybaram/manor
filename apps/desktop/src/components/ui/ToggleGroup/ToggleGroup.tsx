import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Tooltip } from "../Tooltip/Tooltip";
import { toggleKeyAction } from "./toggle-keys";
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
  size?: "xs" | "sm" | "md" | "lg";
  /** The group's accessible name. Give this or `aria-labelledby`. */
  "aria-label"?: string;
  /** Id of the element that names the group. Give this or `aria-label`. */
  "aria-labelledby"?: string;
  /**
   * `automatic` (the default): arrow keys move to an option and choose it.
   * `manual`: arrow keys only move focus, and Enter or Space chooses. Use
   * it where choosing is costly, e.g. it refetches or clears a selection.
   */
  activationMode?: "automatic" | "manual";
  "data-testid"?: string;
};

/**
 * One choice among a few options, as a radio group. It has a single tab
 * stop (the chosen option). Arrow keys, Home and End move between options,
 * skipping disabled ones, and choose them too unless `activationMode` is
 * `manual`.
 */
export function ToggleGroup<T extends string>(props: ToggleGroupProps<T>) {
  const {
    value,
    onChange,
    options,
    size = "md",
    "aria-label": label,
    "aria-labelledby": labelledBy,
    activationMode = "automatic",
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
    // In manual mode focus can sit on an unchosen option; step from there.
    const focused = enabled.find((o) => buttons.current.get(o.value) === e.target)?.value;
    const action = toggleKeyAction(
      e.key,
      enabled.map((o) => o.value),
      focused ?? tabStop,
      activationMode,
    );
    if (!action) return;
    e.preventDefault();
    if (action.choose) choose(action.focus);
    else buttons.current.get(action.focus)?.focus();
  };

  return (
    <div
      className={`${styles.toggleGroup} ${styles[size]}`}
      role="radiogroup"
      aria-label={label}
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
