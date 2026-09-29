import styles from "./StatTiles.module.css";

/** viewBox size; the SVG stretches to the tile's width (`preserveAspectRatio="none"`). */
const W = 200;
const H = 38;

type SparklineProps = {
  values: readonly number[];
  /** CSS colour for the line, area and bars. */
  color: string;
  /** One bar per value instead of a line; the last bar is emphasised. */
  bars?: boolean;
};

/**
 * A stat tile's chart (ADR-198 §1.3): hand-written SVG, no chart library.
 * Drawn to scale from zero, so a flat run of zeros sits on the baseline.
 * Nothing renders for fewer than two points — one sample isn't a trend.
 */
export function Sparkline(props: SparklineProps) {
  const { values, color, bars = false } = props;

  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const n = values.length;

  if (bars) {
    const bw = W / n;
    return (
      <svg className={styles.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {values.map((v, i) => {
          const h = (v / max) * (H - 2);
          return (
            <rect
              key={i}
              x={i * bw + 2}
              y={H - h}
              width={Math.max(0, bw - 4)}
              height={h}
              rx={2}
              fill={color}
              opacity={i === n - 1 ? 1 : 0.45}
            />
          );
        })}
      </svg>
    );
  }

  const points = values.map((v, i) => [(i * W) / (n - 1), H - 3 - (v / max) * (H - 8)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [lx, ly] = points[points.length - 1];

  return (
    <svg className={styles.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={color} opacity={0.13} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r={3} fill={color} />
    </svg>
  );
}
