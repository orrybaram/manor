import type { CSSProperties } from "react";
import type {
  CiSignal,
  MergeSignal,
  PrTableRow as PrTableRowData,
  ReviewSignal,
} from "../../../lib/home-dashboard-studio";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { openExternal } from "../../../lib/open-external";
import { PrPopover } from "../PrPopover";
import { formatAge } from "./format";
import { PR_STAGE } from "./pr-stage";
import styles from "./PrTable.module.css";

type Tone = "ok" | "bad" | "run" | "wait" | "off";

/** What one signal cell shows: a glyph or short text, its tone and its spoken meaning. */
type Signal = { text: string; tone: Tone; label: string };

/** Failing check names in the CI cell's label before "and N more". */
const CHECK_NAMES_SHOWN = 3;

function ciCell(ci: CiSignal): Signal {
  switch (ci.kind) {
    case "none":
      return { text: "—", tone: "off", label: "No checks" };
    case "passing":
      return { text: "✓", tone: "ok", label: `${ci.total} of ${ci.total} checks passed` };
    case "running":
      return {
        text: `${ci.done}/${ci.total}`,
        tone: "run",
        label: `Checks running: ${ci.done} of ${ci.total} done`,
      };
    case "failing": {
      const names = ci.names.slice(0, CHECK_NAMES_SHOWN);
      const more = ci.count - names.length;
      const which =
        names.length > 0
          ? `: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
          : "";
      return {
        text: "✕",
        tone: "bad",
        label: `${ci.count} of ${ci.total} checks failing${which}`,
      };
    }
  }
}

function reviewCell(review: ReviewSignal): Signal {
  switch (review.kind) {
    case "draft":
      return { text: "—", tone: "off", label: "Draft: not up for review" };
    case "approved":
      return { text: "✓", tone: "ok", label: "Approved" };
    case "changes-requested":
      return { text: "✕", tone: "bad", label: "Changes requested" };
    case "reviewers":
      return {
        text: `${review.approved}/${review.total}`,
        tone: "wait",
        label: `Waiting on review: ${review.approved} of ${review.total} reviewers approved`,
      };
    case "waiting":
      return { text: "·", tone: "wait", label: "Waiting on review" };
  }
}

function threadsCell(threads: number): Signal {
  return {
    text: String(threads),
    tone: threads > 0 ? "run" : "off",
    label:
      threads === 0
        ? "No unresolved threads"
        : `${threads} unresolved thread${threads === 1 ? "" : "s"}`,
  };
}

const MERGE_CELL: Record<MergeSignal, Signal> = {
  clean: { text: "✓", tone: "ok", label: "No conflicts" },
  conflicts: { text: "✕", tone: "bad", label: "Conflicts with the base branch" },
  queued: { text: "queued", tone: "ok", label: "Queued to merge" },
};

function SignalCell(props: { signal: Signal }) {
  const { text, tone, label } = props.signal;
  return (
    <td>
      <span
        className={`${styles.sig} ${styles[tone]}`}
        role="img"
        title={label}
        aria-label={label}
      >
        {text}
      </span>
    </td>
  );
}

/**
 * The Size cell: a green/red bar split by lines added and removed, its
 * width growing with the square root of the total so a 2,000-line PR reads
 * bigger than a 50-line one without dwarfing it.
 */
function SizeCell(props: { size: PrTableRowData["size"] }) {
  const { size } = props;
  if (!size) {
    return <SignalCell signal={{ text: "—", tone: "off", label: "Size unknown" }} />;
  }
  const { additions, deletions } = size;
  const total = additions + deletions;
  const width = Math.min(64, Math.max(6, Math.round(Math.sqrt(total) * 1.6)));
  const label = `+${additions} −${deletions}`;
  return (
    <td>
      <span
        className={styles.size}
        style={{ width } as CSSProperties}
        role="img"
        title={label}
        aria-label={`${additions} lines added, ${deletions} removed`}
      >
        {additions > 0 && <i className={styles.added} style={{ flexGrow: additions }} />}
        {deletions > 0 && <i className={styles.removed} style={{ flexGrow: deletions }} />}
      </span>
    </td>
  );
}

type PrTableRowProps = {
  row: PrTableRowData;
  onOpen: () => void;
};

/**
 * One open PR. Clicking anywhere on the row (or activating its title)
 * opens the workspace; hovering it shows the same PR popover as the
 * sidebar badge.
 */
export function PrTableRow(props: PrTableRowProps) {
  const { row, onOpen } = props;
  const { pr, project, workspace } = row;

  return (
    <PrPopover
      pr={pr}
      workspacePath={workspace.path}
      hostId={project.hostId}
      onOpen={() => openExternal(pr.url)}
      side="bottom"
      anchorTag="tr"
      anchorClassName={`${styles.row} ${pr.isDraft ? styles.draft : ""}`}
      onAnchorClick={onOpen}
    >
      <td
        className={styles.prCell}
        style={{ "--c": PR_STAGE[row.stage].color } as CSSProperties}
      >
        <span className={styles.prLine}>
          {/* The row's click handler opens the workspace; this button is its keyboard stop. */}
          <button
            type="button"
            className={styles.prTitle}
            title={pr.title}
            aria-label={`#${pr.number} ${pr.title}, ${PR_STAGE[row.stage].label}${pr.isDraft ? ", draft" : ""}. Open workspace`}
          >
            <span className={styles.num}>#{pr.number}</span> {pr.title}
          </button>
          {pr.isDraft && <span className={styles.draftTag}>draft</span>}
          <span className={styles.proj} style={projectColorStyle(project.color)}>
            {project.name}
          </span>
        </span>
      </td>
      <SizeCell size={row.size} />
      <SignalCell signal={ciCell(row.ci)} />
      <SignalCell signal={reviewCell(row.review)} />
      <SignalCell signal={threadsCell(row.threads)} />
      <SignalCell signal={MERGE_CELL[row.merge]} />
      <td
        className={`${styles.age} ${row.stale ? styles.stale : ""}`}
        title={row.stale ? "No activity for a day or more" : undefined}
      >
        {row.ageMs != null ? formatAge(row.ageMs) : "—"}
      </td>
    </PrPopover>
  );
}
