export function ManorLogo() {
  const s = 8;
  const g = 2;
  const step = s + g;
  const fill = "var(--text-primary)";
  // M on a 7-col x 5-row pixel grid
  const pixels = [
    [0, 0], [6, 0],
    [0, 1], [1, 1], [5, 1], [6, 1],
    [0, 2], [2, 2], [4, 2], [6, 2],
    [0, 3], [3, 3], [6, 3],
    [0, 4], [6, 4],
  ];
  return (
    <svg
      width={7 * s + 6 * g}
      height={5 * s + 4 * g}
      viewBox={`0 0 ${7 * s + 6 * g} ${5 * s + 4 * g}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {pixels.map(([col, row]) => (
        <rect
          key={`${col}-${row}`}
          x={col * step}
          y={row * step}
          width={s}
          height={s}
          fill={fill}
        />
      ))}
    </svg>
  );
}
