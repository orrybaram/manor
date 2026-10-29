/**
 * pi's Sessions: `<root>/--<encoded cwd>--/<timestamp>_<session-id>.jsonl`,
 * where `<root>` is `$PI_CODING_AGENT_SESSION_DIR`, else the `sessionDir`
 * in the agent dir's `settings.json`, else `<agent dir>/sessions`; the
 * agent dir is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. pi writes a
 * custom session directory flat (no per-cwd directories), so files directly
 * under the root are read too.
 *
 * What this reads, as of pi-mono `session-manager.ts` (format version 3):
 * - line 1 is the header `{type:"session", version, id, timestamp, cwd,
 *   parentSession?}`; `parentSession` is the path of the file it was forked
 *   from. A file whose first line is not a header is not a Session (pi
 *   skips it too);
 * - `message` entries carry `message: {role, content, …}`; content is a
 *   string or blocks (`{type:"text", text}` among others); an assistant
 *   message names its `model`;
 * - `model_change` (`modelId`) is the model the user picked;
 * - `session_info` (`name`) is the name the user gave it; the latest one
 *   wins, and an empty name clears it. Read from the head too, so a name
 *   given early survives a tail window that no longer holds it.
 *
 * The directory name encodes the cwd lossily (`-` stands for `/`, `\`, `:`
 * and itself), so the cwd always comes from the header.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { LOCAL_HOST_ID } from "../backend/types";
import { readJsonlWindows } from "./jsonl-window";
import { bareSummary, sessionRecordId } from "./summary";
import type { SessionEnv, SessionReader, SessionSummary } from "./types";

/** `path` with a leading `~` made the host's home, as pi does. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** pi's agent dir on the host `env` describes: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
function piAgentDir({ home, env }: SessionEnv): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  return agentDir ? expandHome(agentDir, home) : join(home, ".pi", "agent");
}

/**
 * Where pi keeps its sessions on the host `env` describes, given the
 * `sessionDir` its `settings.json` names (a relative one is taken under the
 * agent dir).
 */
export function piSessionsDir(at: SessionEnv, settingsSessionDir: string | null = null): string {
  const sessionDir = at.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return expandHome(sessionDir, at.home);
  const agentDir = piAgentDir(at);
  const fromSettings = settingsSessionDir?.trim();
  if (fromSettings) return resolve(agentDir, expandHome(fromSettings, at.home));
  return join(agentDir, "sessions");
}

/** The `sessionDir` in pi's `settings.json`, or null when it names none or can't be read. */
async function settingsSessionDir(at: SessionEnv): Promise<string | null> {
  try {
    const settings: unknown = JSON.parse(await readFile(join(piAgentDir(at), "settings.json"), "utf8"));
    return isRec(settings) && typeof settings.sessionDir === "string" ? settings.sessionDir : null;
  } catch {
    return null;
  }
}

/**
 * The session id in a session file's name (`<timestamp>_<id>.jsonl`): the
 * timestamp has `:` and `.` replaced by `-`, so it holds no `_`.
 */
export function piSessionIdFromPath(path: string): string | null {
  const name = basename(path, ".jsonl");
  const at = name.indexOf("_");
  return at > 0 && at < name.length - 1 ? name.slice(at + 1) : null;
}

const FIRST_PROMPT_MAX = 1000;
const TITLE_MAX = 200;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A `message` entry's message, when its role is `role`. */
function messageOf(record: Rec, role: string): Rec | null {
  if (record.type !== "message" || !isRec(record.message)) return null;
  return record.message.role === role ? record.message : null;
}

/** The text of a message's `content`, joined as pi joins it. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Rec => isRec(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

function userPrompt(record: Rec): string | null {
  const message = messageOf(record, "user");
  const text = message ? contentText(message.content).trim() : "";
  return text ? capped(text, FIRST_PROMPT_MAX) : null;
}

function modelOf(record: Rec): string | null {
  const assistant = messageOf(record, "assistant");
  if (assistant) return str(assistant.model);
  return record.type === "model_change" ? str(record.modelId) : null;
}

/** `text` on one line, short enough to be a title. */
function asTitle(text: string): string {
  return capped(text.replace(/\s+/g, " ").trim(), TITLE_MAX);
}

/** One session file's summary, from its head and tail; null when it does not open with a header. */
export function summarizePiSession(
  path: string,
  mtimeMs: number,
  head: readonly unknown[],
  tail: readonly unknown[],
): SessionSummary | null {
  const header = head[0];
  if (!isRec(header) || header.type !== "session") return null;
  const sessionId = str(header.id) ?? piSessionIdFromPath(path);
  if (!sessionId) return null;
  const parentPath = str(header.parentSession);
  const parentSessionId = parentPath ? piSessionIdFromPath(parentPath) : null;

  let firstPrompt: string | null = null;
  let headModel: string | null = null;
  // The latest name seen, top then bottom; `undefined` until a `session_info` is seen.
  let name: string | null | undefined;
  const nameOf = (record: Rec): void => {
    // An empty name clears the one before it.
    if (record.type === "session_info") name = typeof record.name === "string" ? record.name.trim() || null : null;
  };
  for (const record of head) {
    if (!isRec(record)) continue;
    firstPrompt ??= userPrompt(record);
    headModel ??= modelOf(record);
    nameOf(record);
  }
  // The latest of each, from the bottom.
  let tailModel: string | null = null;
  for (const record of tail) {
    if (!isRec(record)) continue;
    nameOf(record);
    tailModel = modelOf(record) ?? tailModel;
  }

  const updatedAt = new Date(mtimeMs).toISOString();
  return {
    id: sessionRecordId("pi", sessionId),
    hostId: LOCAL_HOST_ID,
    kind: "pi",
    sessionId,
    title: asTitle(name ?? firstPrompt ?? ""),
    firstPrompt: firstPrompt ?? "",
    cwd: str(header.cwd) ?? "",
    gitBranch: null,
    createdAt: str(header.timestamp) ?? updatedAt,
    updatedAt,
    messageCount: null,
    model: tailModel ?? headModel,
    path,
    parentSessionId: parentSessionId === sessionId ? null : parentSessionId,
  };
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  summary: SessionSummary | null;
}

/** Let the event loop run between files: a large store must not hold up the server. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function dirEntries(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // No store yet, or a directory removed mid-scan.
    return [];
  }
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.startsWith(".");
}

/** The session files under `root`: directly in it (a custom session dir) and one directory down. */
async function sessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await dirEntries(root)) {
    const path = join(root, entry.name);
    if (entry.isFile() && isSessionFile(entry.name)) out.push(path);
    else if (entry.isDirectory()) {
      for (const file of await dirEntries(path)) {
        if (file.isFile() && isSessionFile(file.name)) out.push(join(path, file.name));
      }
    }
  }
  return out;
}

/** pi's reader, with its own cache by path: a file whose size and mtime are unchanged is not read again. */
export function createPiReader(): SessionReader {
  const cache = new Map<string, CacheEntry>();
  return {
    kind: "pi",
    async list(env) {
      const seen = new Set<string>();
      const out: SessionSummary[] = [];
      for (const path of await sessionFiles(piSessionsDir(env, await settingsSessionDir(env)))) {
        let info;
        try {
          info = await stat(path);
        } catch {
          continue; // Gone since the listing.
        }
        seen.add(path);
        const cached = cache.get(path);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
          if (cached.summary) out.push(cached.summary);
          continue;
        }
        let summary: SessionSummary | null;
        try {
          const { head, tail, capped } = await readJsonlWindows(path, info.size);
          summary = summarizePiSession(path, info.mtimeMs, head, tail);
          // A header too long to read is no sign the file is not a Session.
          const id = capped && !summary && head.length === 0 ? piSessionIdFromPath(path) : null;
          if (id) summary = bareSummary("pi", id, path, info.mtimeMs);
        } catch {
          // Unreadable now; the next scan tries again.
          continue;
        }
        cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, summary });
        if (summary) out.push(summary);
        await yieldToLoop();
      }
      for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
      return out;
    },
  };
}
