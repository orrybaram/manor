/**
 * Where a workspace's diff is measured from: the merge-base of its HEAD and a
 * base ref, cached while neither has moved (issue #302). Resolving HEAD and
 * the ref is one cheap `rev-parse` with no working-tree pass; the merge-base
 * walk runs only when that pair changes.
 */

/** A base ref and the commits it and HEAD point at. */
export interface BasePoint {
  ref: string;
  head: string;
  refSha: string;
}

/** Runs one git command in the workspace and returns its stdout. */
type RunGit = (args: string[]) => Promise<string>;

/** Where HEAD and `ref` point; rejects when either does not resolve. */
export async function resolveBasePoint(git: RunGit, ref: string): Promise<BasePoint> {
  const [head = "", refSha = ""] = (await git(["rev-parse", "HEAD", ref])).trim().split("\n");
  return { ref, head, refSha };
}

const samePoint = (a: BasePoint, b: BasePoint) =>
  a.ref === b.ref && a.head === b.head && a.refSha === b.refSha;

/** Each workspace's merge-base, by `K`, recomputed only when its `BasePoint` moves. */
export class MergeBaseCache<K> {
  private entries = new Map<K, { point: BasePoint; mergeBase: string }>();

  async get(key: K, point: BasePoint, git: RunGit): Promise<string> {
    const cached = this.entries.get(key);
    if (cached && samePoint(cached.point, point)) return cached.mergeBase;
    const mergeBase = (await git(["merge-base", point.ref, "HEAD"])).trim();
    this.entries.set(key, { point, mergeBase });
    return mergeBase;
  }

  /** Forget every workspace `keep` rejects. */
  prune(keep: (key: K) => boolean): void {
    for (const key of Array.from(this.entries.keys())) {
      if (!keep(key)) this.entries.delete(key);
    }
  }
}
