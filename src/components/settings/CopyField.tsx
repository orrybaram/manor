import { useEffect, useState } from "react";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";

import { Button } from "../ui/Button/Button";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * A value that exists to be taken elsewhere — an address, a link, a token.
 *
 * Selectable as text *and* copyable in one click, because the things this
 * shows are long, exact, and usually needed on another device.
 */
export function CopyField(props: {
  value: string;
  /** Named in the button's accessible label: "Copy link". */
  label: string;
  testId?: string;
}) {
  const { value, label, testId } = props;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className={styles.remoteCopyRow}>
      <code data-testid={testId} className={styles.remoteCode}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="sm"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}
