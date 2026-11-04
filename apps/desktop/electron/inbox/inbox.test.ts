import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INBOX_TYPES, type InboxKind } from "../../src/lib/inbox";
import {
  createGitHubSource,
  parseInboxResponse,
  repoFromOrigin,
  threadPageUrl,
  threadToItem,
  type GitHubThread,
} from "./github-source";
import { InboxPoller, MAX_BANNERS_PER_CHECK, type InboxItem, type InboxSource } from "./inbox-poller";
import { nodeToItem, type LinearNotificationNode } from "./linear-source";
import { ProjectScope } from "./project-scope";

function thread(over: Partial<GitHubThread> & { number?: number } = {}): GitHubThread {
  const { number = 7, ...rest } = over;
  return {
    id: "100",
    reason: "review_requested",
    repository: { full_name: "Acme/App" },
    subject: {
      title: "Fix it",
      type: "PullRequest",
      url: `https://api.github.com/repos/Acme/App/pulls/${number}`,
    },
    ...rest,
  };
}

function item(key: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    key,
    kind: "github-review-requested",
    inScope: true,
    title: key,
    body: "",
    url: null,
    ...over,
  };
}

describe("repoFromOrigin", () => {
  it.each([
    ["git@github.com:Acme/App.git", "acme/app"],
    ["git@github-work:Acme/App.git", "acme/app"],
    ["ssh://git@github.com/Acme/App", "acme/app"],
    ["https://github.com/Acme/App.git", "acme/app"],
    ["https://token@github.com/Acme/App/", "acme/app"],
  ])("reads %s", (origin, repo) => {
    expect(repoFromOrigin(origin)).toBe(repo);
  });

  it("gives null for a bare name", () => {
    expect(repoFromOrigin("origin")).toBeNull();
  });
});

describe("threadPageUrl", () => {
  it("converts pull and issue API URLs", () => {
    expect(threadPageUrl(thread())).toBe("https://github.com/Acme/App/pull/7");
    expect(
      threadPageUrl(
        thread({
          subject: { title: "t", type: "Issue", url: "https://api.github.com/repos/Acme/App/issues/9" },
        }),
      ),
    ).toBe("https://github.com/Acme/App/issues/9");
  });

  it("falls back to the repo, or its security tab, without a page to convert", () => {
    const noUrl = { title: "t", type: "Release", url: null };
    expect(threadPageUrl(thread({ subject: noUrl }))).toBe("https://github.com/Acme/App");
    expect(threadPageUrl(thread({ reason: "security_alert", subject: noUrl }))).toBe(
      "https://github.com/Acme/App/security",
    );
  });
});

describe("threadToItem", () => {
  const repos = new Set(["acme/app"]);

  it("maps each offered reason to its kind", () => {
    for (const type of INBOX_TYPES.filter((t) => t.source === "github")) {
      expect(threadToItem(thread({ reason: type.upstream }), repos).kind).toBe(type.kind);
    }
  });

  it.each(["subscribed", "comment", "ci_activity", "author", "state_change"])(
    "offers no kind for %s, which PR notifications or noise cover",
    (reason) => {
      expect(threadToItem(thread({ reason }), repos).kind).toBeNull();
    },
  );

  it("is in scope only for a project's repo, ignoring case", () => {
    expect(threadToItem(thread(), repos).inScope).toBe(true);
    expect(
      threadToItem(thread({ repository: { full_name: "Other/Repo" } }), repos).inScope,
    ).toBe(false);
  });

  it("titles a review request with its number and the body with the repo", () => {
    expect(threadToItem(thread(), repos)).toMatchObject({
      title: "Review requested: #7",
      body: "App · Fix it",
    });
  });

  it("keys on thread and reason", () => {
    expect(threadToItem(thread(), repos).key).toBe("100:review_requested");
  });
});

describe("parseInboxResponse", () => {
  const head = "HTTP/2.0 200 OK\r\nLast-Modified: Wed, 04 Nov 2026 16:00:00 GMT\r\nX-Poll-Interval: 120\r\n\r\n";

  it("reads a 200", () => {
    expect(parseInboxResponse(`${head}[{"id":"1"}]`)).toEqual({
      status: "ok",
      threads: [{ id: "1" }],
      lastModified: "Wed, 04 Nov 2026 16:00:00 GMT",
      pollSeconds: 120,
    });
  });

  it("reads a 304", () => {
    expect(parseInboxResponse("HTTP/2.0 304 Not Modified\r\nX-Poll-Interval: 60\r\n\r\n")).toEqual({
      status: "not-modified",
      pollSeconds: 60,
    });
  });

  it("throws on an error status", () => {
    expect(() => parseInboxResponse("HTTP/2.0 403 Forbidden\r\n\r\n{}")).toThrow("403");
  });

  it("throws on output with no status", () => {
    expect(() => parseInboxResponse("gh: not logged in")).toThrow();
  });
});

describe("createGitHubSource", () => {
  it("never polls faster than a minute, even if GitHub allows it", async () => {
    const source = createGitHubSource({
      isReady: async () => true,
      account: async () => "me",
      projectRepos: async () => new Set(),
      fetchInbox: async () => ({ status: "not-modified", pollSeconds: 10 }),
    });
    expect(await source.fetch("x", undefined)).toEqual({ status: "not-modified", nextDelayMs: 60_000 });
  });

  it("follows a longer interval from GitHub", async () => {
    const source = createGitHubSource({
      isReady: async () => true,
      account: async () => "me",
      projectRepos: async () => new Set(),
      fetchInbox: async () => ({ status: "not-modified", pollSeconds: 300 }),
    });
    expect(await source.fetch("x", undefined)).toMatchObject({ nextDelayMs: 300_000 });
  });
});

describe("nodeToItem", () => {
  const teams = new Set(["team-1"]);
  const now = Date.parse("2026-11-04T12:00:00Z");
  const node = (over: Partial<LinearNotificationNode> = {}): LinearNotificationNode => ({
    id: "n1",
    category: "assignments",
    readAt: null,
    snoozedUntilAt: null,
    team: { id: "team-1" },
    issue: { identifier: "ENG-1", title: "Do it", url: "https://linear.app/acme/issue/ENG-1/do-it" },
    ...over,
  });

  it("maps each offered category to its kind", () => {
    for (const type of INBOX_TYPES.filter((t) => t.source === "linear")) {
      expect(nodeToItem(node({ category: type.upstream }), teams, now)?.kind).toBe(type.kind);
    }
  });

  it("is in scope only for a linked team", () => {
    expect(nodeToItem(node(), teams, now)?.inScope).toBe(true);
    expect(nodeToItem(node({ team: { id: "other" } }), teams, now)?.inScope).toBe(false);
  });

  it("drops read, snoozed and issueless nodes", () => {
    expect(nodeToItem(node({ readAt: "2026-11-04T00:00:00Z" }), teams, now)).toBeNull();
    expect(nodeToItem(node({ snoozedUntilAt: "2026-11-05T00:00:00Z" }), teams, now)).toBeNull();
    expect(nodeToItem(node({ issue: null }), teams, now)).toBeNull();
  });

  it("keeps a node whose snooze has passed", () => {
    expect(nodeToItem(node({ snoozedUntilAt: "2026-11-01T00:00:00Z" }), teams, now)).not.toBeNull();
  });

  it("refuses a URL off linear.app", () => {
    const issue = { identifier: "E-1", title: "t", url: "https://evil.example/x" };
    expect(nodeToItem(node({ issue }), teams, now)?.url).toBeNull();
  });

  it("offers no kind for a category not in the list", () => {
    expect(nodeToItem(node({ category: "billing" }), teams, now)?.kind).toBeNull();
  });
});

describe("INBOX_TYPES defaults", () => {
  it("turns on what was agreed and nothing else", () => {
    expect(INBOX_TYPES.filter((t) => t.defaultOn).map((t) => t.kind)).toEqual([
      "github-review-requested",
      "github-mentioned",
      "github-assigned",
      "linear-assigned",
      "linear-mentioned",
    ]);
  });
});

describe("InboxPoller", () => {
  let dataDir: string;
  let delivered: Array<{ key: string; banner: boolean }>;
  let enabled: Set<InboxKind> | null;
  let items: InboxItem[];
  let fetchImpl: InboxSource["fetch"];
  let ready: boolean;
  let pollers: InboxPoller[];

  const source = (): InboxSource => ({
    id: "github",
    intervalMs: 60_000,
    isReady: async () => ready,
    account: async () => "me",
    coverage: async () => 3,
    fetch: (since, cursor) => fetchImpl(since, cursor),
  });

  const poller = () => {
    const made = new InboxPoller({
      sources: [source()],
      isEnabled: (kind) => enabled === null || enabled.has(kind),
      deliver: (it, { banner }) => delivered.push({ key: it.key, banner }),
      dataDir,
      now: () => Date.parse("2026-11-04T12:00:00Z"),
    });
    pollers.push(made);
    return made;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
    delivered = [];
    enabled = null;
    items = [];
    ready = true;
    pollers = [];
    fetchImpl = async () => ({ status: "ok", items });
  });

  afterEach(async () => {
    await Promise.all(pollers.map((p) => p.stop()));
    vi.useRealTimers();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("stays quiet on the first check, then delivers only what's new", async () => {
    const p = poller();
    items = [item("old")];
    await p.check(source());
    expect(delivered).toEqual([]);
    items = [item("old"), item("new")];
    await p.check(source());
    expect(delivered.map((d) => d.key)).toEqual(["new"]);
  });

  it("doesn't repeat items after a relaunch, and picks up ones missed while closed", async () => {
    const first = poller();
    items = [item("a")];
    await first.check(source());
    await first.stop();

    const second = poller();
    items = [item("a"), item("missed")];
    await second.check(source());
    expect(delivered.map((d) => d.key)).toEqual(["missed"]);
  });

  it("drops items out of scope or of no offered kind", async () => {
    const p = poller();
    await p.check(source());
    items = [item("out", { inScope: false }), item("none", { kind: null })];
    await p.check(source());
    expect(delivered).toEqual([]);
  });

  it("doesn't deliver a type switched off, or backfill it when switched on", async () => {
    const p = poller();
    await p.check(source());
    enabled = new Set();
    items = [item("while-off")];
    await p.check(source());
    expect(delivered).toEqual([]);
    enabled = null;
    await p.check(source());
    expect(delivered).toEqual([]);
  });

  it("caps banners per check and still delivers the rest to the bell", async () => {
    const p = poller();
    await p.check(source());
    items = Array.from({ length: 20 }, (_, i) => item(`k${i}`));
    await p.check(source());
    expect(delivered).toHaveLength(20);
    expect(delivered.filter((d) => d.banner)).toHaveLength(MAX_BANNERS_PER_CHECK);
    expect(delivered.slice(0, MAX_BANNERS_PER_CHECK).every((d) => d.banner)).toBe(true);
  });

  it("reports signed out without fetching or notifying", async () => {
    ready = false;
    fetchImpl = vi.fn();
    const p = poller();
    await p.check(source());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(p.status().github).toEqual({ state: "signed-out" });
  });

  it("keeps the first run's baseline for after a sign-in", async () => {
    ready = false;
    const p = poller();
    await p.check(source());
    ready = true;
    items = [item("from-before")];
    await p.check(source());
    expect(delivered).toEqual([]);
  });

  it("reports a failure without notifying, and recovers", async () => {
    const p = poller();
    await p.check(source());
    fetchImpl = async () => {
      throw new Error("rate limited");
    };
    await p.check(source());
    expect(delivered).toEqual([]);
    expect(p.status().github).toMatchObject({ state: "error", message: "rate limited" });
    fetchImpl = async () => ({ status: "ok", items: [item("after")] });
    await p.check(source());
    expect(delivered.map((d) => d.key)).toEqual(["after"]);
    expect(p.status().github).toMatchObject({ state: "ok", account: "me", covered: 3 });
  });

  it("doesn't advance past a failed check", async () => {
    const seenSince: string[] = [];
    const p = poller();
    await p.check(source());
    fetchImpl = async (since) => {
      seenSince.push(since ?? "");
      throw new Error("offline");
    };
    await p.check(source());
    await p.check(source());
    expect(new Set(seenSince).size).toBe(1);
  });

  it("backs off after failures and stops scheduling once stopped", async () => {
    const p = poller();
    fetchImpl = async () => {
      throw new Error("offline");
    };
    let calls = 0;
    const counting = source();
    const original = counting.fetch;
    counting.fetch = (s, c) => {
      calls += 1;
      return original(s, c);
    };
    p["running"] = true;
    await p.check(counting);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    await p.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls).toBe(2);
  });

  it("recovers from a corrupt state file as a first run", async () => {
    fs.writeFileSync(path.join(dataDir, "inbox-notifications.json"), "{not json");
    const p = poller();
    items = [item("x")];
    await p.check(source());
    expect(delivered).toEqual([]);
  });

  it("asks for everything on the first check, then with an overlap", async () => {
    const sinces: Array<string | undefined> = [];
    fetchImpl = async (since) => {
      sinces.push(since);
      return { status: "ok", items: [] };
    };
    const p = poller();
    await p.check(source());
    await p.check(source());
    expect(sinces).toEqual([undefined, "2026-11-04T11:50:00.000Z"]);
  });

  it("passes the stored cursor back", async () => {
    const cursors: Array<string | undefined> = [];
    fetchImpl = async (_since, cursor) => {
      cursors.push(cursor);
      return { status: "ok", items: [], cursor: "LM" };
    };
    const p = poller();
    await p.check(source());
    await p.check(source());
    expect(cursors).toEqual([undefined, "LM"]);
  });
});

describe("ProjectScope", () => {
  const projects = [
    { id: "a", linearAssociations: [{ teamId: "t1" }] },
    { id: "b", linearAssociations: [] },
  ];

  it("collects repos and teams from projects", async () => {
    const scope = new ProjectScope({
      getProjects: async () => projects,
      getOriginUrl: async (id) => (id === "a" ? "git@github.com:Acme/App.git" : null),
    });
    expect(await scope.repos()).toEqual(new Set(["acme/app"]));
    expect(await scope.teams()).toEqual(new Set(["t1"]));
  });

  it("keeps a project's last known repo when its host can't be reached", async () => {
    let now = 0;
    let origin: () => Promise<string | null> = async () => "git@github.com:Acme/App.git";
    const scope = new ProjectScope(
      { getProjects: async () => [projects[0]], getOriginUrl: () => origin() },
      () => now,
    );
    await scope.repos();
    now = 60 * 60_000;
    origin = async () => {
      throw new Error("offline");
    };
    expect(await scope.repos()).toEqual(new Set(["acme/app"]));
  });

  it("asks for an origin once within its lifetime", async () => {
    const getOriginUrl = vi.fn(async () => "git@github.com:Acme/App.git");
    const scope = new ProjectScope(
      { getProjects: async () => [projects[0]], getOriginUrl },
      () => 0,
    );
    await scope.repos();
    await scope.repos();
    expect(getOriginUrl).toHaveBeenCalledTimes(1);
  });
});
