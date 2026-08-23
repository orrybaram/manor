/**
 * The phone client for ADR-161.
 *
 * Deliberately framework-free and self-contained. It ships over a tunnel under
 * `default-src 'none'`, so every byte it needs must come from the listener —
 * and a page that holds a bearer token is a page worth being able to read end
 * to end in one sitting.
 *
 * Four decisions worth knowing before editing:
 *
 *   - **The token lives in `localStorage`, never in the URL.** It arrives once
 *     in the fragment (which browsers do not send to the server), is moved to
 *     storage, and the fragment is stripped immediately so it cannot linger in
 *     history, a screenshot, or a share sheet.
 *   - **The event stream is read with `fetch`, not `EventSource`.**
 *     `EventSource` cannot set an `Authorization` header, and the alternative —
 *     a token in the query string — would write the credential into every
 *     proxy log between here and the machine. So we parse the SSE framing
 *     ourselves; it is about thirty lines.
 *   - **A screen is mounted once and then patched.** Rebuilding the tree on
 *     every update is what made a composer lose focus mid-sentence and a
 *     transcript jump while it was being read. Each screen owns its nodes and
 *     exposes an `update()`; nothing above it re-creates them.
 *   - **Nothing here asks to be refreshed.** The stream drives updates, a poll
 *     backs it up, and an open transcript re-reads itself — a phone glanced at
 *     is a phone showing what is true now.
 */

import { renderAnsi, trimBlankRows } from "./ansi";

const TOKEN_KEY = "manor.remote.token";

/** How often an open transcript re-reads itself. */
const TRANSCRIPT_MS = 1_500;
/** How often the session list re-reads itself, under the live stream. */
const LIST_MS = 5_000;

interface TaskSummary {
  id: string;
  name: string | null;
  status: string;
  lastAgentStatus: string | null;
  projectName: string | null;
  paneId: string | null;
  updatedAt: string;
}

interface Identity {
  id: string;
  label: string;
  canSend: boolean;
  /** Application server key; null when this machine cannot store one. */
  vapidPublicKey: string | null;
}

interface Screen {
  update(): void;
  dispose?(): void;
}

/** Blocked first — being told what needs attention is the whole point. */
const STATUS_RANK: Record<string, number> = {
  requires_input: 0,
  error: 1,
  responded: 2,
  working: 3,
  thinking: 4,
  complete: 5,
  idle: 6,
};

const app = document.getElementById("app")!;
const bar = el("header", "bar");
const body = el("div", "body");
app.append(bar, body);

let token = readToken();
let identity: Identity | null = null;
let tasks: TaskSummary[] = [];
let transcript: { taskId: string; text: string } | null = null;
let notice: { text: string; tone: "ok" | "warn" } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let live = false;
/** The task whose transcript is on screen, or null on the list. */
let openTaskId: string | null = null;
let screen: Screen = { update() {} };

// ── Token ──

/**
 * Take the token out of the fragment on first load and put it somewhere the
 * address bar cannot leak.
 */
function readToken(): string | null {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (fragment) {
    try {
      localStorage.setItem(TOKEN_KEY, fragment);
    } catch {
      // Private mode: keep it in memory for this session only.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return fragment;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function forgetToken(): void {
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
  show(mountUnpaired());
}

// ── Transport ──

async function api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  if (!token) return null;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401) {
    // A revoked device must stop retrying and say so, not spin.
    forgetToken();
    return null;
  }
  if (!res.ok) {
    // A failure notice is about the last call, not the app: it expires, and
    // the next call that works clears it.
    setNotice(`Request failed (${res.status})`, "warn");
    return null;
  }
  if (notice?.tone === "warn") setNotice(null);
  return (await res.json()) as T;
}

async function loadIdentity(): Promise<void> {
  identity = await api<Identity>("/me");
  screen.update();
}

async function loadTasks(): Promise<void> {
  const next = await api<TaskSummary[]>("/tasks");
  if (!next) return;
  tasks = next;
  screen.update();
}

async function loadTranscript(taskId: string): Promise<void> {
  const payload = await api<{ text: string }>("/sessions/read", {
    method: "POST",
    // `raw` keeps the escape sequences: this is a terminal, and it is rendered
    // as one. `tailLines` is what a phone can plausibly scroll.
    body: JSON.stringify({ target: taskId, tailLines: 400, raw: true }),
  });
  if (!payload) return;
  // A late reply for a session the user has already left must not overwrite
  // what they are looking at now.
  if (openTaskId !== taskId) return;
  transcript = { taskId, text: trimBlankRows(payload.text) };
  screen.update();
}

// ── Live updates ──

/**
 * Read `GET /events` as a stream, reconnecting with a capped backoff. Status
 * transitions arrive here first; the polls below are what cover everything
 * else (a rename, a session that started while the stream was down) and what
 * keeps the client honest if the stream never comes back.
 */
async function watch(): Promise<void> {
  let backoff = 1000;
  for (;;) {
    if (!token) return;
    try {
      const res = await fetch("/events", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        forgetToken();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      setLive(true);
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; comments (": ping") carry
        // no event and are skipped by the `event:` check below.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.includes("event: status")) {
            void loadTasks();
            if (openTaskId) void loadTranscript(openTaskId);
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Fall through to the backoff below.
    }
    setLive(false);
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

function setLive(value: boolean): void {
  if (live === value) return;
  live = value;
  screen.update();
}

// ── Push ──

/** base64url → the `Uint8Array` `pushManager.subscribe` wants. */
function decodeKey(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Subscribe this device for push, if it can. Every step is allowed to fail
 * quietly: no service worker, no push support, permission denied, or a machine
 * with no signing key all mean "no push", never "no app".
 */
async function enablePush(): Promise<void> {
  const key = identity?.vapidPublicKey;
  if (!key) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (Notification.permission === "denied") return;

  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    if (Notification.permission === "default") {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") return;
    }
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
      }));
    await api("/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch {
    // Push is a bonus on top of the live stream, never a prerequisite.
  }
}

// ── DOM helpers ──

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusOf(task: TaskSummary): string {
  return task.lastAgentStatus ?? "idle";
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * The status glyph, matching `AgentDot` on the desktop: a waving hand for a
 * session that wants you, a spinner while it works, a green pulse when it has
 * just answered. Same vocabulary, so the phone needs no learning.
 */
function glyph(status: string): HTMLElement {
  const node = el("span", `glyph ${status}`);
  if (status === "requires_input") node.textContent = "👋";
  else if (status === "working" || status === "thinking")
    node.append(el("span", "spinner"));
  else if (status === "complete") {
    const mark = el("span", "dot", "✓");
    node.append(mark);
  } else node.append(el("span", "dot"));
  return node;
}

/** "2m", "3h" — enough to know whether a session has been waiting a while. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function liveIndicator({ compact = false } = {}): HTMLElement {
  const node = el(
    "span",
    `live${live ? "" : " off"}${compact ? " compact" : ""}`,
    live ? "live" : "…",
  );
  node.title = live
    ? "Connected to the live event stream"
    : "Reconnecting to the live event stream";
  return node;
}

function noticeBanner(): HTMLElement | null {
  if (!notice) return null;
  return el("div", `banner ${notice.tone}`, notice.text);
}

function setNotice(text: string | null, tone: "ok" | "warn" = "ok"): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  notice = text === null ? null : { text, tone };
  screen.update();
  if (text !== null) {
    noticeTimer = setTimeout(() => {
      notice = null;
      screen.update();
    }, 4000);
  }
}

/** Swap the visible screen, letting the old one drop its timers. */
function show(next: Screen): void {
  screen.dispose?.();
  screen = next;
  screen.update();
}

// ── Screens ──

function mountUnpaired(): Screen {
  bar.replaceChildren(el("h1", undefined, "Manor"));
  const box = el("div", "empty");
  box.append(
    el("strong", undefined, "This device is not paired"),
    el(
      "span",
      undefined,
      "Open Manor → Settings → Remote control and pair it again to get a new link.",
    ),
  );
  body.replaceChildren(box);
  return { update() {} };
}

function mountList(): Screen {
  const heading = el("h1", undefined, "Sessions");
  const list = el("ul", "sessions");
  const timer = setInterval(() => void loadTasks(), LIST_MS);

  const update = () => {
    const sub = identity ? el("span", "sub", identity.label) : null;
    bar.replaceChildren(heading, ...(sub ? [sub] : []), liveIndicator());

    const banner = noticeBanner();
    if (tasks.length === 0) {
      const empty = el("div", "empty");
      empty.append(
        el("strong", undefined, "No active sessions"),
        el(
          "span",
          undefined,
          "Start an agent in Manor and it will appear here on its own.",
        ),
      );
      body.replaceChildren(...(banner ? [banner] : []), empty);
      return;
    }

    list.replaceChildren(
      ...[...tasks]
        .sort((a, b) => rank(a) - rank(b))
        .map((task) => sessionRow(task)),
    );
    body.replaceChildren(...(banner ? [banner] : []), list);
  };

  return {
    update,
    dispose: () => clearInterval(timer),
  };
}

function rank(task: TaskSummary): number {
  return STATUS_RANK[statusOf(task)] ?? 6;
}

function sessionRow(task: TaskSummary): HTMLElement {
  const status = statusOf(task);
  const item = el(
    "li",
    `session${status === "requires_input" ? " blocked" : ""}${
      status === "error" ? " error" : ""
    }`,
  );
  item.append(glyph(status));

  const name = el("div", "session-name");
  name.append(el("strong", undefined, task.name ?? task.id));
  name.append(
    el(
      "span",
      "meta",
      [task.projectName, statusLabel(status), ago(task.updatedAt)]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  item.append(name, el("span", "chev", "›"));

  item.addEventListener("click", () => openSession(task));
  return item;
}

function openSession(task: TaskSummary): void {
  openTaskId = task.id;
  transcript = null;
  show(mountDetail(task.id));
  void loadTranscript(task.id);
}

function backToList(): void {
  openTaskId = null;
  transcript = null;
  show(mountList());
  void loadTasks();
}

function mountDetail(taskId: string): Screen {
  const back = el("button", "back", "Back");
  back.addEventListener("click", backToList);

  const heading = el("h1");
  const terminal = el("pre", "terminal empty");
  // The transcript lives in a child so the `pre` can stay a flex column that
  // pins output to the bottom, the way a shell fills upward from its prompt.
  const stream = el("code", "stream");
  terminal.append(stream);
  stream.textContent = "Loading…";

  const composer = el("div", "composer");
  const input = el("input");
  input.placeholder = "Send to this session";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  const send = el("button", "primary", "Send");
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    const task = taskById(taskId);
    if (!task) return;
    confirmSend(task, text, () => {
      input.value = "";
    });
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  composer.append(input, send);

  // The transcript re-reads itself while it is open. An agent's reply lands a
  // second or two after a send, and a phone should not have to be asked.
  const timer = setInterval(() => void loadTranscript(taskId), TRANSCRIPT_MS);

  const update = () => {
    const task = taskById(taskId);
    const status = task ? statusOf(task) : "idle";
    heading.textContent = task?.name ?? taskId;
    bar.replaceChildren(
      back,
      heading,
      el("span", `pill ${status}`, statusLabel(status)),
      liveIndicator({ compact: true }),
    );

    if (transcript?.taskId === taskId) {
      paintTerminal(terminal, stream, transcript.text);
    }

    const banner = noticeBanner();
    body.replaceChildren(
      ...(banner ? [banner] : []),
      terminal,
      ...(identity?.canSend ? [composer] : []),
    );
  };

  return {
    update,
    dispose: () => clearInterval(timer),
  };
}

function taskById(id: string): TaskSummary | null {
  return tasks.find((task) => task.id === id) ?? null;
}

/**
 * Repaint the transcript without moving the reader.
 *
 * Anyone scrolled up is reading something; anyone at the bottom is watching
 * the session, and wants to stay there as output arrives. Both are preserved
 * by measuring before the swap and restoring after it.
 */
function paintTerminal(
  pre: HTMLElement,
  stream: HTMLElement,
  text: string,
): void {
  const wasEmpty = pre.classList.contains("empty");
  const stick =
    wasEmpty || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  const previous = pre.scrollTop;

  pre.classList.remove("empty");
  renderAnsi(text, stream);

  pre.scrollTop = stick ? pre.scrollHeight : previous;
}

/**
 * The client-side half of ADR-161 §4: the exact text and the exact session, in
 * front of the user, before anything is typed into a live shell. The server
 * rejects a send that does not carry `confirmed: true`, so this cannot be
 * skipped by a client that forgets to ask.
 */
function confirmSend(
  task: TaskSummary,
  text: string,
  onSent: () => void,
): void {
  const sheet = el("div", "sheet");
  const inner = el("div", "sheet-inner");
  inner.append(
    el("h2", undefined, `Send to ${task.name ?? task.id}?`),
    el(
      "p",
      undefined,
      "This types into a live shell, and interrupts whatever the agent is doing.",
    ),
    el("code", undefined, text),
  );

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "ghost", "Cancel");
  cancel.addEventListener("click", () => sheet.remove());
  const send = el("button", "danger", "Send");
  send.addEventListener("click", () => {
    sheet.remove();
    void (async () => {
      const result = await api<{ ok: boolean }>("/sessions/send", {
        method: "POST",
        body: JSON.stringify({ target: task.id, text, confirmed: true }),
      });
      if (!result) return;
      onSent();
      setNotice("Sent.", "ok");
      void loadTranscript(task.id);
    })();
  });
  actions.append(cancel, send);
  inner.append(actions);
  sheet.append(inner);
  // On `document.body`, not the screen: the sheet is a fixed overlay, and it
  // must survive anything that repaints the screen underneath it.
  document.body.append(sheet);
}

// ── Boot ──

async function main(): Promise<void> {
  if (!token) {
    show(mountUnpaired());
    return;
  }
  show(mountList());
  await loadIdentity();
  await loadTasks();
  void watch();
  void enablePush();

  // Tapping a push notification asks the page to open that session.
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const data = event.data as { type?: string; taskId?: string } | null;
    if (data?.type !== "open-task" || !data.taskId) return;
    const task = taskById(data.taskId);
    if (task) openSession(task);
  });
}

void main();
