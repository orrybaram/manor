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
