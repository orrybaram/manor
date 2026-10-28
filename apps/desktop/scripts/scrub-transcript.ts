/**
 * Turn a real Claude Code JSONL transcript into a fixture safe to commit,
 * for `electron/chat-mirror/__fixtures__/`. Dev-only: never imported by the
 * app, only by its own test and the fixture leak test. Name a fixture
 * `claude-code-<version>-<topic>.jsonl` after the lines' `version`, pass
 * `--leaks`, read the result, then update the goldens (`pnpm vitest run -u`).
 *
 *   node scripts/scrub-transcript.ts <in.jsonl> <out.jsonl> [--lines 0:10,120:340] [--leaks [hashes.json]]
 *
 * What survives: every line's shape. Identifier-shaped keys (one with a
 * `.`, `/`, `@` or `:port` is data, and scrubbed), `type`/`subtype`/`stop_reason`/
 * `commandMode`/`origin.kind` and other enum-like values, tool names,
 * numbers, booleans, array and object structure, and the leading tag shape
 * of text (`<bash-input>`, `<task-notification>`, `<system-reminder>`,
 * `<command-name>/x</command-name>`, the interrupt marker, the compaction
 * and caveat preambles). What doesn't: all free text. Each word becomes a
 * placeholder word of the same length, so line lengths and line counts
 * hold; punctuation and whitespace stay, so a diff line keeps its `+`/`-`/
 * space prefix. Long text is shortened. IDs (uuids, `toolu_…`, `msg_…`,
 * `req_…`, session, agent and task ids) are remapped consistently to fake
 * ones of the same format, so links between lines survive. Paths become
 * `/work/repo/…` under the session's cwd, else `/dN/…`, keeping depth and
 * extension. Times are shifted so the first one is 2026-01-01: ISO
 * timestamps and dates, in fields or in text, and 10- or 13-digit epochs
 * from 2020–2035, as numbers or strings. Numbers of three or more digits in
 * text, and digit strings over six, are replaced; costs are zeroed and
 * token counts rounded to the hundred; `version` is kept only when it is
 * semver, and `osVersion` loses its digits.
 *
 * Safe by default: a string is scrubbed unless a rule says to keep it.
 *
 * Dropped whole: the line types in `DROP_TYPES` (`api-request*` bodies,
 * file-history snapshots and artifact ledgers: noisy, and full of file
 * contents), `credential_org` and `prompt_snapshot` attachments, and the
 * keys in `DROP_KEYS` (classifier context, permission decisions, wire
 * contexts, quota details), any key starting `rendered` or `pr` (a PR's
 * number, link, repository), and any matching
 * `SENSITIVE_KEY` (email, oauth, account, org, secrets). `cwd` becomes
 * `/work/repo`, `gitBranch` `feat/branch`, `slug` `placeholder-slug`.
 *
 * A line's text shares one budget (`LINE_BUDGET`); once it is spent, each
 * further string is cut to a few words, so a huge harness attachment stays
 * small but keeps every key and array item.
 *
 * `--leaks` adds hashes of distinctive source tokens the scrub replaced to
 * a JSON list, which the fixture leak test checks the fixtures against.
 * Only hashes are written, never the tokens, but a short hash of a path
 * segment or word can be guessed from a dictionary: the list stays on this
 * machine. It goes to `LOCAL_LEAK_HASHES` (gitignored) unless a path is given.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";

/** Line types dropped whole. */
const DROP_TYPES = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "file-history-snapshot",
  "file-history-delta",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
]);

/**
 * Attachment types dropped whole: credentials, and the whole system prompt
 * (`prompt_snapshot`), which is large and says nothing a chat reads.
 */
const DROP_ATTACHMENTS = new Set(["credential_org", "prompt_snapshot"]);

/** Keys dropped wherever they appear. */
const DROP_KEYS = new Set([
  "rendered",
  "serverClassifierContext",
  "serverClassifierRequest",
  "permissionDecision",
  "wireIngestContext",
  "quotaLimits",
  "hopChain",
  "verifiedPeerProcStart",
  "holderPidSpace",
  "holderProcStart",
]);

/** Rendered copies, and a PR's number, link and repository: dropped too. */
const DROP_KEY = /^rendered|^pr[A-Z]/;

/** Keys that smell of identity or secrets: dropped too. */
const SENSITIVE_KEY =
  /e-?mail|oauth|account|^org|organization|api_?key|secret|password|passwd|credential|cookie|authorization|bearer/i;

/** Keys whose value is an enum-like word: kept when it looks like one. */
const ENUM_KEYS = new Set([
  "type",
  "subtype",
  "stop_reason",
  "stop_sequence",
  "commandMode",
  "kind",
  "role",
  "model",
  "requestedModel",
  "advisorModel",
  "resolvedModel",
  "level",
  "permissionMode",
  "mode",
  "status",
  "media_type",
  "version",
  "entrypoint",
  "service_tier",
  "speed",
  "inference_geo",
  "operation",
  "reason",
  "effort",
  "perTurnEffort",
  "thinkingDisplay",
  "userType",
  "subagent_type",
  "trigger",
  "promptSource",
  "queuePriority",
  "sessionKind",
  "error",
  "state",
  "cronKind",
  "taskKind",
  "task_type",
  "fromMode",
  "producer",
  "family",
  "run_in_background",
  "isolation",
  "returnCodeInterpretation",
  "tool_name",
  "commandName",
  "stopReason",
  "audience",
  "icon",
  "contract",
  "caller",
]);
/** What an enum-like value looks like: one short token, no spaces, no path or host. */
const ENUM_VALUE = /^[A-Za-z0-9_.:<>+-]{0,64}$/;
/** A `media_type` is the one enum with a slash. */
const MEDIA_TYPE = /^[a-z]+\/[\w.+-]{1,40}$/;
/** A `version` is kept only when it is a version: `2.1.308`, not `1792097047-7a55`. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,30})?$/;
/** A key kept as is: identifier-shaped, not a path, host, file or email. */
const PLAIN_KEY = /^[A-Za-z_$][\w$:-]{0,63}$/;
/** Seconds and milliseconds since the epoch, 2020 to 2035: a wall-clock time. */
const EPOCH_S = [Date.UTC(2020, 0, 1) / 1000, Date.UTC(2036, 0, 1) / 1000];
const EPOCH_MS = [Date.UTC(2020, 0, 1), Date.UTC(2036, 0, 1)];

/** Keys whose string value is an id, remapped to a fake of the same shape. */
const ID_KEYS = new Set([
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "leafUuid",
  "anchorUuid",
  "headUuid",
  "tailUuid",
  "sessionId",
  "session_id",
  "continuedInSessionId",
  "requestId",
  "requestRef",
  "promptId",
  "deliveryId",
  "commandUuid",
  "agentId",
  "backgroundTaskId",
  "resumedAgentId",
  "revivedAgentId",
  "taskId",
  "task_id",
  "scheduledTaskId",
  "scheduledFireId",
  "senderTaskId",
  "runId",
  "msg_id",
  "thread_id",
  "artifact_id",
  "interruptedMessageId",
  "toolUseID",
  "tool_use_id",
  "parentToolUseID",
  "sourceToolUseID",
  "sourceToolAssistantUUID",
  "atis",
  "holderJob",
  "id",
]);

/** Keys whose value is a path. */
const PATH_KEYS = new Set([
  "cwd",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "outputFile",
  "relocatedCwd",
  "persistedOutputPath",
  "backgroundCwdHint",
]);

/** Text Claude Code writes itself, kept verbatim wherever it appears. */
const KEEP_PHRASES = [
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
  "Caveat: The messages below were generated by the user while running local commands.",
  "This session is being continued from a previous conversation",
  "No response requested.",
  "(Bash completed with no output)",
  "Output too large",
  "API Error",
];

/** Tags whose content is an id. */
const ID_TAGS = ["task-id", "tool-use-id", "agent-id"];

/** Path segments too generic to say anything, kept as they are. */
const KEEP_SEGMENTS = new Set(["", "tmp", "usr", "bin", "lib", "var", "etc", "opt", "home", "src", "dist"]);

/** Caps: a string's characters and lines, and a line's characters. */
const MAX_TEXT = 4200;
const MAX_LINES = 120;
const MAX_LINE = 300;
/** Larger values say nothing a test needs: whole files, mostly. */
/** Characters of text one line may keep before its strings are cut short. */
const LINE_BUDGET = 2_000;
const SPENT_CAP = 60;
const SHORT_KEYS: Record<string, number> = { originalFile: 600, oldString: 1500, newString: 1500 };

const LOREM = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut " +
  "labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris " +
  "nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse " +
  "cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui " +
  "officia deserunt mollit anim id est laborum"
).split(" ");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID = /^(toolu_|srvtoolu_|msg_|req_)[A-Za-z0-9]+$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64_RUN = /[A-Za-z0-9+/=_-]{120,}/g;

/**
 * One pass over free text, in priority order: emails, URLs, ids, paths,
 * then words. Anything else (punctuation, whitespace, emoji) stays.
 */
const TEXT_TOKEN = new RegExp(
  [
    String.raw`(?<email>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)`,
    String.raw`(?<date>\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?(?![\w-]))`,
    String.raw`(?<url>https?:\/\/[^\s"'<>()\[\]{}\x60]+)`,
    String.raw`(?<id>\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b(?:toolu_|srvtoolu_|msg_|req_)[A-Za-z0-9]{8,})`,
    String.raw`(?<path>(?<![\w.~])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?)`,
    String.raw`(?<tag><\/?[a-z][a-z0-9_-]*(?=[\s>\/]))`,
    String.raw`(?<word>[\p{L}\p{N}]+)`,
  ].join("|"),
  "gu",
);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ScrubResult {
  lines: string[];
  /** Line types dropped, with counts. */
  dropped: Record<string, number>;
}

export class TranscriptScrubber {
  private ids = new Map<string, string>();
  private segments = new Map<string, string>();
  private cwds = new Map<string, string>();
  private words = new Map<number, number>();
  private digitCount = 0;
  private tsShift: number | null = null;
  private budget = LINE_BUDGET;
  private closedTags = new Set<string>();
  /** Source tokens replaced, and tokens kept by rule. */
  readonly replaced = new Set<string>();
  /** Source ids and path segments replaced: the most telling of them. */
  readonly names = new Set<string>();
  readonly kept = new Set<string>();

  /** A scrubbed line, or null when the line is dropped. */
  scrubLine(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    if (typeof parsed.type === "string" && DROP_TYPES.has(parsed.type)) return null;
    const att = parsed.attachment;
    if (isObject(att) && typeof att.type === "string" && DROP_ATTACHMENTS.has(att.type)) return null;
    if (typeof parsed.cwd === "string") this.cwd(parsed.cwd);
    this.budget = LINE_BUDGET;
    return JSON.stringify(this.value(parsed, null, null));
  }

  scrubLines(raw: string[]): ScrubResult {
    const lines: string[] = [];
    const dropped: Record<string, number> = {};
    for (const l of raw) {
      if (!l.trim()) continue;
      const out = this.scrubLine(l);
      if (out !== null) {
        lines.push(out);
        continue;
      }
      let type = "malformed";
      try {
        const o = JSON.parse(l) as { type?: unknown; attachment?: { type?: unknown } };
        type = String(o.type) + (o.type === "attachment" ? `:${String(o.attachment?.type)}` : "");
      } catch {
        // stays "malformed"
      }
      dropped[type] = (dropped[type] ?? 0) + 1;
    }
    return { lines, dropped };
  }

  /**
   * Hashes of distinctive source tokens the scrub replaced, at least 8
   * characters and never one a rule kept somewhere (a key, an enum): every
   * id and path segment but uuids, and a sample of `limit` words.
   */
  leakHashes(limit = 120): string[] {
    const hashes = (tokens: Set<string>) => {
      const out = new Set<string>();
      for (const t of tokens) {
        // Numbers say nothing, and a kept number may share a replaced one's
        // digits. A uuid is checked by shape instead: every one is fake.
        if (t.length < 8 || this.kept.has(t) || /^\d+$/.test(t) || UUID.test(t)) continue;
        out.add(leakHash(t));
      }
      return [...out].sort();
    };
    return [...new Set([...hashes(this.names), ...hashes(this.replaced).slice(0, limit)])].sort();
  }

  private value(v: unknown, key: string | null, parent: Record<string, unknown> | null): Json {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return this.number(v, key);
    if (Array.isArray(v)) {
      // `structuredPatch` keeps its hunk numbers and line prefixes like any value.
      return v.map((x) => this.value(x, key, parent));
    }
    if (isObject(v)) {
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) {
        if (DROP_KEYS.has(k) || DROP_KEY.test(k) || SENSITIVE_KEY.test(k)) continue;
        const base = this.key(k);
        let name = base;
        // Two scrubbed keys may land on one placeholder; keep both.
        for (let n = 2; name in out; n++) name = `${base}_${n}`;
        out[name] = this.value(x, k, v);
      }
      return out;
    }
    if (typeof v === "string") return this.string(v, key, parent);
    return null;
  }

  private key(k: string): string {
    if (UUID.test(k) || PREFIXED_ID.test(k)) return this.id(k);
    // A port, a file, a host or a path is data, not schema.
    if (PLAIN_KEY.test(k) && !/:\d+$/.test(k)) return this.keep(k);
    return this.text(k);
  }

  private string(s: string, key: string | null, parent: Record<string, unknown> | null): string {
    if (s === "" || s === "true" || s === "false") return s;
    if (ISO_TS.test(s)) return this.timestamp(s);
    if (ISO_DATE.test(s)) return this.date(s);
    if (/^\d+$/.test(s)) return this.digits(s);
    if (UUID.test(s) || PREFIXED_ID.test(s)) return this.id(s);
    if (key === "cwd") return this.cwd(s);
    if (key === "gitBranch") return "feat/branch";
    if (key === "slug") return "placeholder-slug";
    if ((key === "signature" || key === "data") && /^[A-Za-z0-9+/=_-]{40,}$/.test(s)) {
      return key === "data" ? TINY_PNG : "c2lnbmF0dXJl".repeat(4);
    }
    if (key === "version") return SEMVER.test(s) ? this.keep(s) : this.text(s);
    if (key === "media_type" && MEDIA_TYPE.test(s)) return this.keep(s);
    if (key === "osVersion") return this.text(s).replace(/\d/g, "0");
    if (key !== null && ENUM_KEYS.has(key) && ENUM_VALUE.test(s)) return this.keep(s);
    // A tool's name, a command a local command ran: names, not text.
    if (key === "name" && (parent?.type === "tool_use" || parent?.type === "server_tool_use")) {
      return this.keep(s);
    }
    if (key === "command" && parent && "args" in parent && /^[\w:-]{1,40}$/.test(s)) return this.keep(s);
    if (key !== null && ID_KEYS.has(key) && /^[\w-]{4,64}$/.test(s)) return this.id(s);
    if (key !== null && PATH_KEYS.has(key) && /^(~|\/)/.test(s) && !/\s/.test(s)) return this.path(s);
    return this.text(s, key !== null ? SHORT_KEYS[key] : undefined);
  }

  /** `s`, kept as it is; it and its parts are never counted as leaks. */
  private keep(s: string): string {
    this.kept.add(s);
    for (const re of TOKEN_CUTS) for (const m of s.matchAll(re)) this.kept.add(m[0]);
    return s;
  }

  /** Free text: each word a placeholder, structure kept, length capped. */
  private text(s: string, cap = MAX_TEXT): string {
    let src = s.replace(BASE64_RUN, (m) => {
      this.replaced.add(m);
      return "QUJD".repeat(8);
    });
    // A tag is markup only if the text closes it; `<name>` in prose is words.
    this.closedTags = new Set([...src.matchAll(/<\/([a-z][a-z0-9_-]*)[\s>]/g)].map((m) => m[1]));
    src = shorten(src, Math.min(cap, Math.max(SPENT_CAP, this.budget)));
    this.budget -= src.length;
    let out = "";
    let at = 0;
    for (const span of keptSpans(src)) {
      out += this.textPart(src.slice(at, span.start));
      out += this.keptSpan(src.slice(span.start, span.end), span.kind);
      at = span.end;
    }
    out += this.textPart(src.slice(at));
    return out;
  }

  private keptSpan(s: string, kind: "phrase" | "command" | "status" | "idtag"): string {
    if (kind === "idtag") {
      const m = /^(<[\w-]+>)([^<]*)(<\/[\w-]+>)$/.exec(s);
      if (!m) return this.textPart(s);
      const inner = m[2].trim();
      return m[1] + (inner ? this.id(inner) : "") + m[3];
    }
    if (kind === "command") {
      const m = /^(<command-name>)([^<]*)(<\/command-name>)$/.exec(s);
      if (m && /^\/?[\w:.-]{1,40}$/.test(m[2].trim())) return this.keep(s);
      return this.textPart(s);
    }
    return this.keep(s);
  }

  private textPart(s: string): string {
    return s.replace(TEXT_TOKEN, (...args: unknown[]) => {
      const m = args[0] as string;
      const g = args[args.length - 1] as Record<string, string | undefined>;
      if (g.email) {
        this.replaced.add(m);
        return "user@example.com";
      }
      if (g.url) {
        this.replaced.add(m);
        const rest = m.replace(/^https?:\/\/[^/]+/, "");
        return "https://example.com" + (rest.length > 1 ? this.path(rest.split(/[?#]/)[0]) : rest);
      }
      if (g.date) return this.date(m);
      if (g.id) return this.id(m);
      if (g.path) return this.path(m);
      if (g.tag) {
        const name = m.replace(/^<\/?/, "");
        return this.closedTags.has(name) ? this.keep(m) : m.slice(0, m.length - name.length) + this.textPart(name);
      }
      return this.word(m);
    });
  }

  private word(w: string): string {
    this.replaced.add(w);
    if (/^[0-9]+$/.test(w)) {
      // One or two digits (a count, a list number) say nothing; an issue or
      // PR number, a year or a time might.
      return w.length <= 2 ? w : this.digitWord(w);
    }
    if (/^\p{N}+$/u.test(w)) return this.digitWord(w.replace(/\p{N}/gu, "0"));
    const n = [...w].length;
    const i = this.words.get(n) ?? 0;
    this.words.set(n, i + 1);
    let p = placeholder(n, i);
    if (/^\p{Lu}+$/u.test(w) && n > 1) p = p.toUpperCase();
    else if (/^\p{Lu}/u.test(w)) p = p[0].toUpperCase() + p.slice(1);
    return p;
  }

  /** A fake id of the same shape, the same every time it is asked for. */
  private id(s: string): string {
    const known = this.ids.get(s);
    if (known) return known;
    this.names.add(s);
    const n = this.ids.size + 1;
    let fake: string;
    if (UUID.test(s)) {
      const hex = n.toString(16).padStart(12, "0");
      fake = `00000000-0000-4000-8000-${hex}`;
    } else {
      const prefix = /^(toolu_|srvtoolu_|msg_|req_)/.exec(s)?.[1] ?? "";
      fake = prefix + sameShape(s.slice(prefix.length), n);
    }
    this.ids.set(s, fake);
    return fake;
  }

  /** The session's cwd: the first one seen is /work/repo. */
  private cwd(s: string): string {
    const known = this.cwds.get(s);
    if (known) return known;
    for (const [real, fake] of this.cwds) {
      if (s.startsWith(real + "/")) {
        const mapped = fake + this.segs(s.slice(real.length).split("/").slice(1));
        this.cwds.set(s, mapped);
        return mapped;
      }
    }
    this.replaced.add(s);
    const fake = this.cwds.size === 0 ? "/work/repo" : `/work/repo${this.cwds.size + 1}`;
    this.cwds.set(s, fake);
    return fake;
  }

  /** Under a known cwd, `/work/repo/…`; else the same depth of fake segments. */
  private path(s: string): string {
    for (const [real, fake] of this.cwds) {
      if (s === real) return fake;
      if (s.startsWith(real + "/")) return fake + this.segs(s.slice(real.length).split("/").slice(1));
    }
    const lead = /^(~|\.{1,2})?/.exec(s)?.[0] ?? "";
    const parts = s.slice(lead.length).split("/");
    // parts[0] is "" for the leading slash.
    return lead + parts[0] + this.segs(parts.slice(1));
  }

  private segs(parts: string[]): string {
    return parts.map((p, i) => "/" + this.segment(p, i === parts.length - 1)).join("");
  }

  private segment(seg: string, last: boolean): string {
    if (KEEP_SEGMENTS.has(seg)) return seg;
    const known = this.segments.get(seg);
    if (known) return known;
    this.names.add(seg);
    const dot = seg.startsWith(".") ? "." : "";
    const ext = last ? (/\.[A-Za-z0-9]{1,8}$/.exec(seg.slice(dot.length))?.[0] ?? "") : "";
    const n = this.segments.size + 1;
    const fake = `${dot}${ext ? "f" : "d"}${n}${ext}`;
    this.segments.set(seg, fake);
    return fake;
  }

  /**
   * A number: a wall-clock epoch is shifted with the timestamps, a cost is
   * zeroed, a token count rounded. Anything else (counts, sizes, line
   * numbers) stays.
   */
  private number(v: number, key: string | null): number {
    if (!Number.isFinite(v)) return v;
    const epoch = this.epoch(v);
    if (epoch !== null) return epoch;
    if (key !== null && /cost/i.test(key)) return 0;
    if (key !== null && /tokens/i.test(key) && Number.isInteger(v) && v >= 100) return Math.round(v / 100) * 100;
    return v;
  }

  /** `v` shifted, when it is seconds or milliseconds since the epoch in 2020–2035. */
  private epoch(v: number): number | null {
    if (!Number.isInteger(v)) return null;
    if (v >= EPOCH_MS[0] && v < EPOCH_MS[1]) return v + this.shift(v);
    if (v >= EPOCH_S[0] && v < EPOCH_S[1]) return v + Math.round(this.shift(v * 1000) / 1000);
    return null;
  }

  /** The timestamp shift, fixed by the first time seen. */
  private shift(t: number): number {
    if (this.tsShift === null) this.tsShift = Date.UTC(2026, 0, 1) - t;
    return this.tsShift;
  }

  /** A digit-only string: an epoch is shifted, six digits or fewer kept, longer replaced. */
  private digits(s: string): string {
    if (s.length === 10 || s.length === 13) {
      const shifted = this.epoch(Number(s));
      if (shifted !== null) return String(shifted);
    }
    return s.length <= 6 ? s : this.digitWord(s);
  }

  /** A run of digits replaced: an epoch shifted, else a 9 and placeholder digits, never a time. */
  private digitWord(w: string): string {
    this.replaced.add(w);
    if (w.length === 10 || w.length === 13) {
      const shifted = this.epoch(Number(w));
      if (shifted !== null) return String(shifted);
    }
    let out = "9";
    for (let i = 1; i < w.length; i++) out += String((this.digitCount++ * 7 + 3) % 10);
    return out;
  }

  /** `YYYY-MM-DD`, or an ISO time in text, shifted with the timestamps. */
  private date(s: string): string {
    this.replaced.add(s);
    if (s.length > 10) {
      const t = Date.parse(s.endsWith("Z") ? s : `${s}Z`);
      if (Number.isNaN(t)) return "2026-01-01";
      const iso = new Date(t + this.shift(t)).toISOString();
      const out = s.includes(".") ? iso : iso.replace(/\.\d+Z$/, "Z");
      return s.endsWith("Z") ? out : out.slice(0, -1);
    }
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t)) return "2026-01-01";
    return new Date(t + this.shift(t)).toISOString().slice(0, 10);
  }

  private timestamp(s: string): string {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return this.text(s);
    const iso = new Date(t + this.shift(t)).toISOString();
    return s.includes(".") ? iso : iso.replace(/\.\d+Z$/, "Z");
  }
}

/** A 1×1 PNG. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Spans of text kept as they are (or with only their ids remapped). */
function keptSpans(s: string): { start: number; end: number; kind: "phrase" | "command" | "status" | "idtag" }[] {
  const spans: { start: number; end: number; kind: "phrase" | "command" | "status" | "idtag" }[] = [];
  for (const p of KEEP_PHRASES) {
    for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + p.length)) {
      spans.push({ start: i, end: i + p.length, kind: "phrase" });
    }
  }
  const tagged: [RegExp, "command" | "status" | "idtag"][] = [
    [/<command-name>[^<]*<\/command-name>/g, "command"],
    [/<status>[a-z_]{1,20}<\/status>/g, "status"],
    [new RegExp(`<(${ID_TAGS.join("|")})>[^<]*</\\1>`, "g"), "idtag"],
  ];
  for (const [re, kind] of tagged) {
    for (const m of s.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, kind });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: typeof spans = [];
  for (const sp of spans) {
    if (out.length > 0 && sp.start < out[out.length - 1].end) continue;
    out.push(sp);
  }
  return out;
}

/** Cut long text at a line boundary; cut long lines. */
function shorten(s: string, cap: number): string {
  let lines = s.split("\n");
  let cut = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    cut = true;
  }
  lines = lines.map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
  let total = 0;
  const kept: string[] = [];
  for (const l of lines) {
    if (total + l.length + 1 > cap) {
      cut = true;
      break;
    }
    kept.push(l);
    total += l.length + 1;
  }
  if (kept.length === 0 && lines.length > 0) kept.push(lines[0].slice(0, cap));
  return kept.join("\n") + (cut ? "\n…" : "");
}

/** The `i`th placeholder word of `n` characters. */
function placeholder(n: number, i: number): string {
  const exact = LOREM.filter((w) => w.length === n);
  if (exact.length > 0) return exact[i % exact.length];
  let out = "";
  let j = i;
  while (out.length < n) out += LOREM[j++ % LOREM.length];
  return out.slice(0, n);
}

/** `s` with each letter and digit replaced, by class, from the counter `n`. */
function sameShape(s: string, n: number): string {
  let x = (n * 2654435761) >>> 0;
  let out = "";
  for (const c of s) {
    x = (x * 1103515245 + 12345) >>> 0;
    const r = x >>> 16;
    if (/[0-9]/.test(c)) out += String(r % 10);
    else if (/[a-f]/.test(c) && /^[0-9a-f]+$/.test(s)) out += "0123456789abcdef"[r % 16];
    else if (/[a-z]/.test(c)) out += String.fromCharCode(97 + (r % 26));
    else if (/[A-Z]/.test(c)) out += String.fromCharCode(65 + (r % 26));
    else out += c;
  }
  return out;
}

/** How the leak check cuts text into tokens: words, then ids, then path segments. */
export const TOKEN_CUTS = [/[\p{L}\p{N}]{8,}/gu, /[\w-]{8,}/g, /[\w.@+-]{8,}/g];

export function leakHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Tokens a scrubbed fixture keeps by rule (keys, enum values, tool names,
 * markup tags, Claude Code's own phrases), cut as `TOKEN_CUTS` cuts. A
 * source token equal to one of these is schema, not a leak.
 */
export function keptVocabulary(lines: string[]): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    for (const re of TOKEN_CUTS) for (const m of s.matchAll(re)) out.add(m[0]);
  };
  KEEP_PHRASES.forEach(add);
  const walk = (v: unknown, key: string | null, parent: Record<string, unknown> | null): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key, parent));
    else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        add(k);
        walk(x, k, v);
      }
    } else if (typeof v === "string") {
      if (key !== null && ENUM_KEYS.has(key) && ENUM_VALUE.test(v)) add(v);
      else if (key === "name" && parent?.type === "tool_use") add(v);
      for (const m of v.matchAll(/<\/?([a-z][a-z0-9_-]*)/g)) add(m[1]);
      for (const m of v.matchAll(/<(status|command-name)>([^<]*)</g)) add(m[2]);
    }
  };
  for (const l of lines) {
    try {
      walk(JSON.parse(l), null, null);
    } catch {
      // not a line
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Where `--leaks` writes, and the leak test reads, by default. Gitignored. */
export const LOCAL_LEAK_HASHES = "electron/chat-mirror/__fixtures__/leak-hashes.local.json";

function main(argv: string[]): void {
  const [input, output] = argv;
  if (!input || !output) {
    console.error("usage: scrub-transcript.ts <in.jsonl> <out.jsonl> [--lines a:b] [--leaks [hashes.json]]");
    process.exit(2);
  }
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  let raw = fs.readFileSync(input, "utf8").split("\n");
  // Ranges of 0-based line numbers, end exclusive: `--lines 0:10,115:127`.
  const ranges = flag("--lines");
  if (ranges) {
    raw = ranges.split(",").flatMap((r) => {
      const [a, b] = r.split(":").map(Number);
      return raw.slice(a, b);
    });
  }
  const scrubber = new TranscriptScrubber();
  const { lines, dropped } = scrubber.scrubLines(raw);
  fs.writeFileSync(output, lines.map((l) => l + "\n").join(""));
  const leaksArg = flag("--leaks");
  const leaks = argv.includes("--leaks")
    ? leaksArg && !leaksArg.startsWith("--")
      ? leaksArg
      : LOCAL_LEAK_HASHES
    : undefined;
  if (leaks) {
    const prior: string[] = fs.existsSync(leaks) ? (JSON.parse(fs.readFileSync(leaks, "utf8")) as string[]) : [];
    const all = [...new Set([...prior, ...scrubber.leakHashes()])].sort();
    fs.writeFileSync(leaks, JSON.stringify(all, null, 0).replace(/,/g, ",\n") + "\n");
  }
  console.error(`${lines.length} lines written; dropped ${JSON.stringify(dropped)}`);
}

if (process.argv[1]?.endsWith("scrub-transcript.ts")) main(process.argv.slice(2));
