import type { ComponentType } from "react";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import { GitHubIcon } from "../command-palette/GitHubIcon";
import { LinearIcon } from "../command-palette/LinearIcon";
import type { TaskProvider } from "../../lib/tasks";

/** Each tracker's logo — the Tasks view's tracker tabs. */
const TRACKER_ICON: Record<TaskProvider, ComponentType<{ size: number }>> = {
  github: GitHubIcon,
  linear: LinearIcon,
};

/** The glyph before a row's ID, and its size. */
const TRACKER_ROW_ICON: Record<
  TaskProvider,
  { Icon: ComponentType<{ size: number }>; size: number }
> = {
  github: { Icon: CircleDot, size: 11 },
  linear: { Icon: LinearIcon, size: 10 },
};

type TrackerIconProps = {
  provider: TaskProvider;
  size: number;
};

/** A tracker's logo. */
export function TrackerIcon(props: TrackerIconProps) {
  const { provider, size } = props;

  const Icon = TRACKER_ICON[provider];
  return <Icon size={size} />;
}

/** The small tracker glyph in a task row's ID chip. */
export function TrackerRowIcon(props: { provider: TaskProvider }) {
  const { provider } = props;

  const { Icon, size } = TRACKER_ROW_ICON[provider];
  return <Icon size={size} />;
}
