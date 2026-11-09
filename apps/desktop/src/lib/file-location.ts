/**
 * Where a file pane's file is. A pane's `filePath` is relative to its
 * workspace, or absolute for a file anywhere else on the workspace's host.
 * An absolute one is read and written with `/` as its root, so the `files.*`
 * calls and their checks are the same either way; only a workspace file has
 * changes to show.
 */

const FILESYSTEM_ROOT = "/";

/** Whether `filePath` is outside the pane's workspace. */
export function isOutsideWorkspace(filePath: string): boolean {
  return filePath.startsWith("/");
}

/** `filePath` relative to the root it is read from. */
export function pathInFileRoot(filePath: string): string {
  return isOutsideWorkspace(filePath) ? filePath.replace(/^\/+/, "") : filePath;
}

/** The root `filePath` is read from: the workspace, or `/`. */
export function fileRoot<W extends { path: string }>(workspace: W, filePath: string): W {
  return isOutsideWorkspace(filePath) ? { ...workspace, path: FILESYSTEM_ROOT } : workspace;
}

/**
 * What a pane in `workspacePath` holds for the absolute path `absolute`:
 * relative when it is in the workspace, which gives it the tree and its
 * changes, else `absolute` itself, tidied.
 */
export function filePathFor(workspacePath: string, absolute: string): string {
  const tidy = tidyAbsolute(absolute);
  const root = tidyAbsolute(workspacePath);
  const prefix = root === "/" ? root : `${root}/`;
  return tidy.startsWith(prefix) && tidy.length > prefix.length ? tidy.slice(prefix.length) : tidy;
}

/** `/a//b/./c/../d` as `/a/b/d`, with no filesystem to ask. */
export function tidyAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
