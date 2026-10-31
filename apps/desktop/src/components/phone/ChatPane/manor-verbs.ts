/**
 * The words the chat says Claude's work in: Manor's own, a house being kept.
 * The live line rotates the present tense while a turn runs; a finished
 * turn's line closes on a past tense picked by its id.
 */

export type ManorVerb = { present: string; past: string };

export const MANOR_VERBS: readonly ManorVerb[] = [
  { present: "Tending", past: "Tended" },
  { present: "Sweeping", past: "Swept" },
  { present: "Dusting", past: "Dusted" },
  { present: "Polishing", past: "Polished" },
  { present: "Mending", past: "Mended" },
  { present: "Tidying", past: "Tidied" },
  { present: "Airing out", past: "Aired out" },
  { present: "Stoking", past: "Stoked" },
  { present: "Pruning", past: "Pruned" },
  { present: "Cataloguing", past: "Catalogued" },
  { present: "Steeping", past: "Steeped" },
  { present: "Furnishing", past: "Furnished" },
];

/** FNV-1a over the string's UTF-16 code units: the same on every load. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The past-tense verb a turn closes on, picked by its entry id, so a reload says the same. */
export function pastVerb(id: string): string {
  return MANOR_VERBS[hash(id) % MANOR_VERBS.length].past;
}

