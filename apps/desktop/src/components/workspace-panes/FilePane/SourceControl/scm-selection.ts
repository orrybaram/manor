/**
 * Source Control's multi-select, as VS Code's lists do it: a click picks one
 * file, Shift+click the visible files from the anchor to it, and Cmd+click
 * (Ctrl+click off macOS) adds or drops one. A selection lives in one group,
 * so Stage and Unstage never mix.
 */
export type ScmSelection<G extends string = string> = {
  group: G | null;
  paths: ReadonlySet<string>;
  /** Where a Shift+click range starts: the last file clicked without Shift. */
  anchor: string | null;
};

export const NO_SELECTION: ScmSelection<never> = {
  group: null,
  paths: new Set(),
  anchor: null,
};

/** What a click on a row does to the selection. */
export type SelectGesture = "only" | "range" | "toggle";

type Modifiers = Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">;

/** A click's gesture: Shift ranges, the platform's command key toggles. */
export function selectGesture(e: Modifiers, mac: boolean): SelectGesture {
  if (e.shiftKey) return "range";
  if (mac ? e.metaKey : e.ctrlKey) return "toggle";
  return "only";
}

/**
 * `sel` after a click on `path` in `group`. `visible` is the group's file
 * rows in the order they show, without those under a closed folder: a range
 * runs over what can be seen. A click in another group starts over there.
 */
export function selectRow<G extends string>(
  sel: ScmSelection<G>,
  group: G,
  path: string,
  gesture: SelectGesture,
  visible: readonly string[],
): ScmSelection<G> {
  const only = { group, paths: new Set([path]), anchor: path };
  if (sel.group !== group || gesture === "only") return only;
  if (gesture === "toggle") {
    const paths = new Set(sel.paths);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { group, paths, anchor: path };
  }
  const from = sel.anchor === null ? -1 : visible.indexOf(sel.anchor);
  const to = visible.indexOf(path);
  // The anchor left the list, or went under a closed folder: start from here.
  if (from < 0 || to < 0) return only;
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return {
    group,
    paths: new Set(visible.slice(lo, hi + 1)),
    anchor: sel.anchor,
  };
}

/** The selected files still listed in the selection's group, in list order. */
export function selectedIn<G extends string>(
  sel: ScmSelection<G>,
  group: G,
  listed: readonly string[],
): string[] {
  if (sel.group !== group) return [];
  return listed.filter((path) => sel.paths.has(path));
}

/**
 * What a row's button acts on: every selected file when the row is one of
 * two or more selected, or just the row's own file.
 */
export function actionTargets(selected: readonly string[], path: string): string[] {
  return selected.length > 1 && selected.includes(path) ? [...selected] : [path];
}
