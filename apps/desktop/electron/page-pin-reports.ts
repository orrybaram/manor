/**
 * The page pins script's reports (`page-pins-script.ts`), checked. They
 * arrive as console lines the page itself can also write, so nothing in one
 * is trusted: every field is type-checked and capped before main acts on it
 * or passes it to the renderer, and a report that doesn't fit is dropped.
 */
import type { PickedElementResult } from "../src/electron";

type Box = { x: number; y: number; width: number; height: number };

/** A pick as the page reports it, before main adds its screenshot. */
export interface PickReport extends PickedElementResult {
  pickId: string;
  viewport: { width: number; height: number };
}

/** Where each pin's element is, in the page's CSS pixels. */
export interface PagePinsLayout {
  pins: Array<Box & { id: string; gone: boolean }>;
  viewport: { width: number; height: number };
}

/** Caps on what a report may carry; past them the field is cut or dropped. */
export const REPORT_LIMITS = {
  id: 100,
  selector: 1000,
  outerHTML: 2000,
  components: 20,
  componentName: 200,
  fileName: 500,
  styleEntries: 30,
  styleKey: 100,
  styleValue: 300,
  pins: 500,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function box(value: unknown): Box | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

function viewport(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value)) return null;
  const { width, height } = value;
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** An id: short, and nothing a selector or a call could trip on. */
function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= REPORT_LIMITS.id && /^[\w-]+$/.test(value)
    ? value
    : null;
}

function cut(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value).slice(0, REPORT_LIMITS.styleEntries)) {
    if (typeof v === "string") out[k.slice(0, REPORT_LIMITS.styleKey)] = v.slice(0, REPORT_LIMITS.styleValue);
  }
  return out;
}

function components(value: unknown): PickedElementResult["reactComponents"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<PickedElementResult["reactComponents"]> = [];
  for (const c of value.slice(0, REPORT_LIMITS.components)) {
    if (!isRecord(c) || typeof c.name !== "string") continue;
    const entry: (typeof out)[number] = { name: c.name.slice(0, REPORT_LIMITS.componentName) };
    const source = c.source;
    if (isRecord(source) && typeof source.fileName === "string" && finite(source.lineNumber)) {
      entry.source = {
        fileName: source.fileName.slice(0, REPORT_LIMITS.fileName),
        lineNumber: Math.trunc(source.lineNumber),
      };
    }
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** A `__MANOR_PIN_PICK__` payload, or null if it isn't one. */
export function parsePickReport(json: string): PickReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const pickId = id(raw.pickId);
  const selector = cut(raw.selector, REPORT_LIMITS.selector);
  const outerHTML = cut(raw.outerHTML, REPORT_LIMITS.outerHTML);
  const boundingBox = box(raw.boundingBox);
  const view = viewport(raw.viewport);
  if (!pickId || !selector || outerHTML === null || !boundingBox || !view) return null;
  const pick: PickReport = {
    pickId,
    selector,
    outerHTML,
    boundingBox,
    viewport: view,
    computedStyles: stringRecord(raw.computedStyles),
    accessibility: stringRecord(raw.accessibility),
  };
  const reactComponents = components(raw.reactComponents);
  if (reactComponents) pick.reactComponents = reactComponents;
  return pick;
}

/** A `__MANOR_PINS__` payload, or null if it isn't one. */
export function parsePinsLayout(json: string): PagePinsLayout | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.pins) || raw.pins.length > REPORT_LIMITS.pins) return null;
  const view = viewport(raw.viewport);
  if (!view) return null;
  const pins: PagePinsLayout["pins"] = [];
  for (const p of raw.pins) {
    if (!isRecord(p)) return null;
    const pinId = id(p.id);
    const rect = box(p);
    if (!pinId || !rect || typeof p.gone !== "boolean") return null;
    pins.push({ id: pinId, ...rect, gone: p.gone });
  }
  return { pins, viewport: view };
}

/** A `__MANOR_PIN_OPEN__` payload: a pin's id, or null. */
export function parsePinOpen(value: string): string | null {
  return id(value);
}
