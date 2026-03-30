import { useEffect, useRef, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import X from "lucide-react/dist/esm/icons/x";
import styles from "./SearchBar.module.css";
import { Input } from "../../../ui/Input";

export function SearchBar({
  query,
  onChange,
  totalMatches,
  currentMatch,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onChange: (q: string) => void;
  totalMatches: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Trigger open animation on next frame so the transition fires
    requestAnimationFrame(() => {
      setOpen(true);
      inputRef.current?.focus();
    });
  }, []);

  const handleClose = () => {
    setOpen(false);
  };

  const handleTransitionEnd = () => {
    if (!open) onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  return (
    <div
      className={styles.wrapper}
      data-open={open || undefined}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className={styles.inner}>
        <div className={styles.searchBar}>
          <Input
            placeholder="Find..."
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            variant="ghost"
          />
          <span className={styles.searchCount}>
            {query
              ? `${totalMatches > 0 ? currentMatch + 1 : 0} of ${totalMatches}`
              : ""}
          </span>
          <button
            className={styles.searchBtn}
            onClick={onPrev}
            disabled={totalMatches === 0}
            aria-label="Previous match"
          >
            <ChevronUp size={14} />
          </button>
          <button
            className={styles.searchBtn}
            onClick={onNext}
            disabled={totalMatches === 0}
            aria-label="Next match"
          >
            <ChevronDown size={14} />
          </button>
          <button
            className={styles.searchBtn}
            onClick={handleClose}
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
