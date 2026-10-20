export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let count = 0;
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    count++;
    pos = lower.indexOf(qLower, pos + qLower.length);
  }
  return count;
}
