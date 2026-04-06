export const PRIORITY_LABELS: Record<number, { label: string; color: string }> =
  {
    0: { label: "None", color: "var(--text-dim)" },
    1: { label: "Urgent", color: "#f76a6a" },
    2: { label: "High", color: "#f0913a" },
    3: { label: "Medium", color: "#f0c73a" },
    4: { label: "Low", color: "#8da4ef" },
  };

const isSubsequence = (hay: string, needle: string): boolean => {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++;
  }
  return j === needle.length;
};

export const wordPrefixFilter = (value: string, search: string) => {
  const val = value.toLowerCase();
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  const words = val.split(/\s+/);

  let score = 0;
  for (const t of terms) {
    if (words.some((w) => w === t)) {
      score += 1;
    } else if (words.some((w) => w.startsWith(t))) {
      score += 0.8;
    } else if (words.some((w) => w.includes(t))) {
      score += 0.6;
    } else if (isSubsequence(val, t)) {
      score += 0.4;
    } else {
      return 0;
    }
  }

  return score / terms.length;
};

export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) =>
      m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1"),
    ) // links
    .replace(/#{1,6}\s+/g, "") // headings
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`+/g, "")) // code
    .replace(/^\s*[-*+]\s+/gm, "") // list markers
    .replace(/^\s*\d+\.\s+/gm, "") // numbered lists
    .replace(/^\s*>/gm, "") // blockquotes
    .replace(/---+|===+/g, "") // horizontal rules
    .replace(/\n{3,}/g, "\n\n") // excessive newlines
    .trim();
}
