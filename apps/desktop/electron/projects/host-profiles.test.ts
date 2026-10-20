import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { listTemplates } from "../backend/providers/recipe-templates";
import { HostProfiles } from "./host-profiles";
import { HostRecords } from "./host-records";
import { StateStore } from "./state-store";

const ctx = { appVersion: "1.2.3" };
const recipeSpec = { kind: "recipe" as const, recipeId: "kubernetes-manor-web" };

describe("HostProfiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `manor-host-profiles-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open() {
    const store = new StateStore(dir);
    return { store, profiles: new HostProfiles(store), hosts: new HostRecords(store) };
  }

  it("saves a profile and reads it back after a reload", () => {
    const { profiles } = open();
    const saved = profiles.save(
      {
        name: "  Work cluster ",
        templateId: "kubernetes",
        values: { context: "kind-test", namespace: "team", storage: "40Gi" },
      },
      ctx,
    );
    expect(saved.id).toMatch(/^hp-[0-9a-f]{12}$/);
    expect(saved).toEqual({
      id: saved.id,
      name: "Work cluster",
      templateId: "kubernetes",
      values: { context: "kind-test", namespace: "team", storage: "40Gi" },
      idleStopMinutes: 60,
    });

    const reloaded = open().profiles;
    expect(reloaded.list()).toEqual([saved]);
    expect(reloaded.get(saved.id)).toEqual(saved);
    expect(reloaded.get("hp-missing")).toBeUndefined();
  });

  it("updates a profile in place, keeping its idle stop unless told", () => {
    const { profiles } = open();
    const first = profiles.save({ name: "Home", templateId: "docker", values: {} }, ctx);
    const renamed = profiles.save(
      { id: first.id, name: "Home box", templateId: "docker", values: { context: "colima" } },
      ctx,
    );
    expect(renamed).toMatchObject({ id: first.id, name: "Home box", idleStopMinutes: 60 });

    const off = profiles.save(
      { id: first.id, name: "Home box", templateId: "docker", values: {}, idleStopMinutes: null },
      ctx,
    );
    expect(off).not.toHaveProperty("idleStopMinutes");
    expect(open().profiles.list()).toEqual([off]);
  });

  it("keeps a profile's sign-in metadata across an edit", () => {
    const { store, profiles } = open();
    const saved = profiles.save({ name: "Work", templateId: "kubernetes", values: { context: "kind-test" } }, ctx);
    const signIn = { github: { setAt: 1, source: "gh" as const } };
    store.state.hostProfiles![saved.id].signIn = signIn;
    const edited = profiles.save({ id: saved.id, name: "Work 2", templateId: "kubernetes", values: { context: "kind-test" } }, ctx);
    expect(edited.signIn).toEqual(signIn);
  });

  it("sets and clears sign-in metadata, persisting it", () => {
    const { profiles } = open();
    const saved = profiles.save({ name: "Work", templateId: "kubernetes", values: { context: "kind-test" } }, ctx);
    profiles.setSignIn(saved.id, "github", { setAt: 1, source: "gh" });
    const both = profiles.setSignIn(saved.id, "claude", { setAt: 2, source: "pasted" });
    expect(both.signIn).toEqual({ github: { setAt: 1, source: "gh" }, claude: { setAt: 2, source: "pasted" } });
    expect(open().profiles.get(saved.id)?.signIn).toEqual(both.signIn);

    expect(profiles.setSignIn(saved.id, "github", null).signIn).toEqual({ claude: { setAt: 2, source: "pasted" } });
    expect(profiles.setSignIn(saved.id, "claude", null)).not.toHaveProperty("signIn");
    expect(open().profiles.get(saved.id)).not.toHaveProperty("signIn");
    expect(() => profiles.setSignIn("hp-missing", "github", null)).toThrow(/Unknown host profile/);
  });

  it("accepts only off, 30, 60 or 120 minutes of idle stop", () => {
    const { profiles } = open();
    for (const minutes of [30, 60, 120]) {
      expect(
        profiles.save({ name: "P", templateId: "docker", values: {}, idleStopMinutes: minutes }, ctx)
          .idleStopMinutes,
      ).toBe(minutes);
    }
    expect(() =>
      profiles.save({ name: "P", templateId: "docker", values: {}, idleStopMinutes: 45 }, ctx),
    ).toThrow(/Stop when idle/);
  });

  it("refuses answers for per-host fields", () => {
    const { profiles } = open();
    expect(() =>
      profiles.save({ name: "P", templateId: "kubernetes", values: { name: "web" } }, ctx),
    ).toThrow(/can't store "name"/);
    expect(profiles.list()).toEqual([]);
  });

  it("refuses answers the template does not accept, writing nothing", () => {
    const { profiles } = open();
    expect(() =>
      profiles.save({ name: "P", templateId: "kubernetes", values: { context: "kind-test", namespace: "Not A Label" } }, ctx),
    ).toThrow(/namespace is not valid/);
    expect(() =>
      profiles.save({ name: "P", templateId: "kubernetes", values: { bogus: "x" } }, ctx),
    ).toThrow(/no field "bogus"/);
    expect(() => profiles.save({ name: "P", templateId: "nope", values: {} }, ctx)).toThrow(
      /Unknown template/,
    );
    expect(() => profiles.save({ name: "  ", templateId: "docker", values: {} }, ctx)).toThrow(
      /name is required/,
    );
    expect(() =>
      profiles.save({ id: "hp-missing", name: "P", templateId: "docker", values: {} }, ctx),
    ).toThrow(/Unknown host profile/);
    expect(profiles.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "projects.json"))).toBe(false);
  });

  it("removing a profile clears profileId on its hosts and leaves them", () => {
    const { profiles, hosts } = open();
    const work = profiles.save({ name: "Work", templateId: "kubernetes", values: { context: "kind-test" } }, ctx);
    const home = profiles.save({ name: "Home", templateId: "docker", values: {} }, ctx);
    hosts.save("h1", recipeSpec);
    hosts.save("h2", recipeSpec);
    hosts.setProfileId("h1", work.id);
    hosts.setProfileId("h2", home.id);
    hosts.setForProject("h1", "p1");

    profiles.remove(work.id);

    const reloaded = open();
    expect(reloaded.profiles.list()).toEqual([home]);
    expect(reloaded.hosts.list().map((h) => h.hostId)).toEqual(["h1", "h2"]);
    expect(reloaded.hosts.profileId("h1")).toBeUndefined();
    expect(reloaded.hosts.forProject("h1")).toBe("p1");
    expect(reloaded.hosts.profileId("h2")).toBe(home.id);

    reloaded.profiles.remove(home.id);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf-8"));
    expect(saved).not.toHaveProperty("hostProfiles");
  });
});

describe("HostRecords profileId / forProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `manor-host-records-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists both marks, keeps them when the spec is replaced, and clears them", () => {
    const hosts = new HostRecords(new StateStore(dir));
    hosts.save("h1", recipeSpec);
    hosts.setProfileId("h1", "hp-1");
    hosts.setForProject("h1", "p1");
    hosts.save("h1", { kind: "recipe", recipeId: "kubernetes-manor-api" });

    const reloaded = new HostRecords(new StateStore(dir));
    expect(reloaded.profileId("h1")).toBe("hp-1");
    expect(reloaded.forProject("h1")).toBe("p1");

    reloaded.setProfileId("h1", undefined);
    reloaded.setForProject("h1", undefined);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf-8"));
    expect(saved.hosts.h1).not.toHaveProperty("profileId");
    expect(saved.hosts.h1).not.toHaveProperty("forProject");
  });

  it("clears forProject on hosts naming a removed project", () => {
    const hosts = new HostRecords(new StateStore(dir));
    hosts.save("h1", recipeSpec);
    hosts.save("h2", recipeSpec);
    hosts.setForProject("h1", "p1");
    hosts.setForProject("h2", "p2");
    expect(hosts.clearForProjects(new Set(["p1"]))).toEqual(["h1"]);
    expect(hosts.forProject("h1")).toBeUndefined();
    expect(hosts.forProject("h2")).toBe("p2");
  });

  it("ignores marks for an unknown host", () => {
    const hosts = new HostRecords(new StateStore(dir));
    hosts.setProfileId("nope", "hp-1");
    expect(hosts.profileId("nope")).toBeUndefined();
  });
});

describe("listTemplates perHost", () => {
  it("names each bundled template's per-host fields", () => {
    const perHost = Object.fromEntries(listTemplates(ctx).map((t) => [t.id, t.perHost]));
    expect(perHost).toEqual({ docker: ["name"], kubernetes: ["name"] });
  });
});
