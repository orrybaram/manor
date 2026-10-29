const WINDOWS_PATH = /^(?:[a-zA-Z]:(?:[\\/]|$)|\\\\)/;

/** Whether a path is a Windows one (drive letter or UNC). */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path);
}

/**
 * A path in the form paths are compared in: no trailing separator; a Windows
 * path (drive letter or UNC) with forward slashes and lower-cased, since
 * Windows paths ignore case. POSIX paths stay exact.
 */
export function normalizePath(raw: string): string {
  const path = raw.trim();
  if (isWindowsPath(path)) return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return path.replace(/\/+$/, "");
}

/** Whether normalized `path` is `base` or inside it. */
export function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}
