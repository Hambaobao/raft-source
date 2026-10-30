import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { users, messages, agentChannelReadCursors, channelAgents, channelHumans } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, assignMachine } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { findOrCreateDM, canAgentAccessChannel, createChannel, addAgent, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import type { Database } from "../db/index";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
const originalBindings = process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS;
afterEach(() => { if (originalBindings === undefined) delete process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS; else process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = originalBindings; });
async function fixture(db: Database, baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `dm-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const server = await createServer("Direct messages", `dm-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `lead-${suffix}`, { runtime: "claude", model: "sonnet" });
  const bridge = await createAgent(server.id, `bridge-${suffix}`, { runtime: "external", model: "external" });
  const { machine } = await registerMachine(server.id, owner.id, "test-machine"); await assignMachine(agent.id, machine.id);
  const credential = await mintAgentCredential({ agentId: bridge.id, scopes: ["read", "send"], name: "dm-bridge", createdByUserId: null });
  const leadKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "dm-lead", createdByUserId: null });
  const binding = { id: "personal", serverId: server.id, bridgeAgentId: bridge.id, userId: owner.id, agentId: agent.id, externalUserId: "feishu-person", allowTopics: false };
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = JSON.stringify([binding]);
  const call = (path: string, body?: unknown, token = credential.apiKey) => fetch(baseUrl + "/internal/agent-api" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = (overrides: Record<string, unknown> = {}) => call("/external-messages/personal/messages", { externalUserId: binding.externalUserId, externalMessageId: randomUUID(), content: "hi", ...overrides });
  const replies = (id: string, query = "") => call(`/external-messages/personal/messages/${id}/replies?externalUserId=feishu-person${query}`);
  return { owner, server, agent, bridge, binding, credential, leadKey, call, send, replies };
}

test("external DM sends are plain human messages in the same persistent DM as the Web UI", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl);
  const webDm = await findOrCreateDM(h.server.id, h.owner.id, h.agent.id); assert.ok(webDm);
  const first = await h.send({ externalMessageId: "first" }); const result = await first.json();
  assert.equal(first.status, 200, JSON.stringify(result)); assert.equal(result.channelId, webDm.id);
  const next = await h.send({ content: "how are you?" }); assert.equal(next.status, 200); assert.equal((await next.json()).channelId, webDm.id);
  const [stored] = await db.select().from(messages).where(eq(messages.id, result.messageId));
  assert.equal(stored.senderType, "user"); assert.equal(stored.senderId, h.owner.id); assert.equal(stored.content, "hi");
  assert.equal(stored.threadId, null); assert.equal(stored.taskStatus, null);
  assert.equal((stored.actionMetadata as { kind: string }).kind, "external-dm");
  assert.equal(await canAgentAccessChannel(webDm.id, h.bridge.id), false);
  const replay = await h.send({ externalMessageId: "first" }); assert.equal(replay.status, 200); assert.equal((await replay.json()).messageId, result.messageId);
  assert.equal((await h.send({ externalMessageId: "first", content: "changed" })).status, 409);
});

test("normal DM replies follow the external input window and exclude later Web-only answers", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl), sent = await h.send(), origin = await sent.json(); assert.equal(sent.status, 200, JSON.stringify(origin));
  for (const content of ["checking", "plain DM answer"]) {
    const response = await h.call("/send", { target: `dm:@${h.owner.name}~human`, content }, h.leadKey.apiKey);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  const webMessage = await createMessage(origin.channelId, "user", h.owner.id, "web-only question");
  await createMessage(origin.channelId, "agent", h.agent.id, "private unlinked discussion");
  const target = `dm:@${h.owner.name}~human`;
  for (const [messageId, content] of [[webMessage.id, "web-only answer"], [origin.messageId, "hello from the lead"]]) {
    const response = await h.call("/send", { target, content, replyTo: messageId, idempotencyKey: randomUUID() }, h.leadKey.apiKey);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  let page = await h.replies(origin.messageId); assert.equal(page.status, 200); let body = await page.json();
  assert.deepEqual(body.messages.map((m: { content: string }) => m.content), ["checking", "plain DM answer", "hello from the lead"]);
  assert.equal(body.superseded, true); assert.equal(body.delivery.outcome, "pending"); assert.equal(body.delivery.signal, "read_cursor");
  await db.insert(agentChannelReadCursors).values({ agentId: h.agent.id, channelId: origin.channelId, lastReadSeq: origin.messageSeq })
    .onConflictDoUpdate({ target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId], set: { lastReadSeq: origin.messageSeq } });
  body = await (await h.replies(origin.messageId)).json(); assert.equal(body.delivery.outcome, "read");
  assert.equal((await h.replies(webMessage.id)).status, 404);
  assert.equal((await h.replies(randomUUID())).status, 404);
  assert.equal((await h.call('/history?channel='+encodeURIComponent(`dm:@${h.agent.name}~agent`))).status, 404);
});

test("DM delegation rejects wrong credentials, users, malformed or removed bindings", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl);
  const body = { externalUserId: "feishu-person", externalMessageId: "in", content: "hi" };
  assert.equal((await h.call('/external-messages/personal?externalUserId=feishu-person')).status, 200);
  assert.equal((await h.send({ externalUserId: "another-person" })).status, 404);
  assert.equal((await h.send({ userId: h.owner.id })).status, 400);
  assert.equal((await h.call('/external-messages/personal/messages', body, h.leadKey.apiKey)).status, 404);
  const readOnly = await mintAgentCredential({ agentId: h.bridge.id, scopes: ["read"], name: "read-only", createdByUserId: null });
  assert.equal((await h.call('/external-messages/personal/messages', body, readOnly.apiKey)).status, 403);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = JSON.stringify([h.binding, h.binding]);
  assert.equal((await h.send()).status, 503);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = '[]';
  assert.equal((await h.send()).status, 404);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = JSON.stringify([h.binding]);
  const sent = await h.send(), origin = await sent.json(); assert.equal(sent.status, 200);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = '[]';
  assert.equal((await h.replies(origin.messageId)).status, 404);
});

async function topicFixture(db: Database, baseUrl: string) {
  const h = await fixture(db, baseUrl);
  h.binding.allowTopics = true; process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = JSON.stringify([h.binding]);
  const channel = await createChannel(h.server.id, `topic-${randomUUID().slice(0, 8)}`, undefined, "private", {
    type: "agent", id: h.bridge.id, initialUserIds: [h.owner.id], initialAgentIds: [h.agent.id],
  });
  const send = (overrides: Record<string, unknown> = {}, channelId = channel.id) => h.call(`/external-messages/personal/topics/${channelId}/messages`, {
    externalUserId: "feishu-person", externalConversationId: "topic-one", externalMessageId: randomUUID(), content: "Please calculate this", ...overrides,
  });
  const replies = (id: string, extra = "") => h.call(`/external-messages/personal/topics/${channel.id}/messages/${id}/replies?externalUserId=feishu-person&externalConversationId=topic-one${extra}`);
  return { ...h, channel, topicSend: send, topicReplies: replies };
}

test("topic input is a scoped human message and only exact leader replies return", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), first = await h.topicSend({ externalMessageId: "first" }), origin = await first.json();
  assert.equal(first.status, 200, JSON.stringify(origin));
  const [stored] = await db.select().from(messages).where(eq(messages.id, origin.messageId));
  assert.equal(stored.senderType, "user"); assert.equal(stored.senderId, h.owner.id); assert.equal(stored.content, "Please calculate this");
  assert.equal(stored.threadId, null); assert.equal(stored.taskStatus, null);
  assert.equal((stored.actionMetadata as {kind:string}).kind, "external-topic");
  const replay = await h.topicSend({ externalMessageId: "first" }); assert.equal((await replay.json()).messageId, origin.messageId);
  assert.equal((await h.topicSend({ externalMessageId: "first", content: "changed" })).status, 409);
  assert.equal((await h.topicSend({ externalMessageId: "first", externalConversationId: "other-topic" })).status, 409);
  assert.equal((await h.send({ externalMessageId: "first" })).status, 409);
  assert.equal((await h.send({ externalMessageId: "dm-first" })).status, 200);
  assert.equal((await h.topicSend({ externalMessageId: "dm-first" })).status, 409);
  const another = await createChannel(h.server.id, `another-${randomUUID().slice(0,8)}`, undefined, "private", {
    type: "agent", id: h.bridge.id, initialUserIds: [h.owner.id], initialAgentIds: [h.agent.id],
  });
  assert.equal((await h.topicSend({ externalMessageId: "first" }, another.id)).status, 409);
  const worker = await createAgent(h.server.id, `worker-${randomUUID().slice(0,8)}`, { runtime: "claude", model: "sonnet" });
  await addAgent(h.channel.id, worker.id);
  await createMessage(h.channel.id, "user", "system", "A worker was added", "system");
  await createMessage(h.channel.id, "agent", worker.id, "Internal worker report", "chat", undefined, { actionMetadata: { kind: "reply", messageId: origin.messageId } });
  const internal = await createMessage(h.channel.id, "agent", worker.id, "Internal question");
  for (const [content, replyTo] of [["Internal assignment", undefined], ["Answer to worker", internal.id], ["Human answer", origin.messageId]]) {
    const response = await h.call("/send", { target: `#${h.channel.name}`, content, replyTo }, h.leadKey.apiKey);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  let page = await h.topicReplies(origin.messageId), body = await page.json(); assert.equal(page.status, 200, JSON.stringify(body));
  assert.deepEqual(body.messages.map((m: {content:string}) => m.content), ["Human answer"]);
  assert.equal(body.superseded, false);
  assert.equal(body.delivery.outcome, "pending");
  await db.insert(agentChannelReadCursors).values({ agentId: h.agent.id, channelId: h.channel.id, lastReadSeq: origin.messageSeq });
  body = await (await h.topicReplies(origin.messageId)).json(); assert.equal(body.delivery.outcome, "read");
  const correction = await h.topicSend({ content: "Change the discount" }); assert.equal(correction.status, 200);
  await h.call("/send", { target: `#${h.channel.name}`, content: "Stale answer", replyTo: origin.messageId }, h.leadKey.apiKey);
  body = await (await h.topicReplies(origin.messageId)).json();
  assert.equal(body.superseded, true); assert.deepEqual(body.messages.map((m: {content:string}) => m.content), ["Human answer"]);
  const correctionId = (await correction.json()).messageId;
  assert.deepEqual((await (await h.topicReplies(correctionId)).json()).messages, []);
});

test("topic delegation requires private Bridge administration, current members and exact origin scope", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), sent = await h.topicSend(), origin = await sent.json(); assert.equal(sent.status, 200);
  assert.equal((await h.topicSend({ externalUserId: "another" })).status, 404);
  assert.equal((await h.topicSend({ userId: h.owner.id })).status, 400);
  const badScope = await h.call(`/external-messages/personal/topics/${h.channel.id}/messages/${origin.messageId}/replies?externalUserId=feishu-person&externalConversationId=other`);
  assert.equal(badScope.status, 404);
  const dm = await findOrCreateDM(h.server.id, h.owner.id, h.agent.id); assert.equal((await h.topicSend({}, dm!.id)).status, 404);
  const other = await createChannel(h.server.id, `unmanaged-${randomUUID().slice(0,8)}`, undefined, "private");
  await addHuman(other.id, h.owner.id); await addAgent(other.id, h.agent.id); await addAgent(other.id, h.bridge.id);
  assert.equal((await h.topicSend({}, other.id)).status, 404);
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, h.channel.id), eq(channelHumans.userId, h.owner.id)));
  assert.equal((await h.topicSend()).status, 404); assert.equal((await h.topicReplies(origin.messageId)).status, 404);
  await addHuman(h.channel.id, h.owner.id);
  await db.update(channelAgents).set({role:"member"}).where(and(eq(channelAgents.channelId, h.channel.id),eq(channelAgents.agentId,h.bridge.id)));
  assert.equal((await h.topicSend()).status, 404);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = JSON.stringify([{...h.binding,allowTopics:false}]);
  assert.equal((await h.topicReplies(origin.messageId)).status, 404);
});
