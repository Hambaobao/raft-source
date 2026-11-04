import { Readable } from "node:stream";
import { __setStorageForTests, __setCdnStorageForTests, resetStorageForTests, type StorageBackend } from "../services/storageService";
import assert from "node:assert/strict";
import { applyAgentModelSeen } from "../services/agentModelSeen";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { attachments, users, serverMembers, channels, messages, messageMentions, agents, agentChannelReadCursors, channelAgents, channelHumans } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, assignMachine } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { findOrCreateDM, canAgentAccessChannel, createChannel, addAgent, addHuman, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { renderAgentReadablePermalinks } from "../services/agentPermalinkRenderService";
import { mintAgentCredential } from "../services/agentCredentialService";
import type { Database } from "../db/index";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
const originalBindings = process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS;
afterEach(() => { resetStorageForTests(); if (originalBindings === undefined) delete process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS; else process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = originalBindings; });

for (const kind of ["dm", "topic"] as const) test(`external ${kind} replies persist native quotes for Web and Agent reads and survive retries`, async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl);
  const send = kind === "dm" ? h.send : h.topicSend;
  const first = await (await send()).json();
  const original = await createMessage(first.channelId, "agent", h.agent.id, "I can draft the guidelines");
  const input = { externalMessageId: "quoted", content: "Please draft it", replyTo: original.id, mentionRecipient: true };
  const body = kind === "dm" ? { externalMessageId: input.externalMessageId, content: input.content, replyTo: input.replyTo } : input;
  const response = await send(body), receipt = await response.json();assert.equal(response.status,200,JSON.stringify(receipt));
  const [stored] = await db.select().from(messages).where(eq(messages.id,receipt.messageId));
  assert.equal(stored.threadId,null);assert.equal(stored.senderId,h.owner.id);
  assert.equal((stored.actionMetadata as {replyTo:string}).replyTo,original.id);
  const url = new URL(stored.content.split("\n")[0]);
  assert.equal(url.searchParams.get("msg"),original.id);assert.equal(url.pathname,`/s/${h.server.slug}/${kind==="dm"?"dm":"channel"}/${first.channelId}`);
  assert.ok(stored.content.endsWith(kind==="dm"?input.content:`<@${h.agent.name}>\n${input.content}`));
  const rendered = await renderAgentReadablePermalinks(stored.content,h.server.id);
  if (kind === "dm") {
    const referencedId = rendered.match(/raft message resolve ([0-9a-f-]+)/)?.[1];
    assert.equal(referencedId, original.id);
    // Exercise the entry point the Agent is actually shown, with its own
    // credential, rather than merely checking a substring in the reference.
    const read = await h.call(`/messages/${referencedId}/resolve`, undefined, h.leadKey.apiKey);
    assert.equal(read.status, 200);
    const { message } = await read.json();
    assert.equal(message.message_id, original.id);
    assert.equal(message.content, original.content);
    assert.equal(message.channel_name, h.owner.name);
    const denied = await h.call(`/messages/${referencedId}/resolve`);
    assert.equal(denied.status, 404, "the Bridge credential cannot read the Agent's private DM");
  } else {
    assert.ok(rendered.includes(`msg=${original.id.slice(0,8)}`),rendered);
  }
  assert.ok(rendered.includes("Please draft it"));
  const beforeUrl = process.env.APP_URL;
  try {
    process.env.APP_URL="https://changed.example";
    const replay=await send(body);assert.equal(replay.status,200);assert.equal((await replay.json()).messageId,receipt.messageId);
  } finally { if(beforeUrl===undefined)delete process.env.APP_URL;else process.env.APP_URL=beforeUrl; }
  assert.equal((await send({...body,replyTo:first.messageId})).status,409);
  assert.equal((await send({...body,content:"changed"})).status,409);
  assert.equal((await send({...body,replyTo:undefined})).status,409);
  const another = await send({replyTo:first.messageId});assert.equal(another.status,200);
});

test("external quotes reject missing, cross-channel, system and malformed targets without sending",async({db,app})=>{
  const h=await topicFixture(db,app.baseUrl);
  const dm=await (await h.send()).json(),topic=await (await h.topicSend()).json();
  const system=await createMessage(topic.channelId,"user","system","Internal event","system");
  const before=await db.select({id:messages.id}).from(messages);
  assert.equal((await h.send({replyTo:topic.messageId})).status,404);
  assert.equal((await h.topicSend({replyTo:dm.messageId})).status,404);
  assert.equal((await h.topicSend({replyTo:system.id})).status,404);
  assert.equal((await h.send({replyTo:randomUUID()})).status,404);
  assert.equal((await h.send({replyTo:"bad"})).status,400);
  assert.equal((await h.topicSend({replyTo:"bad"})).status,400);
  assert.equal((await db.select({id:messages.id}).from(messages)).length,before.length);
});
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

test("DM stream keeps its stable binding across later Web and external inputs", async ({ db, app }) => {
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
  assert.deepEqual(body.messages.map((m: { content: string }) => m.content), ["checking", "plain DM answer", "private unlinked discussion", "web-only answer", "hello from the lead"]);
  assert.equal(body.delivery.lastReadSeq, 0); assert.equal(body.delivery.signal, "message_body_read_or_cursor");
  await db.insert(agentChannelReadCursors).values({ agentId: h.agent.id, channelId: origin.channelId, lastReadSeq: origin.messageSeq })
    .onConflictDoUpdate({ target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId], set: { lastReadSeq: origin.messageSeq } });
  body = await (await h.replies(origin.messageId)).json(); assert.ok(body.delivery.lastReadSeq > 0);
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
    externalUserId: "feishu-person", externalConversationId: "topic-one", mentionRecipient: false, externalMessageId: randomUUID(), content: "Please calculate this", ...overrides,
  });
  const replies = (id: string, extra = "") => h.call(`/external-messages/personal/topics/${channel.id}/messages?anchorMessageId=${id}&externalUserId=feishu-person&externalConversationId=topic-one${extra}`);
  return { ...h, channel, topicSend: send, topicReplies: replies };
}

test("topic input is scoped and human replies retain their original target after corrections", async ({ db, app }) => {
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
  await createMessage(h.channel.id, "agent", worker.id, "Internal worker report", "chat", undefined, { actionMetadata: { kind: "message", replyTo: origin.messageId } });
  const internal = await createMessage(h.channel.id, "agent", worker.id, "Internal question");
  for (const [content, replyTo] of [["Internal assignment", undefined], ["Answer to worker", internal.id], ["Human answer", origin.messageId]]) {
    const response = await h.call("/send", { target: `#${h.channel.name}`, content, replyTo }, h.leadKey.apiKey);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  let page = await h.topicReplies(origin.messageId), body = await page.json(); assert.equal(page.status, 200, JSON.stringify(body));
  assert.deepEqual(body.messages.map((m: {content:string}) => m.content), ["Human answer"]);
  assert.equal(body.messages[0].recipientReplyTo, origin.messageId);
  assert.equal(body.delivery.lastReadSeq, 0);
  await db.insert(agentChannelReadCursors).values({ agentId: h.agent.id, channelId: h.channel.id, lastReadSeq: origin.messageSeq });
  body = await (await h.topicReplies(origin.messageId)).json(); assert.equal(body.delivery.lastReadSeq, origin.messageSeq);
  const correction = await h.topicSend({ content: "Change the discount" }); assert.equal(correction.status, 200);
  await h.call("/send", { target: `#${h.channel.name}`, content: "Stale answer", replyTo: origin.messageId }, h.leadKey.apiKey);
  body = await (await h.topicReplies(origin.messageId)).json();
  assert.deepEqual(body.messages.map((m: {content:string}) => m.content), ["Human answer", "Stale answer"]);
  const correctionId = (await correction.json()).messageId;
  const later = (await (await h.topicReplies(correctionId)).json()).messages;
  assert.deepEqual(later.map((m: {content:string}) => m.content), ["Stale answer"]);
  assert.equal(later[0].recipientReplyTo, origin.messageId);
});

test("topic delegation requires private Bridge administration, current members and exact origin scope", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), sent = await h.topicSend(), origin = await sent.json(); assert.equal(sent.status, 200);
  assert.equal((await h.topicSend({ externalUserId: "another" })).status, 404);
  assert.equal((await h.topicSend({ userId: h.owner.id })).status, 400);
  const badScope = await h.call(`/external-messages/personal/topics/${h.channel.id}/messages?anchorMessageId=${origin.messageId}&externalUserId=feishu-person&externalConversationId=other`);
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


test("topic automatic mentions bind the leader, deduplicate authored mentions and survive rename retries", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl);
  await db.update(users).set({ name: h.agent.name }).where(eq(users.id, h.owner.id));
  const first = await h.topicSend({ externalMessageId: "mentioned", mentionRecipient: true });
  const body = await first.json(); assert.equal(first.status, 200, JSON.stringify(body));
  const [message] = await db.select().from(messages).where(eq(messages.id, body.messageId));
  assert.equal(message.content, `<@${h.agent.name}>\nPlease calculate this`);
  const mentions = await db.select().from(messageMentions).where(eq(messageMentions.messageId, body.messageId));
  assert.deepEqual(mentions.map(m => [m.targetType,m.targetId]), [["agent",h.agent.id]]);
  const text = `@${h.agent.name} please check this`;
  const manual = await h.topicSend({ content: text, mentionRecipient: true }); const manualBody = await manual.json();
  assert.equal(manual.status, 200, JSON.stringify(manualBody));
  assert.equal((await db.select().from(messages).where(eq(messages.id,manualBody.messageId)))[0].content,text);
  const newName = `renamed-${randomUUID().slice(0,8)}`;
  await db.update(agents).set({name:newName}).where(eq(agents.id,h.agent.id));
  const retry = await h.topicSend({ externalMessageId: "mentioned", mentionRecipient: true });
  assert.equal(retry.status,200); assert.equal((await retry.json()).messageId,body.messageId);
  assert.equal((await h.topicSend({ externalMessageId: "mentioned", mentionRecipient: false })).status,409);
});

test("external reply presentation uses exact recipient mention facts, not matching text", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), sent = await h.topicSend(), origin = await sent.json();
  for (const content of ["@" + h.owner.name + " result", "`@" + h.owner.name + "` is a code example"]) {
    const r=await h.call("/send",{target:`#${h.channel.name}`,content,replyTo:origin.messageId},h.leadKey.apiKey);
    assert.equal(r.status,200,JSON.stringify(await r.json()));
  }
  await db.update(users).set({name:`renamed-${randomUUID().slice(0,8)}`}).where(eq(users.id,h.owner.id));
  const page=await (await h.topicReplies(origin.messageId)).json();
  assert.equal(page.recipientId,h.owner.id);
  assert.equal(page.messages[0].recipientMentionPrefix,`@${h.owner.name} `);
  assert.equal(page.messages[1].recipientMentionPrefix,null);
});

test("topic stream forwards real leader mentions or human replies, including Web input, exactly once", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl);
  const origin = await (await h.topicSend({ externalMessageId: "origin" })).json();
  const web = await createMessage(h.channel.id, "user", h.owner.id, "Web follow-up");
  const worker = await createAgent(h.server.id, `helper-${randomUUID().slice(0,8)}`, { runtime: "claude", model: "sonnet" });
  await addAgent(h.channel.id, worker.id);
  const workerKey = await mintAgentCredential({ agentId: worker.id, scopes: ["send"], name: "helper", createdByUserId: null });
  const internal = await createMessage(h.channel.id, "agent", worker.id, "Internal question");
  const [other] = await db.insert(users).values({ email: `other-${randomUUID()}@raft.test`, name: `other-${randomUUID().slice(0,8)}`,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  await db.insert(serverMembers).values({serverId:h.server.id,userId:other.id,role:"member"});
  await addHuman(h.channel.id, other.id);
  for (const [content, replyTo, token] of [
    [`@${h.owner.name} proactive`, undefined, h.leadKey.apiKey],
    ["Web reply", web.id, h.leadKey.apiKey],
    [`@${h.owner.name} both`, origin.messageId, h.leadKey.apiKey],
    [`@${h.owner.name} worker report`, origin.messageId, workerKey.apiKey],
    ["Reply to worker", internal.id, h.leadKey.apiKey],
    [`Plain ${h.owner.name}`, undefined, h.leadKey.apiKey],
    ["`@" + h.owner.name + "` code example", undefined, h.leadKey.apiKey],
    [`@${other.name} other recipient`, undefined, h.leadKey.apiKey],
  ]) {
    const r = await h.call("/send", { target: `#${h.channel.name}`, content, replyTo }, token);
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  }
  const response = await h.topicReplies(origin.messageId), page = await response.json();
  assert.equal(response.status, 200, JSON.stringify(page));
  assert.deepEqual(page.messages.map((m: {content:string}) => m.content), [`@${h.owner.name} proactive`, "Web reply", `@${h.owner.name} both`]);
  assert.deepEqual(page.messages.map((m: {recipientMentioned:boolean;recipientReplyTo:string|null;quote:{externalMessageId:string|null}|null}) =>
    [m.recipientMentioned, m.recipientReplyTo, m.quote?.externalMessageId??null]), [[true,null,null],[false,web.id,null],[true,origin.messageId,"origin"]]);
  assert.equal((await (await h.topicReplies(origin.messageId, `&after=${page.nextSeq}`)).json()).messages.length,0);
  assert.equal((await h.topicReplies(web.id)).status,404);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = '[]';
  assert.equal((await h.topicReplies(origin.messageId)).status,404);
});

test("topic stream advances across internal-only pages and resumes without duplicating eligible messages", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), origin = await (await h.topicSend()).json();
  for(let i=0;i<100;i++) await createMessage(h.channel.id,"agent",h.agent.id,"Internal note");
  const r=await h.call("/send",{target:`#${h.channel.name}`,content:`@${h.owner.name} update`},h.leadKey.apiKey);
  assert.equal(r.status,200,JSON.stringify(await r.json()));
  const first=await (await h.topicReplies(origin.messageId)).json();
  assert.equal(first.hasMore,true);assert.deepEqual(first.messages,[]);assert.ok(first.nextSeq>origin.messageSeq);
  const second=await (await h.topicReplies(origin.messageId,`&after=${first.nextSeq}`)).json();
  assert.equal(second.hasMore,false);assert.equal(second.messages.length,1);assert.ok(second.nextSeq>first.nextSeq);
  const third=await (await h.topicReplies(origin.messageId,`&after=${second.nextSeq}`)).json();
  assert.deepEqual(third.messages,[]);assert.equal(third.nextSeq,second.nextSeq);
});

test("DM body consumption is visible without advancing the contiguous cursor", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl);
  const origin = await (await h.send()).json();
  assert.deepEqual((await (await h.replies(origin.messageId)).json()).delivery.readMessageIds, []);
  await applyAgentModelSeen({ agentId: h.agent.id, serverId: h.server.id, channelId: origin.channelId, seqs: [origin.messageSeq] });
  const result = await (await h.replies(origin.messageId, "&readMessageIds="+origin.messageId)).json();
  assert.deepEqual(result.delivery.readMessageIds, [origin.messageId]);
  assert.equal(result.delivery.signal, "message_body_read_or_cursor");
});
test("topic read facts are exact and scoped to its bound human, agent and conversation", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl);
  const first = await (await h.topicSend()).json();
  const second = await (await h.topicSend()).json();
  const differentScope = await (await h.topicSend({ externalConversationId: "another-topic" })).json();
  await applyAgentModelSeen({ agentId: h.agent.id, serverId: h.server.id, channelId: h.channel.id, seqs: [second.messageSeq, differentScope.messageSeq] });
  const result = await (await h.topicReplies(first.messageId, "&readMessageIds=" + [first.messageId, second.messageId, differentScope.messageId, randomUUID()].join(","))).json();
  assert.equal(result.delivery.signal, "message_body_read_or_cursor");
  assert.deepEqual(result.delivery.readMessageIds, [second.messageId]);
  assert.ok(result.delivery.lastReadSeq < first.messageSeq);
  assert.equal((await h.topicReplies(first.messageId, "&readMessageIds=bad")).status, 400);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = "[]";
  assert.equal((await h.topicReplies(first.messageId, "&readMessageIds=" + second.messageId)).status, 404);
});

for (const kind of ["dm", "topic"] as const) {
  test(`${kind} user mirroring is opt-in, native-only, bound-user-only and paginated`, async ({ db, app }) => {
    const h = await topicFixture(db, app.baseUrl);
    const send = kind === "dm" ? h.send : h.topicSend;
    const replies = kind === "dm" ? h.replies : h.topicReplies;
    const origin = await (await send()).json();
    const native = await createMessage(origin.channelId, "user", h.owner.id, "Web **message**");
    await send({ content: "Feishu echo" });
    await createMessage(origin.channelId, "user", h.owner.id, "Other bridge", "chat", undefined,
      { actionMetadata: { kind: "external-dm", bindingId: "another" } });
    await createMessage(origin.channelId, "user", h.owner.id, "System event", "system");
    await createMessage(origin.channelId, "user", "someone-else", "Other person");
    await createMessage(origin.channelId, "agent", h.agent.id, "Internal agent message");
    assert.equal((await (await replies(origin.messageId)).json()).userMessages, undefined);
    const response = await replies(origin.messageId, "&includeUserMessages=true"), page = await response.json();
    assert.equal(response.status, 200, JSON.stringify(page));
    assert.deepEqual(page.userMessages, [{ id: native.id, seq: native.seq, channelId: origin.channelId,
      senderId: h.owner.id, senderType: "user", senderName: h.owner.displayName || h.owner.name, content: "Web **message**" }]);
    assert.deepEqual((await (await replies(origin.messageId, "&includeUserMessages=true&after="+page.nextSeq)).json()).userMessages, []);
    for (let i=0; i<100; i++) await createMessage(origin.channelId, "agent", h.bridge.id, "Internal");
    const next = await createMessage(origin.channelId, "user", h.owner.id, "Later Web input");
    const empty = await (await replies(origin.messageId, "&includeUserMessages=true&after="+page.nextSeq)).json();
    assert.equal(empty.hasMore, true);assert.deepEqual(empty.userMessages, []);
    const last = await (await replies(origin.messageId, "&includeUserMessages=true&after="+empty.nextSeq)).json();
    assert.deepEqual(last.userMessages.map((m: {id:string}) => m.id), [next.id]);
    assert.equal((await replies(native.id, "&includeUserMessages=true")).status, 404);
    assert.equal((await replies(origin.messageId, "&includeUserMessages=garbage")).status, 400);
    process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS = "[]";
    assert.equal((await replies(origin.messageId, "&includeUserMessages=true")).status, 404);
  });
}


test("topic threads relay addressed coordinator messages with native user sync and round-trip quotes", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl);
  const rootText="讨论方案调整 "+"🧭".repeat(45);
  const origin = await (await h.topicSend({externalMessageId:"thread-root",content:`<@${h.agent.name}>\n${rootText}`})).json();
  const thread = await getOrCreateThread(origin.messageId, h.agent.id, "agent");
  const target = `#${h.channel.name}:${origin.messageId.slice(0,8)}`;
  const send = async (content: string, extra = {}) => {
    const r = await h.call("/send", { target, content, ...extra }, h.leadKey.apiKey);
    const body = await r.json(); assert.equal(r.status,200,JSON.stringify(body)); return body;
  };
  const update = await send(`@${h.owner.name} thread update`);
  await send("Internal discussion");
  const native = await createMessage(thread.id,"user",h.owner.id,"Thread web input");
  const answer = await send("Answer to thread input",{replyTo:native.id});
  // Completion/root relations are scoped to this thread and its own root.
  const completion = await createMessage(thread.id,"agent",h.agent.id,"Root answer","chat",undefined,
    {actionMetadata:{kind:"message",replyTo:origin.messageId,completedInputMessageIds:[origin.messageId]}});
  const main = await h.call("/send",{target:`#${h.channel.name}`,content:`@${h.owner.name} main update`},h.leadKey.apiKey);
  assert.equal(main.status,200);
  const old = await (await h.topicReplies(origin.messageId)).json();
  assert.deepEqual(old.messages.map((m:{content:string})=>m.content),[`@${h.owner.name} main update`]);
  const page = await (await h.topicReplies(origin.messageId,"&includeThreadMessages=true&includeUserMessages=true")).json();
  assert.deepEqual(page.messages.map((m:{content:string})=>m.content),[`@${h.owner.name} thread update`,"Answer to thread input","Root answer",`@${h.owner.name} main update`]);
  for(const message of page.messages.slice(0,3)) {
    assert.equal(message.channelId,thread.id);
    assert.equal(message.thread.parentChannelId,h.channel.id);assert.equal(message.thread.parentMessageId,origin.messageId);
    assert.equal(message.thread.title,Array.from(rootText).slice(0,40).join("")+"…");
    const link=new URL(message.thread.url);
    assert.equal(link.pathname,`/s/${h.server.slug}/channel/${h.channel.id}`);
    assert.equal(link.searchParams.get("msg"),message.id);
    assert.equal(link.searchParams.get("thread"),`${h.channel.id}:${origin.messageId}`);
  }
  assert.equal(page.messages[0].recipientMentioned,true);
  assert.equal(page.messages[1].quote.messageId,native.id);
  assert.deepEqual(page.messages[2].completedInputs,[{messageId:origin.messageId,externalMessageId:"thread-root"}]);
  assert.equal(page.userMessages.length,1);assert.equal(page.userMessages[0].id,native.id);assert.equal(page.userMessages[0].thread.parentChannelId,h.channel.id);
  assert.equal(page.userMessages[0].thread.title,page.messages[0].thread.title);
  assert.equal(new URL(page.userMessages[0].thread.url).searchParams.get("msg"),native.id);
  assert.equal(page.messages.at(-1).thread,undefined);
  const mirrored = page.messages[0];
  const reply = await h.topicSend({content:"Reply from Feishu",replyTo:mirrored.id}), receipt = await reply.json();
  assert.equal(reply.status,200,JSON.stringify(receipt));
  const [stored] = await db.select().from(messages).where(eq(messages.id,receipt.messageId));
  const url = new URL(stored.content.split("\n")[0]);
  assert.equal(url.searchParams.get("msg"),mirrored.id);assert.equal(url.searchParams.get("thread"),`${h.channel.id}:${origin.messageId}`);
  const rendered = await renderAgentReadablePermalinks(stored.content,h.server.id);
  assert.ok(rendered.includes(`#${h.channel.name}:${origin.messageId.slice(0,8)}`),rendered);
  assert.ok(rendered.includes(`msg=${mirrored.id.slice(0,8)}`),rendered);
  const later = await (await h.topicReplies(origin.messageId,`&includeThreadMessages=true&after=${page.nextSeq}`)).json();
  assert.deepEqual(later.messages,[]);
});

test("topic threads exclude unrelated, deleted and unauthorized channels", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), origin = await (await h.topicSend()).json();
  const thread = await getOrCreateThread(origin.messageId,h.agent.id,"agent");
  const own = await h.call("/send",{target:`#${h.channel.name}:${origin.messageId.slice(0,8)}`,content:`@${h.owner.name} own update`},h.leadKey.apiKey);
  assert.equal(own.status,200);
  const other = await createChannel(h.server.id,`other-${randomUUID().slice(0,8)}`,undefined,"private",{
    type:"agent",id:h.bridge.id,initialUserIds:[h.owner.id],initialAgentIds:[h.agent.id]});
  const otherRoot = await createMessage(other.id,"user",h.owner.id,"Other root");
  const otherThread = await getOrCreateThread(otherRoot.id,h.agent.id,"agent");
  const hidden = await createMessage(otherThread.id,"agent",h.agent.id,"Other private thread");
  await db.insert(messageMentions).values({messageId:hidden.id,messageSeq:hidden.seq,serverId:h.server.id,channelId:otherThread.id,
    targetType:"user",targetId:h.owner.id,handleAtSendTime:h.owner.name,source:"send_path",confidence:"exact",notifiableAtSend:true});
  const page = await (await h.topicReplies(origin.messageId,"&includeThreadMessages=true")).json();
  assert.equal(page.messages.length,1);assert.equal(page.messages[0].channelId,thread.id);
  assert.equal((await h.topicSend({replyTo:hidden.id})).status,404);
  await db.update(channels).set({deletedAt:new Date()}).where(eq(channels.id,thread.id));
  assert.deepEqual((await (await h.topicReplies(origin.messageId,"&includeThreadMessages=true")).json()).messages,[]);
  assert.equal((await h.topicSend({replyTo:page.messages[0].id})).status,404);
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId,h.channel.id),eq(channelHumans.userId,h.owner.id)));
  assert.equal((await h.topicReplies(origin.messageId,"&includeThreadMessages=true")).status,404);
});

test("topic threads advance a shared cursor across internal pages without skipping parent messages", async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), origin = await (await h.topicSend()).json();
  const thread = await getOrCreateThread(origin.messageId,h.agent.id,"agent");
  for(let i=0;i<100;i++) await createMessage(thread.id,"agent",h.agent.id,"Internal thread note");
  for(const target of [`#${h.channel.name}`,`#${h.channel.name}:${origin.messageId.slice(0,8)}`]) {
    const r=await h.call("/send",{target,content:`@${h.owner.name} update`},h.leadKey.apiKey);assert.equal(r.status,200,JSON.stringify(await r.json()));
  }
  const first=await (await h.topicReplies(origin.messageId,"&includeThreadMessages=true")).json();
  assert.equal(first.hasMore,true);assert.deepEqual(first.messages,[]);
  const second=await (await h.topicReplies(origin.messageId,`&includeThreadMessages=true&after=${first.nextSeq}`)).json();
  assert.equal(second.hasMore,false);assert.deepEqual(second.messages.map((m:{channelId:string})=>m.channelId),[h.channel.id,thread.id]);
  const third=await (await h.topicReplies(origin.messageId,`&includeThreadMessages=true&after=${second.nextSeq}`)).json();
  assert.deepEqual(third.messages,[]);assert.equal(third.nextSeq,second.nextSeq);
});


test("topic thread context falls back to a short label when the root has only mentions and links",async({db,app})=>{
  const h=await topicFixture(db,app.baseUrl),origin=await (await h.topicSend({content:`<@${h.agent.name}>\nhttps://example.invalid/original`})).json();
  await getOrCreateThread(origin.messageId,h.agent.id,"agent");
  const r=await h.call("/send",{target:`#${h.channel.name}:${origin.messageId.slice(0,8)}`,content:`@${h.owner.name} update`},h.leadKey.apiKey);
  assert.equal(r.status,200,JSON.stringify(await r.json()));
  const page=await (await h.topicReplies(origin.messageId,"&includeThreadMessages=true")).json();
  assert.equal(page.messages[0].thread.title,"原讨论");
});

const testPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNw6TiDFTEMLQkAuRFmAYM6gOUAAAAASUVORK5CYII=', 'base64');
function attachmentStorage() {
  const blobs = new Map<string, Buffer>();
  const storage: StorageBackend = {
    async put(key, bytes) { blobs.set(key, Buffer.from(bytes)); },
    async get(key) { const bytes = blobs.get(key); assert.ok(bytes); return Readable.from([bytes]); },
    async delete(key) { blobs.delete(key); },
  };
  __setStorageForTests(storage); __setCdnStorageForTests(storage);
  return { blobs, storage };
}
function multipart(payload: unknown, files = [{ name: '截图.png', bytes: testPng }]) {
  const form = new FormData(); form.set('payload', JSON.stringify(payload));
  for (const file of files) form.append('files', new Blob([file.bytes]), file.name);
  return form;
}

for (const kind of ['dm', 'topic']) test(`${kind} external images become native attachments readable by Web and Agent, with stable replay`, async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), { blobs } = attachmentStorage();
  const endpoint = kind === 'dm' ? '/external-messages/personal/messages' : `/external-messages/personal/topics/${h.channel.id}/messages`;
  const payload = { externalUserId: h.binding.externalUserId, externalMessageId: 'image-with-caption', content: '请查看图片',
    ...(kind === 'topic' ? { externalConversationId: 'topic-one', mentionRecipient: true } : {}) };
  const files = [{ name: '截图.png', bytes: testPng }, { name: '报告.txt', bytes: Buffer.from('supporting file') }];
  const send = (body = payload, resources = files) => fetch(app.baseUrl + '/internal/agent-api' + endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${h.credential.apiKey}` }, body: multipart(body, resources),
  });
  assert.equal((await (await h.call('/context')).json()).features.externalMessageAttachments, true);
  const response = await send(), receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt));
  const [message] = await db.select().from(messages).where(eq(messages.id, receipt.messageId));
  const rows = (await db.select().from(attachments).where(eq(attachments.messageId, receipt.messageId))).sort((a,b) => a.messagePosition! - b.messagePosition!);
  assert.equal(rows.length, 2); assert.equal(message.senderId, h.owner.id); assert.ok(message.content.endsWith(payload.content));
  assert.deepEqual(rows.map(row => row.filename), ['截图.png', '报告.txt']);
  assert.equal(rows[0].mimeType, 'image/png'); assert.ok(rows[0].thumbnailKey);
  assert.ok(blobs.get(rows[0].thumbnailKey!)!.length > 0, 'native preview generation ran');
  for (const row of rows) { assert.equal(row.uploaderId, h.owner.id); assert.equal(row.channelId, receipt.channelId); }
  const resolved = await h.call(`/messages/${message.id}/resolve`, undefined, h.leadKey.apiKey);
  const resolvedBody = await resolved.json(); assert.equal(resolved.status, 200, JSON.stringify(resolvedBody));
  assert.deepEqual(resolvedBody.message.attachments.map((a: {id: string}) => a.id), rows.map(row => row.id));
  const bytes = await h.call(`/attachments/${rows[0].id}`, undefined, h.leadKey.apiKey);
  assert.equal(bytes.status, 200); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), testPng);
  if (kind === 'dm') assert.equal((await h.call(`/attachments/${rows[0].id}`)).status, 404, 'Bridge cannot read private DM files');
  const headers = { Authorization: `Bearer ${await tokenForHuman(h.owner.email)}`, 'X-Server-Id': h.server.id, 'Sec-Fetch-Site': 'same-origin' };
  const urlResponse = await fetch(`${app.baseUrl}/api/attachments/${rows[0].id}/url?disposition=attachment`, { headers });
  assert.equal(urlResponse.status, 200); const { url } = await urlResponse.json();
  assert.ok(url.startsWith(`/api/attachments/${rows[0].id}?`), url);
  const downloaded = await fetch(app.baseUrl + url); assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), testPng);
  const putCount = blobs.size;
  const replay = await send(); assert.equal(replay.status, 200); assert.equal((await replay.json()).messageId, receipt.messageId);
  assert.equal(blobs.size, putCount, 'lost receipts do not re-upload');
  assert.equal((await send(payload, [{...files[0], bytes: Buffer.from('changed')}, files[1]])).status, 409);
  assert.equal((await send(payload, [...files].reverse())).status, 409);
  assert.equal((await send(payload, [{...files[0], name: 'renamed.png'}, files[1]])).status, 409);
  assert.equal((await h.call(endpoint, payload)).status, 409, 'cannot replay without files');
  assert.equal((await db.select().from(attachments)).length, rows.length);
});

test('external attachment ingestion rejects unbound senders, wrong channels and invalid uploads before storage', async ({ db, app }) => {
  const h = await topicFixture(db, app.baseUrl), { blobs } = attachmentStorage();
  const body = { externalUserId: h.binding.externalUserId, externalMessageId: 'image', content: 'caption' };
  const dm = '/external-messages/personal/messages', topic = `/external-messages/personal/topics/${h.channel.id}/messages`;
  const topicBody = { ...body, externalConversationId: 'topic-one', mentionRecipient: false };
  const send = (endpoint: string, payload: unknown, token = h.credential.apiKey, form?: FormData) => fetch(app.baseUrl + '/internal/agent-api' + endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form ?? multipart(payload),
  });
  assert.equal((await send(dm, {...body, externalUserId: 'other'})).status, 404);
  assert.equal((await send(dm, {...body, userId: h.owner.id})).status, 400);
  assert.equal((await send(dm, {...body, attachmentIds: [randomUUID()]})).status, 400);
  assert.equal((await send(dm, body, h.leadKey.apiKey)).status, 404);
  const readonly = await mintAgentCredential({ agentId: h.bridge.id, scopes: ['read'], name: 'read-only', createdByUserId: null });
  assert.equal((await send(dm, body, readonly.apiKey)).status, 403);
  assert.equal((await send(topic.replace(h.channel.id, randomUUID()), topicBody)).status, 404);
  await db.update(channelAgents).set({role:'member'}).where(and(eq(channelAgents.channelId,h.channel.id),eq(channelAgents.agentId,h.bridge.id)));
  assert.equal((await send(topic, topicBody)).status, 404);
  await db.update(channelAgents).set({role:'admin'}).where(and(eq(channelAgents.channelId,h.channel.id),eq(channelAgents.agentId,h.bridge.id)));
  await db.update(channels).set({archivedAt:new Date()}).where(eq(channels.id,h.channel.id));
  assert.equal((await send(topic, topicBody)).status, 409);
  assert.equal((await send(dm, body, h.credential.apiKey, multipart(body, [{name:'empty.png',bytes:Buffer.alloc(0)}]))).status, 400);
  const malformed = multipart(body); malformed.set('payload', '{broken');
  assert.equal((await send(dm, body, h.credential.apiKey, malformed)).status, 400);
  assert.equal((await send(dm, body, h.credential.apiKey, multipart(body, [{name:'big.png',bytes:Buffer.alloc(20*1024*1024+1)}]))).status, 413);
  process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS='[]';
  assert.equal((await send(dm, body)).status, 404);
  assert.equal(blobs.size, 0); assert.equal((await db.select().from(attachments)).length, 0);
});

test('a failed external attachment upload creates no message and a retry keeps every file', async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl), { storage } = attachmentStorage();
  const put = storage.put.bind(storage); let fail = true;
  storage.put = async (...args) => { if (fail) { fail = false; throw new Error('test storage failure'); } return put(...args); };
  const body = { externalUserId: h.binding.externalUserId, externalMessageId: 'retry-files', content: '请读取附件并概述内容。' };
  const send = () => fetch(app.baseUrl + '/internal/agent-api/external-messages/personal/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${h.credential.apiKey}` }, body: multipart(body),
  });
  assert.equal((await send()).status, 500);
  assert.equal((await db.select().from(messages).where(eq(messages.senderId,h.owner.id))).length, 0);
  const retry = await send(), receipt = await retry.json(); assert.equal(retry.status, 200, JSON.stringify(receipt));
  const rows = await db.select().from(attachments).where(eq(attachments.messageId,receipt.messageId));
  assert.equal(rows.length, 1); assert.equal(rows[0].mimeType, 'image/png');
});

test('external uploads accept the full source-plus-quote file set and reject an extra part', async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl); attachmentStorage(); __setCdnStorageForTests(null);
  const files = Array.from({length:16}, (_,i) => ({name:`file-${i}.txt`,bytes:Buffer.from(`file ${i}`)}));
  const send = (count: number) => fetch(app.baseUrl + '/internal/agent-api/external-messages/personal/messages', {
    method:'POST',headers:{Authorization:`Bearer ${h.credential.apiKey}`},
    body:multipart({externalUserId:h.binding.externalUserId,externalMessageId:`files-${count}`,content:'Source and quoted files'},
      count===16 ? files : [...files, {name:'extra.txt',bytes:Buffer.from('extra')}]),
  });
  const response=await send(16),receipt=await response.json(); assert.equal(response.status,200,JSON.stringify(receipt));
  assert.equal((await db.select().from(attachments).where(eq(attachments.messageId,receipt.messageId))).length,16);
  assert.equal((await send(17)).status,400);
  assert.equal((await db.select().from(attachments)).length,16);
});
