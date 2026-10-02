/** The markdown images (`![alt](url)`) embedded in a task body, in order. */
export function extractImages(
  text: string,
): Array<{ alt: string; url: string }> {
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images: Array<{ alt: string; url: string }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    images.push({ alt: match[1], url: match[2] });
  }
  return images;
}

/** A task body as plain text: images dropped, links / emphasis / code / headings / list markers unwrapped. */
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
