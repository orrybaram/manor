import { useRef, useState } from "react";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./CopySshCommand.module.css";

const COPIED_MS = 1600;

type CopySshCommandProps = {
  target: string;
};

/** Copies `ssh <target>`, the quickest way to see what ssh itself says. */
export function CopySshCommand(props: CopySshCommandProps) {
  const { target } = props;

  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const command = `ssh ${target}`;

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Tooltip label={command} side="top">
      <Button
        size="sm"
        variant="ghost"
        aria-label={copied ? "ssh command copied" : `Copy ${command}`}
        onClick={copy}
      >
        {copied ? (
          <Check size={11} aria-hidden className={styles.buttonIcon} />
        ) : (
          <Copy size={11} aria-hidden className={styles.buttonIcon} />
        )}
        {copied ? "Copied" : "Copy ssh command"}
      </Button>
    </Tooltip>
  );
}
