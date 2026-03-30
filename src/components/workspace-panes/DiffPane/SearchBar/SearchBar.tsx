import { useEffect, useRef } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import X from "lucide-react/dist/esm/icons/x";
import styles from "./SearchBar.module.css";

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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  return (
    <div className={styles.searchBar}>
      <input
        ref={inputRef}
        className={styles.searchInput}
        type="text"
        placeholder="Find..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.searchCount}>
        {query ? `${totalMatches > 0 ? currentMatch + 1 : 0} of ${totalMatches}` : ""}
      </span>
      <button className={styles.searchBtn} onClick={onPrev} disabled={totalMatches === 0} aria-label="Previous match">
        <ChevronUp size={14} />
      </button>
      <button className={styles.searchBtn} onClick={onNext} disabled={totalMatches === 0} aria-label="Next match">
        <ChevronDown size={14} />
      </button>
      <button className={styles.searchBtn} onClick={onClose} aria-label="Close search">
        <X size={14} />
      </button>
    </div>
  );
}
