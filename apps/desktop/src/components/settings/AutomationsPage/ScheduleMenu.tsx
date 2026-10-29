import { useRef, useState } from "react";
import { Input, Select } from "../../ui/Input";
import {
  clockTime,
  cronFromPreset,
  cronProblem,
  describeCron,
  nextOccurrences,
  presetFromCron,
  timezoneLabel,
  timezoneOptions,
  WEEKDAY_NAMES,
  type SchedulePreset,
  type SchedulePresetKind,
} from "../../../lib/cron-describe";
import { relativeWhen, zoneNote } from "./automation-text";
import { parseMinute } from "./draft";
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
  onChange: (cron: string, timezone: string) => void;
};

/**
 * The schedule chip: the four presets, the time they run at, a custom
 * cron and the zone it is read in, with the next three runs of whatever is
 * picked. A typed cron or minute is kept when the menu is closed with
 * Escape or a click outside, as when its field loses focus.
 */
export function ScheduleMenu(props: ScheduleMenuProps) {
  const { cron, timezone, onChange } = props;
  // What the open menu's typed fields would save; run as it is dismissed.
  const pendingRef = useRef<(() => void) | null>(null);
  return (
    <ChipMenu
      kind="schedule"
      label={describeCron(cron)}
      title="Schedule"
      onDismiss={() => pendingRef.current?.()}
    >
      {() => <ScheduleOptions cron={cron} timezone={timezone} onChange={onChange} pendingRef={pendingRef} />}
    </ChipMenu>
  );
}

function ScheduleOptions(
  props: ScheduleMenuProps & { pendingRef: { current: (() => void) | null } },
) {
  const { cron, timezone, onChange, pendingRef } = props;
  const preset = presetFromCron(cron);
  const [customOpen, setCustomOpen] = useState(preset.kind === "custom");
  const [customText, setCustomText] = useState(cron);
  const [minuteText, setMinuteText] = useState(preset.kind === "hourly" ? String(preset.minute) : "0");
  const customProblem = customOpen ? cronProblem(customText, timezone) : null;
  const minuteProblem =
    !customOpen && preset.kind === "hourly" && parseMinute(minuteText) === null
      ? "A minute from 0 to 59"
      : null;
  const preview = customOpen ? customText : cron;
  const next = customProblem ? [] : nextOccurrences(preview, timezone, 3);
  const note = zoneNote(timezone);

  const pick = (p: SchedulePreset) => {
    setCustomOpen(false);
    const nextCron = cronFromPreset(p);
    setCustomText(nextCron);
    if (p.kind === "hourly") setMinuteText(String(p.minute));
    onChange(nextCron, timezone);
  };

  const setTime = (value: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match || preset.kind === "custom" || preset.kind === "hourly") return;
    pick({ ...preset, hour: Number(match[1]), minute: Number(match[2]) });
  };

  const applyCustom = () => {
    if (cronProblem(customText, timezone)) return;
    const trimmed = customText.trim().replace(/\s+/g, " ");
    if (trimmed !== cron) onChange(trimmed, timezone);
  };

  const applyMinute = () => {
    const minute = parseMinute(minuteText);
    if (minute === null || preset.kind !== "hourly" || minute === preset.minute) return;
    pick({ kind: "hourly", minute });
  };

  pendingRef.current = customOpen ? applyCustom : preset.kind === "hourly" ? applyMinute : null;

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
        <div className={styles.menuStack}>
          <label className={styles.menuField}>
            At minute
            <Input
              type="number"
              min={0}
              max={59}
              className={styles.menuNumber}
              value={minuteText}
              aria-invalid={minuteProblem !== null}
              data-testid="automation-schedule-minute"
              onChange={(e) => setMinuteText(e.target.value)}
              onBlur={applyMinute}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyMinute();
              }}
            />
          </label>
          {minuteProblem && <span className={styles.menuError}>{minuteProblem}</span>}
        </div>
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
      <MenuDivider />
      <label className={styles.menuField}>
        Time zone
        <Select
          value={timezone}
          className={styles.menuZone}
          data-testid="automation-schedule-timezone"
          onChange={(e) => {
            if (e.target.value === timezone) return;
            // A typed cron that holds goes with the zone; one that doesn't stays unsaved.
            const nextCron =
              customOpen && !cronProblem(customText, e.target.value)
                ? customText.trim().replace(/\s+/g, " ")
                : cron;
            onChange(nextCron, e.target.value);
          }}
        >
          {timezoneOptions(timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone === "UTC" ? "UTC" : `${timezoneLabel(zone)} · ${zone}`}
            </option>
          ))}
        </Select>
      </label>
      {next.length > 0 && (
        <div className={styles.menuHint} data-testid="automation-schedule-next">
          Next: {next.map((d) => relativeWhen(d.toISOString(), new Date(), timezone)).join(" · ")}
          {note && ` ${note}`}
        </div>
      )}
    </>
  );
}
