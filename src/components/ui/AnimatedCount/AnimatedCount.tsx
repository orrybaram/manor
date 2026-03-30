import { useEffect, useRef, useState } from "react";

const DURATION = 300;

export function AnimatedCount({
  value,
  prefix,
  className,
}: {
  value: number;
  prefix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const prevValue = useRef(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = prevValue.current;
    const to = value;
    prevValue.current = value;

    if (from === to) return;

    const start = performance.now();
    const delta = to - from;

    const tick = (now: number) => {
      const t = Math.min((now - start) / DURATION, 1);
      // ease-out quad
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(Math.round(from + delta * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  return (
    <span className={className}>
      {prefix}
      {display}
    </span>
  );
}
