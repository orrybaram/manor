import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import CircleDotDashed from "lucide-react/dist/esm/icons/circle-dot-dashed";
import type { DiffMode } from "../types";
import { ToggleGroup } from "../../../ui/ToggleGroup";

type ModeToggleProps = {
  diffMode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
};

export function ModeToggle(props: ModeToggleProps) {
  const { diffMode, onModeChange } = props;
  return (
    <ToggleGroup
      value={diffMode}
      onChange={onModeChange}
      options={[
        {
          value: "local" as DiffMode,
          label: (
            <>
              <CircleDotDashed size={12} />
              Uncommitted
            </>
          ),
        },
        {
          value: "branch" as DiffMode,
          label: (
            <>
              <GitBranch size={12} />
              Branch
            </>
          ),
        },
      ]}
    />
  );
}
