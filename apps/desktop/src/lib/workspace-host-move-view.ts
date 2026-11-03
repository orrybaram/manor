/**
 * The words and lane state of the Move to Host dialog, DOM-free: what each
 * step is called, what each refusal says, and how far the lane has come.
 */

import type {
  WorkspaceMoveRefusal,
  WorkspaceMoveStep,
  WorkspaceMoveStepId,
} from "../electron";

/** An agent step's detail ("claude", "2 codex agents") with each kind as it is named. */
function agentsLabel(detail: string | undefined): string {
  if (!detail) return "agents";
  return detail.replace(/\bclaude\b/g, "Claude").replace(/\bcodex\b/g, "Codex");
}

/** What the lane says while `step` runs. */
export function stepLabel(step: WorkspaceMoveStep, target: string, source: string): string {
  switch (step.id) {
    case "push":
      return "Pushing branch";
    case "setUp":
      return `Setting up on ${target}`;
    case "create":
      return "Creating workspace";
    case "setupScript":
      return "Running start script";
    case "restore":
      return "Restoring tabs";
    case "agents":
      return `Starting ${agentsLabel(step.detail)}`;
    case "removeSource":
      return `Removing from ${source}`;
  }
}

/**
 * One plain sentence for a refusal. `dirty` has its own block with the
 * files, so it has none here.
 */
export function refusalSentence(
  refusal: WorkspaceMoveRefusal,
  target: string,
  source: string,
): string | null {
  const sentence = refusalText(refusal, target, source);
  return sentence && sentenceCase(sentence);
}

/**
 * A sentence that opens with "this machine" (`hostSentenceName`) starts
 * with a capital. A remote host's name is left as it is written: "devbox".
 */
export function sentenceCase(text: string): string {
  return text.startsWith("this machine") ? `T${text.slice(1)}` : text;
}

function refusalText(
  refusal: WorkspaceMoveRefusal,
  target: string,
  source: string,
): string | null {
  switch (refusal.code) {
    case "dirty":
      return null;
    case "no-origin":
      return "This repository has no origin remote to push the branch to.";
    case "main-workspace":
      return "The main workspace can't be moved.";
    case "same-host":
      return `This workspace is already on ${target}.`;
    case "detached":
      return `This workspace isn't on a branch. Check out a branch on ${source} first.`;
    case "target-dirty":
      return `${target} already has this branch checked out, with uncommitted changes.`;
    case "target-cannot-fast-forward":
      return `${target} already has this branch checked out, with commits this one doesn't have.`;
    case "target-main-on-branch":
      return `${target}'s main checkout is on this branch. Switch it to another branch first.`;
  }
}

/** "Commit or discard N changed files first." */
export function dirtySentence(count: number): string {
  return `Commit or discard ${count} changed ${count === 1 ? "file" : "files"} first.`;
}

/** Steps that run on the source, which are not "on <target>". */
const SOURCE_STEPS: ReadonlySet<WorkspaceMoveStepId> = new Set(["push", "removeSource"]);

/**
 * The failed dialog's body. A step that already names the target ("Setting
 * up on devbox") isn't named twice, and one that runs on the source (the
 * push) isn't put on the target; a failure with no step is the move's.
 */
export function failureBody(
  step: WorkspaceMoveStepId | null,
  steps: readonly WorkspaceMoveStep[],
  target: string,
  source: string,
): string {
  if (step === "removeSource") {
    return `The workspace is ready on ${target}, but removing it from ${source} failed.`;
  }
  let where = `Moving to ${target}`;
  if (step) {
    const label = stepLabel(steps.find((s) => s.id === step) ?? { id: step }, target, source);
    where =
      SOURCE_STEPS.has(step) || label.endsWith(` on ${target}`) ? label : `${label} on ${target}`;
  }
  return `${where} failed. Nothing changed on ${source}.`;
}

/** Where a move has got to, from its progress events. */
export interface LaneProgress {
  steps: WorkspaceMoveStep[];
  /** The step running or last run; -1 before the first. */
  index: number;
  /** Whether `index` has finished. */
  indexDone: boolean;
  /** Whether `index` was skipped: planned, but it didn't apply. */
  indexSkipped: boolean;
  succeeded: boolean;
}

export const LANE_START: LaneProgress = {
  steps: [],
  index: -1,
  indexDone: false,
  indexSkipped: false,
  succeeded: false,
};

/** One `projects.moveWorkspaceToHostProgress` frame, without its move id. */
export type LaneEvent =
  | { type: "plan"; steps: WorkspaceMoveStep[] }
  | {
      type: "step";
      index: number;
      status: "running" | "done" | "skipped" | "failed";
    };

export function advanceLane(lane: LaneProgress, event: LaneEvent): LaneProgress {
  if (event.type === "plan") return { ...LANE_START, steps: event.steps };
  // Frames can only move the lane forward.
  if (event.index < lane.index) return lane;
  return {
    ...lane,
    index: event.index,
    indexDone: event.status === "done" || event.status === "skipped",
    indexSkipped: event.status === "skipped",
  };
}

/** What the lane draws for `lane`. */
export interface LaneView {
  /** How much of the track is filled, 0 to 1: one segment per step. */
  fill: number;
  /** The step the label names, or null before the plan or after success. */
  current: WorkspaceMoveStep | null;
  /** "k of N", or null when there is nothing to count. */
  count: string | null;
  /** The target glyph is lit from the create step on. */
  targetLit: boolean;
  /** The source glyph dims while it is removed. */
  sourceDim: boolean;
}

export function laneView(lane: LaneProgress): LaneView {
  const n = lane.steps.length;
  if (lane.succeeded) {
    return {
      fill: 1,
      current: null,
      count: null,
      targetLit: true,
      sourceDim: lane.steps.some((s) => s.id === "removeSource"),
    };
  }
  if (n === 0 || lane.index < 0) {
    return { fill: 0, current: null, count: null, targetLit: false, sourceDim: false };
  }
  const index = Math.min(lane.index, n - 1);
  // A skipped step is never named: the label moves on to the next one,
  // though the count stays where the events have got to.
  const current = lane.steps[lane.indexSkipped && index + 1 < n ? index + 1 : index];
  const createAt = lane.steps.findIndex((s) => s.id === "create");
  return {
    fill: (index + (lane.indexDone ? 1 : 0)) / n,
    current,
    count: `${index + 1} of ${n}`,
    targetLit: createAt >= 0 && index >= createAt,
    sourceDim: current.id === "removeSource",
  };
}
