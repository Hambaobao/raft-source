import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { users, messages, agentChannelReadCursors } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, assignMachine } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { findOrCreateDM, canAgentAccessChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import type { Database } from "../db/index";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
const originalBindings = process.env.RAFT_EXTERNAL_DM_BINDINGS;
afterEach(() => { if (originalBindings === undefined) delete process.env.RAFT_EXTERNAL_DM_BINDINGS; else process.env.RAFT_EXTERNAL_DM_BINDINGS = originalBindings; });
async function fixture(db: Database, baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `dm-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const server = await createServer("Direct messages", `dm-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `lead-${suffix}`, { runtime: "claude", model: "sonnet" });
  const bridge = await createAgent(server.id, `bridge-${suffix}`, { runtime: "external", model: "external" });
  const { machine } = await registerMachine(server.id, owner.id, "test-machine"); await assignMachine(agent.id, machine.id);
  const credential = await mintAgentCredential({ agentId: bridge.id, scopes: ["read", "send"], name: "dm-bridge", createdByUserId: null });
  const leadKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "dm-lead", createdByUserId: null });
  const binding = { id: "personal", serverId: server.id, bridgeAgentId: bridge.id, userId: owner.id, agentId: agent.id, externalUserId: "feishu-person" };
  process.env.RAFT_EXTERNAL_DM_BINDINGS = JSON.stringify([binding]);
  const call = (path: string, body?: unknown, token = credential.apiKey) => fetch(baseUrl + "/internal/agent-api" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = (overrides: Record<string, unknown> = {}) => call("/external-dm/personal/messages", { externalUserId: binding.externalUserId, externalMessageId: randomUUID(), content: "hi", ...overrides });
  const replies = (id: string, query = "") => call(`/external-dm/personal/messages/${id}/replies?externalUserId=feishu-person${query}`);
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
    const response = await h.call("/send", { target, content, externalReply: { messageId }, idempotencyKey: randomUUID() }, h.leadKey.apiKey);
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
  assert.equal((await h.call('/external-dm/personal?externalUserId=feishu-person')).status, 200);
  assert.equal((await h.send({ externalUserId: "another-person" })).status, 404);
  assert.equal((await h.send({ userId: h.owner.id })).status, 400);
  assert.equal((await h.call('/external-dm/personal/messages', body, h.leadKey.apiKey)).status, 404);
  const readOnly = await mintAgentCredential({ agentId: h.bridge.id, scopes: ["read"], name: "read-only", createdByUserId: null });
  assert.equal((await h.call('/external-dm/personal/messages', body, readOnly.apiKey)).status, 403);
  process.env.RAFT_EXTERNAL_DM_BINDINGS = JSON.stringify([h.binding, h.binding]);
  assert.equal((await h.send()).status, 503);
  process.env.RAFT_EXTERNAL_DM_BINDINGS = '[]';
  assert.equal((await h.send()).status, 404);
  process.env.RAFT_EXTERNAL_DM_BINDINGS = JSON.stringify([h.binding]);
  const sent = await h.send(), origin = await sent.json(); assert.equal(sent.status, 200);
  process.env.RAFT_EXTERNAL_DM_BINDINGS = '[]';
  assert.equal((await h.replies(origin.messageId)).status, 404);
});
