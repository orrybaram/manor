import { describe, expect, it } from "vitest";
import {
  buildSignInPatch,
  buildSignInSecret,
  deleteSignInSecret,
  profileKubeTarget,
  removeSignIn,
  restartPods,
  signInSecretKeys,
  writeSignIn,
  type SignInDeps,
} from "../providers/recipe-templates/signin";
import type { HostProfile } from "../../projects/types";

const GH = "ghp_secretGitHubToken123";
const CLAUDE = "sk-ant-oat01-secretClaudeToken";

const PROFILE: HostProfile = {
  id: "hp-1",
  name: "Work",
  templateId: "kubernetes",
  values: { context: "dev", namespace: "team" },
};

interface Call {
  file: string;
  args: string[];
  input?: string;
}

function fail(stderr: string, code: number | string = 1): Error {
  return Object.assign(new Error(`Command failed\n${stderr}`), {
    code,
    stdout: "",
    stderr,
  });
}

/**
 * A fake kubectl over one namespace's Secrets and pods, and a fake gh. The
 * Secret's data is kept base64'd, as the API would.
 */
function fakeCluster(
  opts: {
    secret?: Record<string, string>;
    namespace?: boolean;
    pods?: string[];
  } = {},
) {
  let secret: Record<string, string> | null = opts.secret
    ? Object.fromEntries(
        Object.entries(opts.secret).map(([k, v]) => [
          k,
          Buffer.from(v).toString("base64"),
        ]),
      )
    : null;
  let namespace = opts.namespace ?? true;
  const pods = new Set(opts.pods ?? []);
  const calls: Call[] = [];
  const deps: SignInDeps = {
    now: () => 1000,
    run: async (file, args, o) => {
      calls.push({
        file,
        args,
        ...(o?.input !== undefined ? { input: o.input } : {}),
      });
      if (file === "gh") return `${GH}\n`;
      const verbs = args.filter(
        (a) => !a.startsWith("-") && a !== "dev" && a !== "team",
      );
      const [verb, kind] = verbs;
      if (verb === "get" && kind === "namespace") {
        if (!namespace)
          throw fail(
            'Error from server (NotFound): namespaces "team" not found',
          );
        return "";
      }
      if (verb === "create" && kind === "namespace") {
        namespace = true;
        return "";
      }
      if (verb === "get" && kind === "secret") {
        if (!secret)
          throw fail(
            'Error from server (NotFound): secrets "manor-signin-hp-1" not found',
          );
        return Object.keys(secret)
          .map((k) => `${k}\n`)
          .join("");
      }
      if (verb === "create" && kind === undefined) {
        const doc = JSON.parse(o?.input ?? "") as {
          data: Record<string, string>;
        };
        secret = { ...doc.data };
        return "secret/manor-signin-hp-1 created\n";
      }
      if (verb === "patch") {
        if (!secret) throw fail("NotFound");
        const patch = JSON.parse(o?.input ?? "") as {
          data: Record<string, string | null>;
        };
        for (const [k, v] of Object.entries(patch.data)) {
          if (v === null) delete secret[k];
          else secret[k] = v;
        }
        return "secret/manor-signin-hp-1 patched\n";
      }
      if (verb === "delete" && kind === "secret") {
        secret = null;
        return "";
      }
      if (verb === "delete" && kind === "pod") {
        const pod = verbs[2];
        if (!pods.has(pod)) return "";
        pods.delete(pod);
        return `pod "${pod}" deleted\n`;
      }
      throw new Error(`unexpected kubectl ${args.join(" ")}`);
    },
  };
  const decoded = () =>
    secret
      ? Object.fromEntries(
          Object.entries(secret).map(([k, v]) => [
            k,
            Buffer.from(v, "base64").toString(),
          ]),
        )
      : null;
  return { deps, calls, decoded, hasNamespace: () => namespace };
}

/** No token, plain or base64'd, is in any argv. */
function expectNoTokenInArgv(calls: Call[]): void {
  const argv = calls.map((c) => [c.file, ...c.args].join(" ")).join("\n");
  for (const token of [GH, CLAUDE]) {
    expect(argv).not.toContain(token);
    expect(argv).not.toContain(Buffer.from(token).toString("base64"));
  }
}

describe("sign-in Secret (ADR-235 D9)", () => {
  it("builds a Secret of base64 data that no token can break out of", () => {
    const doc = JSON.parse(
      buildSignInSecret("manor-signin-hp-1", "team", { GH_TOKEN: 'a"b\nc' }),
    ) as {
      kind: string;
      metadata: { name: string; namespace: string };
      type: string;
      data: Record<string, string>;
    };
    expect(doc.kind).toBe("Secret");
    expect(doc.metadata).toMatchObject({
      name: "manor-signin-hp-1",
      namespace: "team",
    });
    expect(doc.type).toBe("Opaque");
    expect(Buffer.from(doc.data.GH_TOKEN, "base64").toString()).toBe('a"b\nc');
  });

  it("builds a merge patch that sets and removes keys", () => {
    expect(
      JSON.parse(
        buildSignInPatch({ GH_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: null }),
      ),
    ).toEqual({
      data: {
        GH_TOKEN: Buffer.from("x").toString("base64"),
        CLAUDE_CODE_OAUTH_TOKEN: null,
      },
    });
  });

  it("refuses non-Kubernetes profiles and bad context or namespace values", () => {
    expect(() =>
      profileKubeTarget({ ...PROFILE, templateId: "docker" }),
    ).toThrow(/only for Kubernetes/);
    expect(() =>
      profileKubeTarget({
        ...PROFILE,
        values: { context: "-x", namespace: "team" },
      }),
    ).toThrow(/cluster/);
    expect(() =>
      profileKubeTarget({
        ...PROFILE,
        values: { context: "dev", namespace: "Bad_NS" },
      }),
    ).toThrow(/namespace/);
    expect(
      profileKubeTarget({ ...PROFILE, values: { context: "dev" } }),
    ).toEqual({
      context: "dev",
      namespace: "manor",
      secret: "manor-signin-hp-1",
    });
    expect(() => profileKubeTarget({ ...PROFILE, id: "bad id" })).toThrow(/id/);
  });

  it("creates the Secret (and namespace) on stdin, with the gh token, never in argv", async () => {
    const k = fakeCluster({ namespace: false });
    const meta = await writeSignIn(
      PROFILE,
      { github: { source: "gh" }, claude: { token: ` ${CLAUDE}\n` } },
      k.deps,
    );
    expect(meta).toEqual({
      github: { setAt: 1000, source: "gh" },
      claude: { setAt: 1000, source: "pasted" },
    });
    expect(k.decoded()).toEqual({
      GH_TOKEN: GH,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE,
    });
    expect(k.hasNamespace()).toBe(true);
    expect(k.calls[0]).toEqual({ file: "gh", args: ["auth", "token"] });
    const create = k.calls.find((c) => c.args.includes("-f"));
    expect(create?.args).toEqual([
      "--context",
      "dev",
      "-n",
      "team",
      "create",
      "-f",
      "-",
    ]);
    expectNoTokenInArgv(k.calls);
  });

  it("merges into an existing Secret by key name, never reading values", async () => {
    const k = fakeCluster({
      secret: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE, OTHER: "keep" },
    });
    await writeSignIn(
      PROFILE,
      { github: { source: "pasted", token: GH } },
      k.deps,
    );
    expect(k.decoded()).toEqual({
      GH_TOKEN: GH,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE,
      OTHER: "keep",
    });
    const get = k.calls.find((c) => c.args.includes("get"));
    // A go-template over the keys, not jsonpath={.data} (which prints values).
    expect(get?.args.join(" ")).toMatch(
      /go-template=\{\{range \$k, \$v := \.data\}\}\{\{\$k\}\}/,
    );
    const patch = k.calls.find((c) => c.args.includes("patch"));
    expect(patch?.args).toEqual([
      "--context",
      "dev",
      "-n",
      "team",
      "patch",
      "secret",
      "manor-signin-hp-1",
      "--type",
      "merge",
      "--patch-file",
      "/dev/stdin",
    ]);
    expectNoTokenInArgv(k.calls);
  });

  it("refuses an empty or multi-word token, and a profile that isn't Kubernetes, before running anything", async () => {
    const k = fakeCluster();
    await expect(
      writeSignIn(PROFILE, { claude: { token: "  " } }, k.deps),
    ).rejects.toThrow(/not a token/);
    await expect(
      writeSignIn(PROFILE, { claude: { token: "a b" } }, k.deps),
    ).rejects.toThrow(/not a token/);
    await expect(
      writeSignIn(
        { ...PROFILE, templateId: "docker" },
        { claude: { token: CLAUDE } },
        k.deps,
      ),
    ).rejects.toThrow(/Kubernetes/);
    expect(k.calls).toEqual([]);
  });

  it("scrubs the token from kubectl's error output", async () => {
    const k = fakeCluster({ secret: { GH_TOKEN: "old" } });
    const run = k.deps.run;
    k.deps.run = async (file, args, o) => {
      if (args.includes("patch"))
        throw fail(
          `error: bad patch ${Buffer.from(GH).toString("base64")} ${GH}`,
        );
      return run(file, args, o);
    };
    const err = await writeSignIn(
      PROFILE,
      { github: { source: "pasted", token: GH } },
      k.deps,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("[redacted]");
    expect((err as Error).message).not.toContain(GH);
    expect((err as Error).message).not.toContain(
      Buffer.from(GH).toString("base64"),
    );
  });

  it("says so when gh isn't signed in, without echoing its output", async () => {
    const k = fakeCluster();
    k.deps.run = async () => {
      throw fail("no oauth token found for github.com");
    };
    await expect(
      writeSignIn(PROFILE, { github: { source: "gh" } }, k.deps),
    ).rejects.toThrow(/gh auth login/);
  });

  it("removes one key with a patch, and deletes the Secret when it would be empty", async () => {
    const k = fakeCluster({
      secret: { GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE },
    });
    await removeSignIn(PROFILE, "github", k.deps);
    expect(k.decoded()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE });
    expect(k.calls.some((c) => c.args.includes("patch"))).toBe(true);
    await removeSignIn(PROFILE, "claude", k.deps);
    expect(k.decoded()).toBeNull();
    expect(k.calls[k.calls.length - 1]?.args).toEqual([
      "--context",
      "dev",
      "-n",
      "team",
      "delete",
      "secret",
      "manor-signin-hp-1",
      "--ignore-not-found",
    ]);
  });

  it("removing from a missing Secret, or a missing key, does nothing", async () => {
    const none = fakeCluster();
    await removeSignIn(PROFILE, "github", none.deps);
    expect(none.calls).toHaveLength(1);
    const other = fakeCluster({ secret: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE } });
    await removeSignIn(PROFILE, "github", other.deps);
    expect(other.decoded()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE });
    expect(other.calls).toHaveLength(1);
  });

  it("deletes the whole Secret with one kubectl call, and nothing else", async () => {
    const k = fakeCluster({ secret: { GH_TOKEN: GH } });
    await deleteSignInSecret(PROFILE, k.deps);
    expect(k.decoded()).toBeNull();
    expect(k.calls).toHaveLength(1);
    expect(k.calls[0]?.args).toEqual([
      "--context",
      "dev",
      "-n",
      "team",
      "delete",
      "secret",
      "manor-signin-hp-1",
      "--ignore-not-found",
    ]);
  });

  it("fails when kubectl can't delete the Secret", async () => {
    const deps: SignInDeps = {
      run: async () => {
        throw fail("Unable to connect to the server");
      },
    };
    await expect(deleteSignInSecret(PROFILE, deps)).rejects.toThrow(
      /could not delete the sign-in Secret/,
    );
  });

  it("lists key names, or null without the Secret", async () => {
    expect(
      await signInSecretKeys(
        { context: "dev", namespace: "team", secret: "manor-signin-hp-1" },
        fakeCluster().deps,
      ),
    ).toBeNull();
    expect(
      await signInSecretKeys(
        { context: "dev", namespace: "team", secret: "manor-signin-hp-1" },
        fakeCluster({ secret: { A: "1", B: "2" } }).deps,
      ),
    ).toEqual(["A", "B"]);
  });

  it("restarts the pod of each running Kubernetes host from its own recipe", async () => {
    const k = fakeCluster({ pods: ["web-0"] });
    const recipe = (name: string, template = "kubernetes") => ({
      schemaVersion: 1 as const,
      id: `kubernetes-team-${name}`,
      name,
      template,
      up: "./up.sh",
      env: {
        MANOR_K8S_NAME: name,
        MANOR_K8S_NAMESPACE: "team",
        MANOR_K8S_CONTEXT: "dev",
      },
    });
    const restarted = await restartPods(
      [
        { hostId: "h-web", recipe: recipe("web") },
        { hostId: "h-api", recipe: recipe("api") }, // stopped: no pod
        { hostId: "h-dock", recipe: recipe("dock", "docker") },
      ],
      k.deps,
    );
    expect(restarted).toEqual(["h-web"]);
    expect(k.calls.map((c) => c.args)).toEqual([
      [
        "--context",
        "dev",
        "-n",
        "team",
        "delete",
        "pod",
        "web-0",
        "--ignore-not-found",
        "--wait=false",
      ],
      [
        "--context",
        "dev",
        "-n",
        "team",
        "delete",
        "pod",
        "api-0",
        "--ignore-not-found",
        "--wait=false",
      ],
    ]);
  });
});
