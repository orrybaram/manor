import type { BlameCommit, FileBlame } from "./types";

/** `<sha> <line in the commit> <line in the file> [<lines in this group>]` */
const HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/;

/**
 * What `git blame --porcelain` says about a file. Each line is a header naming
 * its commit, the commit's details the first time it appears, and the line's
 * own text after a tab, which is never read: it could look like anything.
 */
export function parseBlamePorcelain(output: string): FileBlame {
  const commits: BlameCommit[] = [];
  const indexBySha = new Map<string, number>();
  const lines: number[] = [];
  let current: BlameCommit | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("\t")) continue;
    const header = HEADER.exec(line);
    if (header) {
      const sha = header[1];
      let index = indexBySha.get(sha);
      if (index === undefined) {
        index = commits.length;
        indexBySha.set(sha, index);
        commits.push({ sha, author: "", time: 0, summary: "", message: "" });
      }
      current = commits[index];
      lines[Number(header[2]) - 1] = index;
    } else if (current) {
      if (line.startsWith("author ")) current.author = line.slice(7);
      else if (line.startsWith("author-time ")) current.time = Number(line.slice(12));
      else if (line.startsWith("summary ")) current.summary = line.slice(8);
    }
  }
  return { commits, lines };
}

/** Sha and full message from `git log --format=%H%x00%B%x00`. */
export function parseCommitMessages(output: string): [sha: string, message: string][] {
  const fields = output.split("\0");
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push([fields[i].trim(), fields[i + 1].trim()]);
  }
  return out;
}
