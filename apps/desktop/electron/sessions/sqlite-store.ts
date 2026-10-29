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
 *   temp directory and the copy is read. A caller that reads often (a
 *   preview on every highlight) passes a {@link SqliteCopyCache}, which
 *   keeps one copy a while and shares it, rather than a copy per read.
 */

import { access, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
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
  opts: { tempPrefix: string; copies?: SqliteCopyCache },
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
  if (opts.copies) {
    const lease = await opts.copies.lease(sqlite, path, opts.tempPrefix);
    try {
      return await using(new sqlite.DatabaseSync(`${pathToFileURL(lease.path).href}?immutable=1`, { readOnly: true }), read);
    } finally {
      lease.release();
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

/** A cached copy, held until released. */
interface CopyLease {
  path: string;
  release(): void;
}

/** Copies of databases that couldn't be read in place, one per database, kept while it is unchanged. */
export interface SqliteCopyCache {
  lease(sqlite: SqliteModule, path: string, tempPrefix: string): Promise<CopyLease>;
}

async function stampOf(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "-";
  }
}

interface CopyEntry {
  stamp: string;
  dir: Promise<string>;
  copy: Promise<string>;
  refs: number;
  idleSince: number;
  retired: boolean;
}

/**
 * A cache of database copies. A copy is made once per database and its WAL's
 * size and mtime, folded into a standalone file (so it opens `immutable`),
 * shared by every read while those hold, and removed once it has been idle
 * for `ttlMs` or the database moved on.
 */
export function createSqliteCopyCache(ttlMs = 30_000): SqliteCopyCache {
  const entries = new Map<string, CopyEntry>();
  const remove = (entry: CopyEntry): void => {
    void entry.dir.then((dir) => rm(dir, { recursive: true, force: true })).catch(() => undefined);
  };
  const retire = (path: string, entry: CopyEntry): void => {
    if (entries.get(path) === entry) entries.delete(path);
    entry.retired = true;
    if (entry.refs === 0) remove(entry);
  };
  const sweepLater = (path: string, entry: CopyEntry): void => {
    const timer = setTimeout(() => {
      if (!entry.retired && entry.refs === 0 && Date.now() - entry.idleSince >= ttlMs) retire(path, entry);
    }, ttlMs);
    timer.unref?.();
  };
  return {
    async lease(sqlite, path, tempPrefix) {
      const stamp = `${await stampOf(path)}|${await stampOf(`${path}-wal`)}`;
      let entry = entries.get(path);
      if (entry && entry.stamp !== stamp) {
        retire(path, entry);
        entry = undefined;
      }
      if (!entry) {
        const dir = mkdtemp(join(tmpdir(), tempPrefix));
        const copy = dir.then(async (d) => {
          const target = join(d, basename(path));
          await copyFile(path, target);
          await copyFile(`${path}-wal`, `${target}-wal`).catch(() => undefined);
          // Fold the WAL in, so the copy is one file every later read opens immutable.
          const db = new sqlite.DatabaseSync(target);
          try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
          } finally {
            db.close();
          }
          return target;
        });
        entry = { stamp, dir, copy, refs: 0, idleSince: Date.now(), retired: false };
        entries.set(path, entry);
      }
      const held = entry;
      held.refs++;
      try {
        const copyPath = await held.copy;
        return {
          path: copyPath,
          release() {
            held.refs--;
            held.idleSince = Date.now();
            if (held.refs > 0) return;
            if (held.retired) remove(held);
            else sweepLater(path, held);
          },
        };
      } catch (err) {
        held.refs--;
        retire(path, held);
        throw err;
      }
    },
  };
}
