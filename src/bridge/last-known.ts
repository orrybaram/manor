/**
 * Each server's last merged answers, kept across reloads (ADR-228 D6).
 *
 * The router (`./router.ts`) keeps every server's last answer to each merged
 * read in memory, and answers with it while that server is away. On the
 * phone that memory has to outlive the page: a reload with the desktop asleep
 * should still show its projects, dimmed, rather than nothing. So the phone
 * hands the router this store, which keeps the answers in IndexedDB, one
 * record per server (on the phone a server's id is its relay room).
 *
 * Storage may be missing or refused (private browsing, a full disk, a
 * browser that blocks IndexedDB in a frame): every read and write is wrapped,
 * and a store that cannot open simply remembers nothing. Writes are batched
 * per server and land a moment later; a page that closes first loses only
 * that moment's answers.
 */

/** What the router reads and writes. Never throws, never rejects. */
export interface LastKnownStore {
  /** `serverId`'s saved answers, by call; empty when none or unreadable. */
  read(serverId: string): Promise<ReadonlyMap<string, unknown>>;
  /** Save `value` as `serverId`'s answer to the call `memo`. */
  write(serverId: string, memo: string, value: unknown): void;
  /** Drop everything saved for `serverId`: its pairing is gone. */
  forget(serverId: string): void;
}

/** One server's answers as stored: call → answer. */
type Saved = Record<string, unknown>;

/** Where the records live: IndexedDB, or a stand-in in tests. */
export interface LastKnownBackend {
  get(serverId: string): Promise<Saved | undefined>;
  put(serverId: string, saved: Saved): Promise<void>;
  delete(serverId: string): Promise<void>;
}

const DB_NAME = "manor-last-known";
const STORE = "servers";
const WRITE_DELAY_MS = 500;

/** `request` as a promise. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * IndexedDB, or null where there is none. Opened lazily, once; an open that
 * fails leaves every later call a no-op.
 */
export function indexedDbBackend(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
): LastKnownBackend | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return opening;
  };
  const store = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(serverId) {
      const value: unknown = await settled((await store("readonly")).get(serverId));
      return typeof value === "object" && value !== null ? (value as Saved) : undefined;
    },
    async put(serverId, saved) {
      await settled((await store("readwrite")).put(saved, serverId));
    },
    async delete(serverId) {
      await settled((await store("readwrite")).delete(serverId));
    },
  };
}

/** The router's store over `backend`; with none, one that remembers nothing. */
export function createLastKnownStore(
  backend: LastKnownBackend | null = safely(() => indexedDbBackend()) ?? null,
  delayMs = WRITE_DELAY_MS,
): LastKnownStore {
  /** Answers not written yet, by server. */
  const dirty = new Map<string, Saved>();
  /** What is (or is about to be) stored, by server, once read. */
  const held = new Map<string, Promise<Saved>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function load(serverId: string): Promise<Saved> {
    let saved = held.get(serverId);
    if (!saved) {
      saved = backend
        ? guard(() => backend.get(serverId)).then((value) => ({ ...(value ?? {}) }))
        : Promise.resolve({});
      held.set(serverId, saved);
    }
    return saved;
  }

  function flush(serverId: string): void {
    timers.delete(serverId);
    const answers = dirty.get(serverId);
    dirty.delete(serverId);
    if (!answers || !backend) return;
    void load(serverId).then((saved) => {
      Object.assign(saved, answers);
      return guard(() => backend.put(serverId, saved));
    });
  }

  return {
    async read(serverId) {
      const saved = await load(serverId);
      return new Map(Object.entries({ ...saved, ...dirty.get(serverId) }));
    },

    write(serverId, memo, value) {
      if (!backend) return;
      const answers = dirty.get(serverId) ?? {};
      answers[memo] = value;
      dirty.set(serverId, answers);
      if (!timers.has(serverId)) {
        timers.set(serverId, setTimeout(() => flush(serverId), delayMs));
      }
    },

    forget(serverId) {
      const timer = timers.get(serverId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(serverId);
      dirty.delete(serverId);
      held.delete(serverId);
      if (backend) void guard(() => backend.delete(serverId));
    },
  };
}

/** `fn`'s answer, or undefined if it threw. */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** `fn`'s promise, settled to undefined on any failure, sync or async. */
async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.warn("[last-known] storage is unavailable:", err);
    return undefined;
  }
}
