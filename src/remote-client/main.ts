/**
 * The phone client for ADR-161.
 *
 * Deliberately framework-free and self-contained. It ships over a tunnel under
 * `default-src 'none'`, so every byte it needs must come from the listener —
 * and a page that holds a bearer token is a page worth being able to read end
 * to end in one sitting.
 *
 * Two decisions worth knowing before editing:
 *
 *   - **The token lives in `localStorage`, never in the URL.** It arrives once
 *     in the fragment (which browsers do not send to the server), is moved to
 *     storage, and the fragment is stripped immediately so it cannot linger in
 *     history, a screenshot, or a share sheet.
 *   - **The event stream is read with `fetch`, not `EventSource`.**
 *     `EventSource` cannot set an `Authorization` header, and the alternative —
 *     a token in the query string — would write the credential into every
 *     proxy log between here and the machine. So we parse the SSE framing
 *     ourselves; it is about thirty lines, and the reconnect logic was needed
 *     for the polling fallback anyway.
 */

const TOKEN_KEY = "manor.remote.token";

interface TaskSummary {
  id: string;
  name: string | null;
  status: string;
  lastAgentStatus: string | null;
  projectName: string | null;
  paneId: string | null;
}

interface Identity {
  id: string;
  label: string;
  canSend: boolean;
  /** Application server key; null when this machine cannot store one. */
  vapidPublicKey: string | null;
}

type View = { kind: "list" } | { kind: "detail"; task: TaskSummary };

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

let token = readToken();
let identity: Identity | null = null;
let tasks: TaskSummary[] = [];
let view: View = { kind: "list" };
let notice: string | null = null;
let unauthorized = false;

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
  unauthorized = true;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

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
    render();
    return null;
  }
  if (!res.ok) {
    notice = `Request failed (${res.status})`;
    render();
    return null;
  }
  return (await res.json()) as T;
}

// ── Data ──

async function loadIdentity(): Promise<void> {
  identity = await api<Identity>("/me");
}

async function loadTasks(): Promise<void> {
  const next = await api<TaskSummary[]>("/tasks");
  if (!next) return;
  tasks = next;
  render();
}

function rank(task: TaskSummary): number {
  return STATUS_RANK[task.lastAgentStatus ?? "idle"] ?? 6;
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

// ── Live updates ──

/**
 * Read `GET /events` as a stream. Any failure falls back to polling and keeps
 * retrying the stream with a capped backoff, so a phone that slept for an hour
 * comes back on its own.
 */
async function watch(): Promise<void> {
  let backoff = 1000;
  let polling: ReturnType<typeof setInterval> | null = null;

  const startPolling = () => {
    if (polling) return;
    polling = setInterval(() => void loadTasks(), 5000);
  };
  const stopPolling = () => {
    if (!polling) return;
    clearInterval(polling);
    polling = null;
  };

  for (;;) {
    if (!token) return;
    try {
      const res = await fetch("/events", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        forgetToken();
        render();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      stopPolling();
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; comments (": ping") carry
        // no event and are simply skipped by the `event:` check below.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.includes("event: status")) void loadTasks();
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Fall through to the backoff below.
    }
    startPolling();
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

// ── Rendering ──

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

function render(): void {
  app.replaceChildren();

  if (unauthorized || !token) {
    const banner = el(
      "div",
      "banner warn",
      "This device is not paired. Open Manor → Settings → Remote control and " +
        "pair it again to get a new link.",
    );
    app.append(banner);
    return;
  }

  if (notice) {
    const banner = el("div", "banner", notice);
    app.append(banner);
  }

  if (view.kind === "list") renderList();
  else renderDetail(view.task);
}

function renderList(): void {
  const header = el("header");
  header.append(el("h1", undefined, "Sessions"));
  if (identity) header.append(el("span", "muted", identity.label));
  app.append(header);

  if (tasks.length === 0) {
    app.append(el("div", "banner", "No active sessions."));
    return;
  }

  const list = el("ul", "sessions");
  for (const task of [...tasks].sort((a, b) => rank(a) - rank(b))) {
    const status = task.lastAgentStatus ?? "idle";
    const item = el("li", `session${rank(task) <= 1 ? " blocked" : ""}`);
    item.append(el("span", `dot ${status}`));

    const name = el("div", "session-name");
    name.append(el("strong", undefined, task.name ?? task.id));
    name.append(
      el(
        "span",
        "muted",
        [task.projectName, status.replace(/_/g, " ")]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    item.append(name);

    item.addEventListener("click", () => {
      view = { kind: "detail", task };
      render();
      void openDetail(task);
    });
    list.append(item);
  }
  app.append(list);
}

async function openDetail(task: TaskSummary): Promise<void> {
  const body = await api<{ text: string }>("/sessions/read", {
    method: "POST",
    body: JSON.stringify({ target: task.id, tailLines: 400 }),
  });
  if (!body) return;
  const pre = document.querySelector<HTMLPreElement>("pre.scrollback");
  if (!pre) return;
  pre.textContent = body.text;
  pre.scrollTop = pre.scrollHeight;
}

function renderDetail(task: TaskSummary): void {
  const header = el("header");
  const back = el("button", undefined, "Back");
  back.addEventListener("click", () => {
    view = { kind: "list" };
    render();
  });
  header.append(back);
  header.append(el("h1", undefined, task.name ?? task.id));
  app.append(header);

  const pre = el("pre", "scrollback", "Loading…");
  app.append(pre);

  const refresh = el("button", undefined, "Refresh");
  refresh.addEventListener("click", () => void openDetail(task));

  if (identity?.canSend) {
    const composer = el("div", "composer");
    const input = el("input");
    input.placeholder = "Send to this session";
    const send = el("button", "primary", "Send");
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      confirmSend(task, text, () => {
        input.value = "";
      });
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    composer.append(input, send);
    app.append(composer);
  }

  const row = el("div", "composer");
  row.append(refresh);
  app.append(row);
}

/**
 * The client-side half of ADR-161 §4: the exact text and the exact target, in
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
    el("h1", undefined, "Send to " + (task.name ?? task.id) + "?"),
    el(
      "p",
      "muted",
      "This types into a live shell. Interrupts whatever the agent is doing.",
    ),
  );
  const code = el("code", undefined, text);
  inner.append(code);

  const actions = el("div", "sheet-actions");
  const cancel = el("button", undefined, "Cancel");
  cancel.addEventListener("click", () => sheet.remove());
  const send = el("button", "danger", "Send");
  send.addEventListener("click", () => {
    sheet.remove();
    void (async () => {
      const result = await api<{ ok: boolean }>("/sessions/send", {
        method: "POST",
        body: JSON.stringify({ target: task.id, text, confirmed: true }),
      });
      if (result) {
        onSent();
        notice = "Sent.";
        render();
        void openDetail(task);
      }
    })();
  });
  actions.append(cancel, send);
  inner.append(actions);
  sheet.append(inner);
  app.append(sheet);
}

// ── Boot ──

async function main(): Promise<void> {
  render();
  if (!token) return;
  await loadIdentity();
  await loadTasks();
  render();
  void watch();
  void enablePush();

  // Tapping a push notification asks the page to open that session.
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const data = event.data as { type?: string; taskId?: string } | null;
    if (data?.type !== "open-task" || !data.taskId) return;
    const task = tasks.find((t) => t.id === data.taskId);
    if (!task) return;
    view = { kind: "detail", task };
    render();
    void openDetail(task);
  });
}

void main();
