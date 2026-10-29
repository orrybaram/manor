import { useState } from "react";
import { Input, Select } from "../../ui/Input";
import {
  clockTime,
  cronFromPreset,
  cronProblem,
  describeCron,
  nextOccurrences,
  presetFromCron,
  WEEKDAY_NAMES,
  type SchedulePreset,
  type SchedulePresetKind,
} from "../../../lib/cron-describe";
import { relativeWhen } from "./automation-text";
import { ChipMenu, MenuDivider, MenuItem } from "./ChipMenu";
import styles from "./AutomationsPage.module.css";

const PRESETS: { kind: Exclude<SchedulePresetKind, "custom">; label: string }[] = [
  { kind: "hourly", label: "Hourly" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
];

/** The hour and minute a preset runs at, carried over when switching. */
function timeOf(preset: SchedulePreset): { hour: number; minute: number } {
  if (preset.kind === "custom") return { hour: 9, minute: 0 };
  if (preset.kind === "hourly") return { hour: 9, minute: preset.minute };
  return { hour: preset.hour, minute: preset.minute };
}

function switchTo(kind: Exclude<SchedulePresetKind, "custom">, from: SchedulePreset): SchedulePreset {
  const { hour, minute } = timeOf(from);
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, day: from.kind === "weekly" ? from.day : 1, hour, minute };
  }
}

type ScheduleMenuProps = {
  cron: string;
  timezone: string;
  onChange: (cron: string) => void;
};

/**
 * The schedule chip: the four presets, the time they run at, and a custom
 * cron, with the next three runs of whatever is picked.
 */
export function ScheduleMenu(props: ScheduleMenuProps) {
  const { cron, timezone, onChange } = props;
  return (
    <ChipMenu kind="schedule" label={describeCron(cron)} title="Schedule">
      {() => <ScheduleOptions cron={cron} timezone={timezone} onChange={onChange} />}
    </ChipMenu>
  );
}

function ScheduleOptions(props: ScheduleMenuProps) {
  const { cron, timezone, onChange } = props;
  const preset = presetFromCron(cron);
  const [customOpen, setCustomOpen] = useState(preset.kind === "custom");
  const [customText, setCustomText] = useState(cron);
  const customProblem = customOpen ? cronProblem(customText, timezone) : null;
  const preview = customOpen ? customText : cron;
  const next = customProblem ? [] : nextOccurrences(preview, timezone, 3);

  const pick = (p: SchedulePreset) => {
    setCustomOpen(false);
    const nextCron = cronFromPreset(p);
    setCustomText(nextCron);
    onChange(nextCron);
  };

  const setTime = (value: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match || preset.kind === "custom" || preset.kind === "hourly") return;
    pick({ ...preset, hour: Number(match[1]), minute: Number(match[2]) });
  };

  const applyCustom = () => {
    if (cronProblem(customText, timezone)) return;
    const trimmed = customText.trim().replace(/\s+/g, " ");
    if (trimmed !== cron) onChange(trimmed);
  };

  return (
    <>
      {PRESETS.map((p) => (
        <MenuItem
          key={p.kind}
          selected={!customOpen && preset.kind === p.kind}
          testId={`automation-schedule-${p.kind}`}
          onSelect={() => pick(switchTo(p.kind, preset))}
        >
          {p.label}
        </MenuItem>
      ))}
      {!customOpen && preset.kind === "hourly" && (
        <label className={styles.menuField}>
          At minute
          <Input
            type="number"
            min={0}
            max={59}
            className={styles.menuNumber}
            value={preset.minute}
            data-testid="automation-schedule-minute"
            onChange={(e) => {
              const minute = Number(e.target.value);
              if (Number.isInteger(minute) && minute >= 0 && minute <= 59) {
                pick({ kind: "hourly", minute });
              }
            }}
          />
        </label>
      )}
      {!customOpen && preset.kind !== "hourly" && preset.kind !== "custom" && (
        <label className={styles.menuField}>
          At
          <Input
            type="time"
            className={styles.menuTime}
            value={clockTime(preset.hour, preset.minute)}
            data-testid="automation-schedule-time"
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
      )}
      {!customOpen && preset.kind === "weekly" && (
        <label className={styles.menuField}>
          On
          <Select
            value={String(preset.day)}
            data-testid="automation-schedule-day"
            onChange={(e) => pick({ ...preset, day: Number(e.target.value) })}
          >
            {WEEKDAY_NAMES.map((name, day) => (
              <option key={name} value={day}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <MenuDivider />
      <MenuItem
        selected={customOpen}
        testId="automation-schedule-custom"
        onSelect={() => setCustomOpen(true)}
      >
        Custom cron…
      </MenuItem>
      {customOpen && (
        <div className={styles.menuCronField}>
          <Input
            monospace
            className={styles.menuCron}
            value={customText}
            placeholder="0 9 * * 1-5"
            aria-label="Cron pattern"
            data-testid="automation-schedule-cron"
            aria-invalid={customProblem !== null}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCustom();
            }}
          />
          {customProblem && <span className={styles.menuError}>{customProblem}</span>}
        </div>
      )}
      {next.length > 0 && (
        <div className={styles.menuHint}>Next: {next.map((d) => relativeWhen(d.toISOString())).join(" · ")}</div>
      )}
    </>
  );
}
