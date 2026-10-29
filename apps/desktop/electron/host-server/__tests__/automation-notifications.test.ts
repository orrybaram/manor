/**
 * A host server's notification log: a run of its automations goes in its
 * own log, kept on disk for a desktop that opens later, read and marked by
 * the owner and by a paired phone over the host table. A run that fails to
 * start is pushed to a subscribed phone. See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, parsePairingUrl, useHostServerHarness, withoutGit } from "./harness";
import type { NotificationRecord } from "../../notification-store";
import type { PairResult } from "../../remote-control/relay-room";
import type { Automation } from "../../../src/lib/automations";

/** A paused automation for a project this host doesn't have: run now, it fails to start. */
function writeAutomation(dataDir: string): Automation {
  const past = new Date(Date.now() - 90_000).toISOString();
  const automation: Automation = {
    id: "auto-1",
    name: "Morning triage",
    enabled: false,
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    projectId: "project-gone",
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: 720,
    createdAt: past,
    updatedAt: past,
    lastScheduledFor: past,
    nextRunAt: null,
  };
  fs.writeFileSync(path.join(dataDir, "automations.json"), JSON.stringify({ automations: [automation] }));
  return automation;
}

describe("a host server's notification log", () => {
  const h = useHostServerHarness();

  it("records a run that failed to start, serves it to the owner and a phone, and pushes it", async () => {
    withoutGit();
    h.adopt();
    writeAutomation(h.paths.dataDir);
    const server = await h.serve();
    await h.relayUp(server);
    const owner = await h.owner();
    const paired = await owner.invoke<PairResult>("remoteControl", "pair", "phone");
    const phone = await h.phone(paired.pairingUrl);
    await phone.call("remoteControl", "vapidPublicKey");
    await phone.call("remoteControl", "subscribePush", {
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256", auth: "auth" },
    });

    const run = await owner.invoke<{ outcome: string }>("automations", "runNow", null, "auto-1");
    expect(run.outcome).toBe("failed");

    const [record] = await eventually(
      () => owner.invoke<NotificationRecord[]>("notifications", "getAll"),
      (list) => list.length > 0,
      "the run's notification",
    );
    expect(record).toMatchObject({
      kind: "automation-failed",
      title: "Morning triage failed to start",
      body: "The project isn't set up on this host",
      read: false,
      hostId: "local",
      target: { type: "automation", automationId: "auto-1" },
    });

    // The push names the automation and says why, and names the host by the
    // room the phone knows it as, for a tap to open the automation.
    await eventually(() => h.pushes.length > 0, Boolean, "a push");
    expect(h.pushes).toEqual([
      {
        endpoint: "https://push.example/endpoint-1",
        payload: {
          automationId: "auto-1",
          hostId: parsePairingUrl(paired.pairingUrl).roomId,
          title: "Morning triage failed to start",
          body: "The project isn't set up on this host",
        },
      },
    ]);

    // A phone reads the log and marks it read.
    expect(await phone.call("notifications", "getAll")).toMatchObject({
      ok: true,
      result: [expect.objectContaining({ id: record.id })],
    });
    expect(await phone.call("notifications", "markRead", record.id, null)).toMatchObject({
      ok: true,
      result: true,
    });
    const [after] = await owner.invoke<NotificationRecord[]>("notifications", "getAll");
    expect(after.read).toBe(true);

    // Kept on disk for a desktop that opens later.
    owner.client.dispose();
    await h.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(h.paths.dataDir, "notifications.json"), "utf-8")) as {
      notifications: NotificationRecord[];
    };
    expect(saved.notifications.map((n) => n.kind)).toEqual(["automation-failed"]);
  }, 30_000);
});
