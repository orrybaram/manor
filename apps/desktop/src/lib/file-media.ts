/**
 * Which files a file pane shows rather than edits, by name alone: the pane
 * knows before it reads. An SVG is text, and opens in the editor like any other.
 */

export type FileMedia = { kind: "image"; mimeType: string } | { kind: "pdf" };

const IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ["apng", "image/apng"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export function fileMedia(path: string): FileMedia | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (extension === "pdf") return { kind: "pdf" };
  const mimeType = IMAGE_TYPES.get(extension);
  return mimeType ? { kind: "image", mimeType } : null;
}
