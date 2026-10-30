import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import type { createTestApp } from "../test/integration/app";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { users, messages, messageMentions } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, assignMachine, updateAgentStatus } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import type { ReplicaStateStore } from "../services/replicaStateStore";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { ensureMentionDeliveryOccurrences, getMentionDeliveryOccurrence } from "../services/mentionDeliveryOccurrenceService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
type Delivery = Parameters<AgentOrchestrator["sendAgentDeliveryWithAckRetry"]>[1];

class ProfileCacheProbe extends AgentOrchestrator {
  sent: Delivery[] = [];
  async seedLaunch(agentId: string, launchId: string) {
    await this.getAuthoritativeAgentForDelivery(agentId);
    this.setLaunchGuard(agentId, launchId);
  }
  readState(agentId: string) { return this.getAuthoritativeAgentForDelivery(agentId); }
  protected override async hasPassiveDeliveryScope() { return true; }
  protected override async canAgentAccessDeliveryTarget() { return true; }
  protected override async enqueueToLocalInboxIfStillActive() { return true; }
  protected override async sendAgentDeliveryWithAckRetry(_machineId: string, message: Delivery) {
    this.sent.push(message);
    return true;
  }
}

async function setup(db: Database, app: Awaited<ReturnType<typeof createTestApp>>) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `profile-cache-${suffix}@raft.test`, name: `owner-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
  }).returning();
  const server = await createServer("Profile cache", `profile-cache-${suffix}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "test-computer");
  const agent = await createAgent(server.id, `lead-${suffix}`, { runtime: "codex", model: "gpt-5.3-codex" });
  await assignMachine(agent.id, machine.id);
  await updateAgentStatus(agent.id, "active", "session-before-edit");
  const replicaStore = {
    isAvailable: () => false,
    registerMachineReplica: async () => "test-generation",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => "refreshed",
    hasMachineReplica: async () => true,
    getMachineReplicaOwner: async () => "test-replica",
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    getAgentRuntimeError: async () => null,
    setAgentRuntimeError: async () => {},
    bumpMachineStatusVersion: async () => 1,
    getMachineStatusVersion: async () => 1,
    getMachineMeta: async () => null,
    setMachineMeta: async () => {},
    clearMachineMeta: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    getWakeCrashLoopState: async () => null,
    compareAndSetWakeCrashLoopState: async () => true,
  } as ReplicaStateStore;
  const orch = new ProfileCacheProbe(replicaStore);
  const ws = { readyState: 1, OPEN: 1, send() {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  await orch.registerMachine(machine.id, server.id, ws as never);
  await orch.seedLaunch(agent.id, "launch-before-edit");
  const original = app.app.get("agentOrchestrator");
  const resets: string[] = [];
  app.app.set("agentOrchestrator", {
    ...original,
    evictCache: orch.evictCache.bind(orch),
    // Resolve at call time so the pre-fix route can run and demonstrate the loss.
    refreshProfileCache: (...args: Parameters<AgentOrchestrator["refreshProfileCache"]>) => orch.refreshProfileCache(...args),
    resetAgent: async (_id: string, mode: string) => { resets.push(mode); },
  });
  const token = await tokenForHuman(owner.email);
  const patch = (body: object) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { owner, server, machine, agent, orch, patch, resets };
}

test("profile edits preserve runtime identity and the next message receives a delivered receipt", async ({ db, app }) => {
  const h = await setup(db, app);
  try {
    for (const body of [
      { description: "Updated coordinator instructions" },
      { displayName: "Coordinator" },
      { avatarUrl: null },
      { serverRole: "member" },
      { model: "gpt-5.3-codex" }, // Posting the current value is not a runtime change.
    ]) {
      const before = await h.orch.readState(h.agent.id);
      const response = await h.patch(body);
      assert.equal(response.status, 200, await response.text());
      if ("description" in body) assert.equal(before?.description, body.description);
      if ("displayName" in body) assert.equal(before?.displayName, body.displayName);
      const state = await h.orch.readState(h.agent.id);
      assert.equal(state?.expectedLaunchId, "launch-before-edit");
      assert.equal(state?.sessionId, "session-before-edit");
      assert.equal(state?.launchGuardMode, "guarded");
      assert.equal(state?.description, "Updated coordinator instructions");
    }
    const author = await createAgent(h.server.id, `sender-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
    const channel = await createChannel(h.server.id, `topic-${randomUUID().slice(0, 8)}`);
    await addHuman(channel.id, h.owner.id); await addAgent(channel.id, author.id); await addAgent(channel.id, h.agent.id);
    const [message] = await db.insert(messages).values({
      channelId: channel.id, senderType: "agent", senderId: author.id, content: `@${h.agent.name} test input`, seq: 1,
    }).returning();
    const [mention] = await db.insert(messageMentions).values({
      messageId: message.id, messageSeq: 1, serverId: h.server.id, channelId: channel.id,
      targetType: "agent", targetId: h.agent.id, handleAtSendTime: h.agent.name,
    }).returning();
    const payload: AgentMessage = {
      channel_id: channel.id, channel_name: channel.name, channel_type: "channel",
      sender_id: author.id, sender_name: author.name, sender_type: "agent",
      content: message.content, timestamp: message.createdAt.toISOString(), seq: 1, message_id: message.id, mentioned: true,
    };
    await ensureMentionDeliveryOccurrences([{
      occurrenceId: mention.id, messageId: message.id, serverId: h.server.id, agentId: h.agent.id, deliveryPayload: payload,
    }]);
    await h.orch.deliverMessage(h.agent.id, payload, { mentionDeliveryOccurrenceId: mention.id });
    const delivery = h.orch.sent.find(value => value.mentionDelivery?.occurrenceId === mention.id);
    assert.ok(delivery?.mentionDelivery, "profile edits must not demote tracked delivery to an untracked push");
    assert.equal((await getMentionDeliveryOccurrence(message.id, h.agent.id))?.state, "server_decided");
    // A simulated Computer returns the real frame identity through normal ingress.
    for (const stage of ["daemon_received", "daemon_drained"] as const) {
      await h.orch.handleMachineMessage(h.machine.id, {
        type: "agent:delivery:transition", agentId: h.agent.id, mentionDelivery: delivery.mentionDelivery, stage, outcome: "accepted",
      });
    }
    await h.orch.handleMachineMessage(h.machine.id, {
      type: "agent:deliver:ack", agentId: h.agent.id, seq: 1, deliveryId: mention.id, mentionDelivery: delivery.mentionDelivery,
    });
    const { apiKey } = await mintAgentCredential({ agentId: author.id, scopes: ["mentions"], name: "profile-cache-test", createdByUserId: null });
    const receipt = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/mention-deliveries`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(receipt.status, 200);
    assert.deepEqual(await receipt.json(), {
      messageId: message.id, deliveries: [{ targetHandle: h.agent.name, outcome: "delivered" }],
    });
  } finally { await h.orch.shutdown(); }
});

for (const [label, body] of [
  ["explicit reset", { description: "Updated instructions", restartMode: "session" }],
  ["model change", { model: "gpt-5.4" }],
  ["runtime change", { runtime: "claude", model: "sonnet" }],
] as const) {
  test(`${label} still invalidates the previous runtime identity`, async ({ db, app }) => {
    const h = await setup(db, app);
    try {
      const response = await h.patch(body);
      assert.equal(response.status, 200, await response.text());
      assert.equal((await h.orch.readState(h.agent.id))?.expectedLaunchId, null);
      if (label === "explicit reset") assert.deepEqual(h.resets, ["session"]);
      if (label === "runtime change") assert.equal((await h.orch.readState(h.agent.id))?.sessionId, null);
    } finally { await h.orch.shutdown(); }
  });
}

test("a profile edit does not invent an identity that was already lost", async ({ db, app }) => {
  const h = await setup(db, app);
  try {
    h.orch.evictCache(h.agent.id);
    const response = await h.patch({ description: "Edited after cache loss" });
    assert.equal(response.status, 200, await response.text());
    const state = await h.orch.readState(h.agent.id);
    assert.equal(state?.description, "Edited after cache loss");
    assert.equal(state?.expectedLaunchId, null);
    assert.equal(state?.sessionId, "session-before-edit");
  } finally { await h.orch.shutdown(); }
});
