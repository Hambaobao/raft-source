import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
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

class ReceiptOrderProbe extends AgentOrchestrator {
  sent: Delivery[] = [];
  async seedLaunch(agentId: string, launchId: string) {
    await this.getAuthoritativeAgentForDelivery(agentId);
    this.setLaunchGuard(agentId, launchId);
  }
  protected override async hasPassiveDeliveryScope() { return true; }
  protected override async canAgentAccessDeliveryTarget() { return true; }
  protected override async enqueueToLocalInboxIfStillActive() { return true; }
  protected override async sendAgentDeliveryWithAckRetry(_machineId: string, message: Delivery) {
    this.sent.push(message);
    return true;
  }
}

async function setup(db: Database) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `receipt-order-${suffix}@raft.test`, name: `owner-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
  }).returning();
  const server = await createServer("Profile cache", `receipt-order-${suffix}`, owner.id);
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
  const orch = new ReceiptOrderProbe(replicaStore);
  const ws = { readyState: 1, OPEN: 1, send() {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  await orch.registerMachine(machine.id, server.id, ws as never);
  await orch.seedLaunch(agent.id, "launch-before-edit");
  return { owner, server, machine, agent, orch, ws };
}

async function delivery(h: Awaited<ReturnType<typeof setup>>, db: Database) {
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
  assert.ok(delivery?.mentionDelivery, "fixture must produce a tracked delivery");
  assert.equal((await getMentionDeliveryOccurrence(message.id, h.agent.id))?.state, "server_decided");
  return { message, mention, author, tracked: delivery.mentionDelivery };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a concurrent ACK waits for its drained receipt and reaches the sender without a resend", async ({ db, app }) => {
  const h = await setup(db);
  const gate = deferred(), entered = deferred();
  const pending: Promise<unknown>[] = [];
  try {
    const d = await delivery(h, db);
    const frame = (stage: "daemon_received" | "daemon_drained") => ({
      type: "agent:delivery:transition" as const, agentId: h.agent.id, mentionDelivery: d.tracked, stage, outcome: "accepted" as const,
    });
    await h.orch.handleMachineMessage(h.machine.id, frame("daemon_received"));
    const internal = h.orch as any;
    const validate = internal.validateMachineAgentMessage.bind(h.orch);
    internal.validateMachineAgentMessage = async (...args: unknown[]) => {
      if (args[3] === "agent:delivery:transition") { entered.resolve(); await gate.promise; }
      return validate(...args);
    };
    pending.push(h.orch.handleMachineMessage(h.machine.id, frame("daemon_drained")));
    await entered.promise;
    pending.push(h.orch.handleMachineMessage(h.machine.id, {
      type: "agent:deliver:ack", agentId: h.agent.id, seq: 1, deliveryId: d.mention.id, mentionDelivery: d.tracked,
    }));
    // Hold the earlier database-bound handler while the next WebSocket callback runs.
    // This is local scheduler delay, not a model/CLI wait and not the 15-second resend.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();
    await Promise.all(pending);
    const { apiKey } = await mintAgentCredential({ agentId: d.author.id, scopes: ["mentions"], name: "receipt-order-test", createdByUserId: null });
    const response = await fetch(`${app.baseUrl}/internal/agent-api/messages/${d.message.id}/mention-deliveries`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      messageId: d.message.id, deliveries: [{ targetHandle: h.agent.name, outcome: "delivered" }],
    });
  } finally {
    gate.resolve(); await Promise.allSettled(pending); await h.orch.shutdown();
  }
});

function transition(h: Awaited<ReturnType<typeof setup>>, d: Awaited<ReturnType<typeof delivery>>, stage: "daemon_received" | "daemon_drained") {
  return { type: "agent:delivery:transition" as const, agentId: h.agent.id, mentionDelivery: d.tracked, stage, outcome: "accepted" as const };
}
function ack(h: Awaited<ReturnType<typeof setup>>, d: Awaited<ReturnType<typeof delivery>>) {
  return { type: "agent:deliver:ack" as const, agentId: h.agent.id, seq: 1, deliveryId: d.mention.id, mentionDelivery: d.tracked };
}

test("a slow receipt does not block another occurrence for the same agent or ping", async ({ db }) => {
  const h = await setup(db), gate = deferred(), entered = deferred();
  const pending: Promise<unknown>[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await delivery(h, db), second = await delivery(h, db);
    const internal = h.orch as any, validate = internal.validateMachineAgentMessage.bind(h.orch);
    let pause = true;
    internal.validateMachineAgentMessage = async (...args: unknown[]) => {
      if (pause && args[3] === "agent:delivery:transition") { pause = false; entered.resolve(); await gate.promise; }
      return validate(...args);
    };
    pending.push(h.orch.handleMachineMessage(h.machine.id, transition(h, first, "daemon_received")));
    await entered.promise;
    const independent = (async () => {
      await h.orch.handleMachineMessage(h.machine.id, { type: "ping" });
      await h.orch.handleMachineMessage(h.machine.id, transition(h, second, "daemon_received"));
      await h.orch.handleMachineMessage(h.machine.id, transition(h, second, "daemon_drained"));
      await h.orch.handleMachineMessage(h.machine.id, ack(h, second));
      assert.equal((await getMentionDeliveryOccurrence(second.message.id, h.agent.id))?.state, "acked");
    })();
    pending.push(independent);
    await Promise.race([independent, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("unrelated receipt blocked")), 1000); })]);
    assert.equal((await getMentionDeliveryOccurrence(first.message.id, h.agent.id))?.state, "server_decided");
  } finally {
    clearTimeout(timeout); gate.resolve(); await Promise.allSettled(pending); await h.orch.shutdown();
  }
});

test("a failed receipt rejects its caller without poisoning later receipts or leaking the queue", async ({ db }) => {
  const h = await setup(db);
  try {
    const d = await delivery(h, db);
    const internal = h.orch as any, validate = internal.validateMachineAgentMessage.bind(h.orch);
    let fail = true;
    internal.validateMachineAgentMessage = async (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error("receipt test failure"); }
      return validate(...args);
    };
    const outcomes = await Promise.allSettled([
      h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_received")),
      h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_received")),
      h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_drained")),
      h.orch.handleMachineMessage(h.machine.id, ack(h, d)),
    ]);
    assert.deepEqual(outcomes.map(r => r.status), ["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    assert.equal((await getMentionDeliveryOccurrence(d.message.id, h.agent.id))?.state, "acked");
    assert.equal(internal.mentionReceiptQueues.size, 0);
  } finally { await h.orch.shutdown(); }
});

test("ordering does not manufacture a missing drain, ACK, or valid identity", async ({ db }) => {
  const h = await setup(db);
  try {
    const d = await delivery(h, db);
    await h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_received"));
    await h.orch.handleMachineMessage(h.machine.id, ack(h, d));
    assert.equal((await getMentionDeliveryOccurrence(d.message.id, h.agent.id))?.ackedAt, null);
    await h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_drained"));
    assert.equal((await getMentionDeliveryOccurrence(d.message.id, h.agent.id))?.ackedAt, null);
    await h.orch.handleMachineMessage(h.machine.id, { ...ack(h, d), mentionDelivery: { ...d.tracked, launchId: "stale-launch" } });
    assert.equal((await getMentionDeliveryOccurrence(d.message.id, h.agent.id))?.ackedAt, null);
    await h.orch.handleMachineMessage(h.machine.id, ack(h, d));
    assert.equal((await getMentionDeliveryOccurrence(d.message.id, h.agent.id))?.state, "acked");
  } finally { await h.orch.shutdown(); }
});

test("queued receipts from a replaced socket are checked again before they run", async ({ db }) => {
  const h = await setup(db), gate = deferred(), entered = deferred();
  const pending: Promise<unknown>[] = [];
  try {
    const d = await delivery(h, db);
    const internal = h.orch as any, validate = internal.validateMachineAgentMessage.bind(h.orch);
    internal.validateMachineAgentMessage = async (...args: unknown[]) => { entered.resolve(); await gate.promise; return validate(...args); };
    pending.push(h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_received"), h.ws as never));
    await entered.promise;
    pending.push(h.orch.handleMachineMessage(h.machine.id, transition(h, d, "daemon_drained"), h.ws as never));
    pending.push(h.orch.handleMachineMessage(h.machine.id, ack(h, d), h.ws as never));
    internal.machineConnections.get(h.machine.id).ws = { ...h.ws };
    gate.resolve(); await Promise.all(pending);
    const row = await getMentionDeliveryOccurrence(d.message.id, h.agent.id);
    assert.equal(row?.state, "daemon_received");
    assert.equal(row?.daemonDrainedAt, null);
    assert.equal(row?.ackedAt, null);
    assert.equal(internal.mentionReceiptQueues.size, 0);
  } finally { gate.resolve(); await Promise.allSettled(pending); await h.orch.shutdown(); }
});
