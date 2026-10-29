/**
 * OpenFileWatcher — tells a file pane when the file it has open changes on
 * disk, on whichever host the file lives.
 *
 * Each connection names the files it has open (`files.watch`), per
 * workspace; the union is polled through a `PerHostPoller`, so a remote host
 * that is slow or away holds back only its own files. A tick is one command
 * per host: `cksum` of each open file, read from stdin (no names to parse),
 * so polling a handful of files every second costs a few bytes over ssh. Only
 * a file whose checksum moved is read (`readWorkspaceFile`), to report its
 * content hash — the hash `files.read` and `files.write` answer — and
 * `files.changed` goes to each connection that has it open, never to
 * everyone.
 *
 * `fs.watch` would not reach a remote host's files from here, which is why
 * this polls the way the diff and branch watchers do.
 *
 * The first scan of a newly watched file only takes its checksum: a change
 * between the caller's read and that scan goes unreported, which the caller
 * covers by having read the file just before watching it.
 */

import { posix } from "node:path";
import { PerHostPoller, type HostPath } from "./per-host-poller";
import type { PublishToRenderer } from "./renderer-broadcast";
import { isSafeRelPath, readWorkspaceFile, type FilesBackend } from "./workspace-files";

/** What `files.changed` carries. */
export interface FileChangedEvent {
  /** The workspace, as the watcher named it in `files.watch`. */
  workspace: HostPath;
  /** The file, relative to the workspace, as named in `files.watch`. */
  path: string;
  /**
   * Its content hash now (as `files.read` answers it), or null when it can no
   * longer be opened: deleted, or now binary or too large.
   */
  hash: string | null;
}

/** Each host's backend — `BackendRegistry` in the app. */
export interface FileHosts {
  get(hostId: string): FilesBackend;
}

export interface OpenFileWatcherOptions {
  /** Where `files.changed` goes: the server's bus, addressed. */
  publishTo: PublishToRenderer;
  /** How often each host's open files are checked; 1s by default. */
  intervalMs?: number;
}

/** One file a connection has open. */
interface Watched {
  workspace: HostPath;
  relPath: string;
}

/** A file's checksum line from `cksum`, or `MISSING` when it could not be read. */
type Stamp = string;
const MISSING: Stamp = "-";

/** Prints one `cksum` line (or `-`) per argument, in order. */
const STAMP_SCRIPT = `for f; do s=$(cksum < "$f" 2>/dev/null) || s=-; printf '%s\\n' "$s"; done`;

const fileKey = (hostId: string, absPath: string) => `${hostId}\0${absPath}`;

export class OpenFileWatcher {
  private readonly poller: PerHostPoller<Record<string, Stamp>>;
  /** Each connection's open files, by workspace (`hostId\0path`). */
  private readonly byOwner = new Map<string, Map<string, Watched[]>>();
  /** Each watched file's last checksum, by `fileKey`. */
  private readonly stamps = new Map<string, Stamp>();
  /** Each watched file's last reported hash, by `fileKey`. */
  private readonly hashes = new Map<string, string | null>();

  constructor(
    private readonly hosts: FileHosts,
    private readonly opts: OpenFileWatcherOptions,
  ) {
    this.poller = new PerHostPoller<Record<string, Stamp>>({
      label: "OpenFileWatcher",
      scan: (hostId, paths) => this.scan(hostId, paths),
      intervalMs: () => opts.intervalMs ?? 1000,
      merge: (results) => Object.assign({}, ...results) as Record<string, Stamp>,
      emit: (merged) => this.compare(merged),
    });
  }

  /**
   * `owner` has `relPaths` of `workspace` open: they replace what it had open
   * there (an empty list stops watching the workspace). Its other
   * workspaces' files are left as they are. A path that could leave the
   * workspace is ignored.
   */
  watch(owner: string, workspace: HostPath, relPaths: readonly string[]): void {
    const ws = { path: workspace.path, hostId: workspace.hostId };
    const files = Array.from(new Set(relPaths.filter(isSafeRelPath))).map((relPath) => ({
      workspace: ws,
      relPath,
    }));
    const mine = this.byOwner.get(owner) ?? new Map<string, Watched[]>();
    const wsKey = `${ws.hostId}\0${ws.path}`;
    if (files.length > 0) mine.set(wsKey, files);
    else mine.delete(wsKey);
    if (mine.size > 0) this.byOwner.set(owner, mine);
    else this.byOwner.delete(owner);
    this.apply();
  }

  /** `owner` has nothing open: it said so, or its connection closed. */
  unwatch(owner: string): void {
    if (!this.byOwner.delete(owner)) return;
    this.apply();
  }

  /** Stop for everyone: the server is shutting down. */
  dispose(): void {
    this.byOwner.clear();
    this.poller.stop();
  }

  /** Every watched file, by `fileKey`, with who has it open. */
  private watchers(): Map<string, Array<{ owner: string; watched: Watched }>> {
    const out = new Map<string, Array<{ owner: string; watched: Watched }>>();
    for (const [owner, byWorkspace] of this.byOwner) {
      for (const files of byWorkspace.values()) {
        for (const watched of files) {
          const key = fileKey(watched.workspace.hostId, posix.join(watched.workspace.path, watched.relPath));
          const list = out.get(key);
          if (list) list.push({ owner, watched });
          else out.set(key, [{ owner, watched }]);
        }
      }
    }
    return out;
  }

  private apply(): void {
    const watchers = this.watchers();
    for (const key of Array.from(this.stamps.keys())) {
      if (!watchers.has(key)) this.stamps.delete(key);
    }
    for (const key of Array.from(this.hashes.keys())) {
      if (!watchers.has(key)) this.hashes.delete(key);
    }
    if (watchers.size === 0) {
      this.poller.setEntries([]);
      this.poller.stop();
      return;
    }
    const entries: HostPath[] = Array.from(watchers.keys()).map((key) => {
      const [hostId, path] = key.split("\0");
      return { hostId, path };
    });
    this.poller.setEntries(entries);
    // Every host's next scan is published even if it matches the last, so a
    // file watched again after a gap is compared from its first scan.
    this.poller.reset({ reemit: true });
    this.poller.start({ immediate: true });
  }

  /** One host's open files' checksums, by `fileKey`. */
  private async scan(hostId: string, absPaths: string[]): Promise<Record<string, Stamp>> {
    const out = await this.hosts
      .get(hostId)
      .shell.exec("sh", ["-c", STAMP_SCRIPT, "sh", ...absPaths], { timeout: 10_000 });
    const lines = out.split("\n");
    const result: Record<string, Stamp> = {};
    absPaths.forEach((absPath, i) => {
      result[fileKey(hostId, absPath)] = lines[i]?.trim() || MISSING;
    });
    return result;
  }

  /** Report each file whose checksum moved since its last scan. */
  private compare(merged: Record<string, Stamp>): void {
    for (const [key, stamp] of Object.entries(merged)) {
      const before = this.stamps.get(key);
      this.stamps.set(key, stamp);
      if (before !== undefined && before !== stamp) void this.report(key, stamp);
    }
  }

  private async report(key: string, stamp: Stamp): Promise<void> {
    const watchers = this.watchers().get(key);
    if (!watchers) return;
    const { workspace, relPath } = watchers[0].watched;
    let hash: string | null = null;
    if (stamp !== MISSING) {
      try {
        const read = await readWorkspaceFile(this.hosts.get(workspace.hostId), workspace.path, relPath);
        hash = read.ok ? read.hash : null;
      } catch (err) {
        console.error("[OpenFileWatcher] could not read a changed file:", err);
        return;
      }
    }
    // Watched still, and not already reported at this hash.
    const now = this.watchers().get(key);
    if (!now || (this.hashes.has(key) && this.hashes.get(key) === hash)) return;
    this.hashes.set(key, hash);
    for (const { owner, watched } of now) {
      this.opts.publishTo(owner, "files", "changed", {
        workspace: watched.workspace,
        path: watched.relPath,
        hash,
      });
    }
  }
}
