/**
 * Reading an agent's SQLite database without writing a byte beside it.
 *
 * A plain read-only open of a WAL database is not enough: when the agent
 * isn't running, its `-wal` and `-shm` are gone, and SQLite makes them
 * afresh next to the database to read it. So how a database is opened
 * depends on what is beside it:
 * - neither `-wal` nor `-shm`: no one has it open, so it is opened
 *   `immutable` (a `file:` URI), which reads the file alone and creates
 *   nothing;
 * - both: the agent has it open, and a read-only open joins the files it
 *   already keeps;
 * - only one (a crash's leftover), or an open or read that fails (a lock,
 *   a WAL that needs recovery): the database and its WAL are copied to a
 *   temp directory and the copy is read.
 */

import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export type SqliteModule = typeof import("node:sqlite");

/** `node:sqlite`, or null where this Node lacks it (or keeps it behind a flag). */
export function loadSqlite(): SqliteModule | null {
  try {
    // Not a static import: the module must load on a Node without it.
    const mod = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
    return mod && typeof mod.DatabaseSync === "function" ? mod : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `read` run on `db`, closing it after, even when `read` is async. */
async function using<T>(db: DatabaseSync, read: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

/**
 * `read` run on the database at `path`, never writing to `path`'s
 * directory. Throws when even a copy can't be read.
 */
export async function readSqliteStore<T>(
  sqlite: SqliteModule,
  path: string,
  read: (db: DatabaseSync) => T | Promise<T>,
  opts: { tempPrefix: string },
): Promise<T> {
  const [wal, shm] = await Promise.all([exists(`${path}-wal`), exists(`${path}-shm`)]);
  if (wal === shm) {
    try {
      // `pathToFileURL` escapes `?`, `#` and `%` in the path, which SQLite decodes back.
      const target = wal ? path : `${pathToFileURL(path).href}?immutable=1`;
      return await using(new sqlite.DatabaseSync(target, { readOnly: true }), read);
    } catch {
      // Read a copy.
    }
  }
  const dir = await mkdtemp(join(tmpdir(), opts.tempPrefix));
  try {
    const copy = join(dir, basename(path));
    await copyFile(path, copy);
    // Without its WAL the copy would miss what the agent wrote since the last checkpoint.
    await copyFile(`${path}-wal`, `${copy}-wal`).catch(() => undefined);
    return await using(new sqlite.DatabaseSync(copy), read);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
