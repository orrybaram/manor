import type { DiffFile } from "./types";

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git")) {
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
      current = { path: match?.[1] ?? "unknown", lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("Binary files")) {
      current.lines.push({ type: "context", content: line });
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      current.lines.push({ type: "hunk", content: `@@ -${hunkMatch[1]} +${hunkMatch[2]} @@${hunkMatch[3]}` });
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), newNum });
      current.added++;
      newNum++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum });
      current.removed++;
      oldNum++;
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push({ type: "context", content: line.slice(1), oldNum, newNum });
      oldNum++;
      newNum++;
    }
  }

  return files;
}
