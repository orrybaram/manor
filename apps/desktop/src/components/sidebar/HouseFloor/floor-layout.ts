import { FLOOR_PITCH } from "../../../lib/house-floor";

/**
 * Where the house floor's sockets sit on its canvas, and what each dot looks
 * like. Pure, so it's testable; `floor-renderer.ts` draws with it.
 */

export const P = FLOOR_PITCH;
/** Room above the top row and below the bottom row, in CSS pixels. */
export const FLOOR_TOP = 14;
export const FLOOR_BOTTOM = 22;

/** Room always kept for the list's scrollbar, whether or not it shows. */
export const FLOOR_SCROLLBAR_ALLOWANCE = 12;

/**
 * The width the grid's columns come from: the scroll body's full width (its
 * scrollbar included) less the allowance, so the floor never reshuffles as
 * the list starts or stops overflowing.
 */
export function floorGridWidth(bodyWidth: number): number {
  return Math.max(0, bodyWidth - FLOOR_SCROLLBAR_ALLOWANCE);
}

/** The least height that holds every row: the floor never clips. */
export function floorHeight(rows: number): number {
  return FLOOR_TOP + FLOOR_BOTTOM + (Math.max(1, rows) - 1) * P;
}

export interface FloorLayout {
  cols: number;
  rows: number;
  /** The canvas's size in CSS pixels. */
  width: number;
  height: number;
}

/** Left edge of the grid, so it's centred in the canvas. */
export function originX(layout: FloorLayout): number {
  return (layout.width - (layout.cols - 1) * P) / 2;
}

/**
 * Socket `k`'s centre. Socket 0 is bottom-left; rows count up from the
 * bottom, which sits `FLOOR_BOTTOM` above the canvas's bottom edge (a taller
 * canvas leaves its spare room above the floor).
 */
export function socketPosition(layout: FloorLayout, k: number): [number, number] {
  return [
    originX(layout) + (k % layout.cols) * P,
    layout.height - FLOOR_BOTTOM - Math.floor(k / layout.cols) * P,
  ];
}

/** Grid point (i, j), row 0 at the top: for effects over the whole grid. */
export function gridPoint(layout: FloorLayout, i: number, j: number): [number, number] {
  return [originX(layout) + i * P, layout.height - FLOOR_BOTTOM - (layout.rows - 1 - j) * P];
}

const MODULUS = 2_147_483_647;

/** Park–Miller, as in the design mock: a stream of numbers in (0, 1). */
export function seededRandom(seed: number): () => number {
  let state = Math.floor(Math.abs(seed)) % MODULUS;
  if (state === 0) state = 11;
  return () => {
    state = (state * 16_807) % MODULUS;
    return state / MODULUS;
  };
}

/**
 * The floor's scattered fill order: the nth dot sits in socket `order[n]`.
 * A permutation of every socket, seeded per floor so it survives a restart.
 */
export function fillOrder(seed: number, size: number): number[] {
  const rand = seededRandom(seed);
  const order = Array.from({ length: size }, (_, k) => k);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** How one dot looks. Random, seeded per floor: Manor keeps only counts. */
export interface DotLook {
  /** 0.15–1: bigger and brighter. */
  weight: number;
  /** Faint (×.45). */
  dim: boolean;
  /** Flickers while the floor is awake. */
  flicker: boolean;
  /** The flicker's phase. */
  flick: number;
  /** Brush passes it takes to feed (1–3). */
  passes: number;
}

/** Every dot's look for a floor, in fill order. */
export function dotLooks(seed: number, size: number): DotLook[] {
  // A different stream from the fill order's, so the two don't correlate.
  const rand = seededRandom(seed + 7919);
  const looks: DotLook[] = [];
  for (let i = 0; i < size; i++) {
    const r = rand();
    const minutes = Math.round(Math.exp(rand() * 5.6));
    const flick = rand() * 10;
    looks.push({
      weight: Math.max(0.15, Math.min(1, Math.log(minutes + 1) / Math.log(280))),
      dim: r >= 0.75 && r < 0.9,
      flicker: r >= 0.9,
      flick,
      passes: 1 + (minutes > 20 ? 1 : 0) + (minutes > 90 ? 1 : 0),
    });
  }
  return looks;
}

/**
 * A dot's alpha before the floor's state applies (`agentAlpha` in the mock).
 * `passesLeft` dims a dot that's been brushed but not yet fed.
 */
export function dotAlpha(look: DotLook, time: number, passesLeft = look.passes): number {
  let alpha = 0.28 + look.weight * 0.62;
  if (look.dim) alpha *= 0.45;
  if (look.flicker && Math.sin(time * 9 + look.flick) > 0.55) alpha *= 0.35;
  return alpha * (0.55 + 0.45 * (passesLeft / look.passes));
}

/** Seconds a new dot takes to fade in. */
export const ARRIVE_SECONDS = 1.4;

/**
 * What the floor is doing: filling (locked), awake (full; sweep to feed),
 * or settle (cleared; the house answers).
 */
export type FloorPhase = "filling" | "awake" | "settle";

/** The state the canvas announces, for its aria-label. */
export function floorLabel(dots: number, size: number, phase: FloorPhase): string {
  switch (phase) {
    case "awake":
      return `House floor: ${dots} of ${size}, awake, sweep to feed`;
    case "settle":
      return "House floor: fed, the house answers";
    default:
      return `House floor: ${dots} of ${size}, filling`;
  }
}
