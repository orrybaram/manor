import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AgentManager } from "./agent-persistence";
import type { AgentInfo } from "./agent-persistence";

describe("AgentManager", () => {
  let tmpDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-agent-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new AgentManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgent(
    overrides: Partial<Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">> = {},
  ): AgentInfo {
    return manager.createAgent({
      agentSessionId: `session-${crypto.randomUUID()}`,
      name: "Test agent",
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: "/project/main",
      cwd: "/project/main",
      agentKind: "claude",
      agentCommand: "claude",
      paneId: `pane-${crypto.randomUUID()}`,
      lastAgentStatus: null,
      resumedAt: null,
      ...overrides,
    });
  }

  describe("resumedAt field (ADR-118)", () => {
    it("defaults to null when an agent is created", () => {
      const agent = makeAgent();
      expect(agent.resumedAt).toBeNull();
    });

    it("can be set via updateAgent", () => {
      const agent = makeAgent();
      const now = new Date().toISOString();
      const updated = manager.updateAgent(agent.id, { resumedAt: now });
      expect(updated).not.toBeNull();
      expect(updated!.resumedAt).toBe(now);
    });

    it("is preserved across save/load cycles", async () => {
      const agent = makeAgent();
      const now = new Date().toISOString();
      manager.updateAgent(agent.id, { resumedAt: now });

      // Wait for the debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Reload from disk
      const freshManager = new AgentManager(tmpDir);
      const loaded = freshManager.getAgentBySessionId(agent.agentSessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.resumedAt).toBe(now);
    });

    it("does not affect status filtering — active agents with resumedAt are still returned", () => {
      const agent1 = makeAgent({ resumedAt: new Date().toISOString() });
      const agent2 = makeAgent({ resumedAt: null });
      makeAgent({ status: "completed", resumedAt: null });

      const active = manager.getAllAgents({ status: "active" });
      const ids = active.map((t) => t.id);

      expect(ids).toContain(agent1.id);
      expect(ids).toContain(agent2.id);
      expect(active).toHaveLength(2);
    });

    it("can be queried to find agents that have not yet been resumed", () => {
      const resumed = makeAgent({ resumedAt: new Date().toISOString() });
      const notResumed = makeAgent({ resumedAt: null });

      const active = manager.getAllAgents({ status: "active" });
      const needResume = active.filter((t) => !t.resumedAt);

      expect(needResume.map((t) => t.id)).toContain(notResumed.id);
      expect(needResume.map((t) => t.id)).not.toContain(resumed.id);
    });
  });

  describe("pruneOlderThan (ADR-136)", () => {
    function isoDaysAgo(days: number): string {
      return new Date(Date.now() - days * 86_400_000).toISOString();
    }

    it("removes non-active agents older than the cutoff", () => {
      const old = makeAgent({
        status: "completed",
        completedAt: isoDaysAgo(120),
      });
      const recent = makeAgent({
        status: "completed",
        completedAt: isoDaysAgo(10),
      });
      const abandoned = makeAgent({
        status: "abandoned",
        completedAt: isoDaysAgo(200),
      });

      const removed = manager.pruneOlderThan(90);

      expect(removed).toBe(2);
      expect(manager.getAllAgents().map((t) => t.id)).toEqual([recent.id]);
      // Sanity-check: agents pruned were the old + abandoned ones
      expect(manager.getAllAgents().map((t) => t.id)).not.toContain(old.id);
      expect(manager.getAllAgents().map((t) => t.id)).not.toContain(abandoned.id);
    });

    it("never removes active agents regardless of completedAt", () => {
      // Pathological: an active agent with an old completedAt should be kept
      // (active agents are exempt from retention by definition).
      const active = makeAgent({
        status: "active",
        completedAt: isoDaysAgo(500),
      });
      const removed = manager.pruneOlderThan(90);
      expect(removed).toBe(0);
      expect(manager.getAllAgents().map((t) => t.id)).toContain(active.id);
    });

    it("treats agents without completedAt as not-prunable", () => {
      const noCompleted = makeAgent({
        status: "completed",
        completedAt: null,
      });
      const removed = manager.pruneOlderThan(90);
      expect(removed).toBe(0);
      expect(manager.getAllAgents().map((t) => t.id)).toContain(noCompleted.id);
    });

    it("returns 0 and no-ops when retentionDays <= 0", () => {
      makeAgent({ status: "completed", completedAt: isoDaysAgo(1000) });
      const before = manager.getAllAgents().length;

      expect(manager.pruneOlderThan(0)).toBe(0);
      expect(manager.pruneOlderThan(-5)).toBe(0);
      expect(manager.pruneOlderThan(Number.NaN)).toBe(0);
      expect(manager.pruneOlderThan(Number.POSITIVE_INFINITY)).toBe(0);

      expect(manager.getAllAgents().length).toBe(before);
    });

    it("runs from the constructor and reports count via getLastPruneCount()", async () => {
      // Seed an old completed agent with the existing manager, then flush to disk.
      const old = makeAgent({
        status: "completed",
        completedAt: isoDaysAgo(200),
      });
      const recent = makeAgent({
        status: "completed",
        completedAt: isoDaysAgo(5),
      });
      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Reload with retentionDays = 90: the old agent should be pruned at construction.
      const fresh = new AgentManager(tmpDir, 90);
      expect(fresh.getLastPruneCount()).toBe(1);
      expect(fresh.getAllAgents().map((t) => t.id)).toContain(recent.id);
      expect(fresh.getAllAgents().map((t) => t.id)).not.toContain(old.id);
    });

    it("constructor with retentionDays=0 disables pruning", async () => {
      makeAgent({ status: "completed", completedAt: isoDaysAgo(1000) });
      await new Promise((r) => setTimeout(r, 600));

      const fresh = new AgentManager(tmpDir, 0);
      expect(fresh.getLastPruneCount()).toBe(0);
      expect(fresh.getAllAgents().length).toBe(1);
    });
  });

  describe("tasks.json → agents.json migration (ADR-166)", () => {
    function legacyRecord(agentSessionId: string) {
      return {
        id: crypto.randomUUID(),
        agentSessionId,
        name: "Renamed agent",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        activatedAt: null,
        projectId: null,
        projectName: null,
        workspacePath: null,
        cwd: "/project",
        agentKind: "claude",
        agentCommand: null,
        paneId: null,
        lastAgentStatus: null,
        resumedAt: null,
      };
    }

    it("adopts a pre-rename tasks.json (with its `tasks` key) as agents.json", () => {
      const sessionId = `session-${crypto.randomUUID()}`;
      fs.writeFileSync(
        path.join(tmpDir, "tasks.json"),
        JSON.stringify({ tasks: [legacyRecord(sessionId)] }, null, 2),
      );

      const fresh = new AgentManager(tmpDir);

      expect(fresh.getAgentBySessionId(sessionId)).not.toBeNull();
      expect(fs.existsSync(path.join(tmpDir, "tasks.json"))).toBe(false);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "agents.json"), "utf-8"),
      );
      expect(onDisk.tasks).toBeUndefined();
      expect(onDisk.agents[0].agentSessionId).toBe(sessionId);
    });

    it("prefers agents.json when both files exist", () => {
      const keep = `session-${crypto.randomUUID()}`;
      const stale = `session-${crypto.randomUUID()}`;
      fs.writeFileSync(
        path.join(tmpDir, "agents.json"),
        JSON.stringify({ agents: [legacyRecord(keep)] }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "tasks.json"),
        JSON.stringify({ tasks: [legacyRecord(stale)] }),
      );

      const fresh = new AgentManager(tmpDir);

      expect(fresh.getAgentBySessionId(keep)).not.toBeNull();
      expect(fresh.getAgentBySessionId(stale)).toBeNull();
      expect(fs.existsSync(path.join(tmpDir, "tasks.json"))).toBe(true);
    });
  });

  describe("claudeSessionId migration (ADR-138)", () => {
    function writeLegacyAgentsJson(dir: string, agents: object[]): void {
      const state = { agents };
      fs.writeFileSync(
        path.join(dir, "agents.json"),
        JSON.stringify(state, null, 2),
      );
    }

    it("rewrites the file without the legacy key on first construction", () => {
      const legacySessionId = `session-${crypto.randomUUID()}`;
      const agentId = crypto.randomUUID();
      writeLegacyAgentsJson(tmpDir, [
        {
          id: agentId,
          claudeSessionId: legacySessionId,
          name: "Legacy agent",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: null,
          activatedAt: null,
          projectId: null,
          projectName: null,
          workspacePath: null,
          cwd: "/project",
          agentKind: "claude",
          agentCommand: null,
          paneId: null,
          lastAgentStatus: null,
          resumedAt: null,
        },
      ]);

      // Discard the manager created in beforeEach (no agents.json existed then).
      const fresh = new AgentManager(tmpDir);

      // The agent should be accessible under the migrated agentSessionId.
      const agent = fresh.getAgentBySessionId(legacySessionId);
      expect(agent).not.toBeNull();
      expect(agent!.agentSessionId).toBe(legacySessionId);

      // The file on disk must no longer contain the legacy key.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "agents.json"), "utf-8"),
      );
      expect(JSON.stringify(onDisk)).not.toContain("claudeSessionId");
      expect(onDisk.agents[0].agentSessionId).toBe(legacySessionId);
    });

    it("does not re-migrate (idempotent) on a second construction", () => {
      const legacySessionId = `session-${crypto.randomUUID()}`;
      const agentId = crypto.randomUUID();
      writeLegacyAgentsJson(tmpDir, [
        {
          id: agentId,
          claudeSessionId: legacySessionId,
          name: "Legacy agent",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: null,
          activatedAt: null,
          projectId: null,
          projectName: null,
          workspacePath: null,
          cwd: "/project",
          agentKind: "claude",
          agentCommand: null,
          paneId: null,
          lastAgentStatus: null,
          resumedAt: null,
        },
      ]);

      // First construction: migrates and flushes synchronously.
      new AgentManager(tmpDir);

      // Capture mtime after first flush.
      const mtimeAfterFirst = fs.statSync(
        path.join(tmpDir, "agents.json"),
      ).mtimeMs;

      // Second construction: file is already clean; no migration should occur.
      new AgentManager(tmpDir);

      const mtimeAfterSecond = fs.statSync(
        path.join(tmpDir, "agents.json"),
      ).mtimeMs;

      // File must still not contain the legacy key.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "agents.json"), "utf-8"),
      );
      expect(JSON.stringify(onDisk)).not.toContain("claudeSessionId");

      // mtime must be unchanged — the second construction did not flush.
      expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
    });
  });

  describe("getAgentById / idIndex (ADR-138)", () => {
    it("returns the agent after createAgent", () => {
      const agent = makeAgent();
      const found = manager.getAgentById(agent.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agent.id);
      expect(manager.getAllAgents().length).toBe(1);
    });

    it("returns updated agent after updateAgent", () => {
      const agent = makeAgent();
      manager.updateAgent(agent.id, { name: "Updated name" });
      const found = manager.getAgentById(agent.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Updated name");
    });

    it("returns null after deleteAgent and idIndex stays in sync", () => {
      const agent = makeAgent();
      manager.deleteAgent(agent.id);
      expect(manager.getAgentById(agent.id)).toBeNull();
      // Verify structural invariant: idIndex.size === agents.size
      const allAgents = manager.getAllAgents();
      expect(allAgents.length).toBe(0);
    });

    it("idIndex is rebuilt from disk after loadState", async () => {
      const agent1 = makeAgent();
      const agent2 = makeAgent();

      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      const fresh = new AgentManager(tmpDir);
      expect(fresh.getAgentById(agent1.id)).not.toBeNull();
      expect(fresh.getAgentById(agent1.id)!.id).toBe(agent1.id);
      expect(fresh.getAgentById(agent2.id)).not.toBeNull();
      expect(fresh.getAgentById(agent2.id)!.id).toBe(agent2.id);
      // idIndex.size should match agents map size
      expect(fresh.getAllAgents().length).toBe(2);
    });

    it("updateAgent throws if agentSessionId is included in updates", () => {
      const agent = makeAgent();
      expect(() =>
        manager.updateAgent(agent.id, {
          agentSessionId: "new-session-id",
        } as Partial<typeof agent>),
      ).toThrow("agentSessionId is immutable");
    });
  });
});
