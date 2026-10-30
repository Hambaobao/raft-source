import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { users, messages } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, assignMachine } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import type { Database } from "../db/index";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
async function fixture(db: Database, baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `external-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const server = await createServer("External replies", `external-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `lead-${suffix}`, { runtime: "claude", model: "sonnet" });
  const { machine } = await registerMachine(server.id, owner.id, "test-machine");
  await assignMachine(agent.id, machine.id);
  const channel = await createChannel(server.id, `topic-${suffix}`, undefined, "private");
  await addHuman(channel.id, owner.id); await addAgent(channel.id, agent.id);
  const original = await createMessage(channel.id, "user", owner.id, "calculate the price");
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "external-reply-test", createdByUserId: null });
  const call = (path: string, body?: unknown, token = apiKey) => fetch(baseUrl + "/internal/agent-api" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = (overrides: Record<string, unknown> = {}) => call("/send", { target: `#${channel.name}`, content: "40.13", idempotencyKey: randomUUID(), replyTo: original.id, ...overrides });
  return { owner, server, agent, channel, original, call, send };
}

test("native replies retain same-channel identity through history and keyed retries", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl), key = randomUUID();
  assert.equal((await (await h.call("/context")).json()).features.nativeReplies, true);
  const first = await h.send({ idempotencyKey: key, replyTo: h.original.id.slice(0, 8) });
  const body = await first.json(); assert.equal(first.status, 200, JSON.stringify(body));
  const [stored] = await db.select().from(messages).where(eq(messages.id, body.messageId));
  assert.equal(stored.channelId, h.channel.id); assert.equal(stored.threadId, null);
  assert.equal(stored.content, "40.13"); assert.deepEqual(stored.actionMetadata, { kind: "message", replyTo: h.original.id });
  const history = await h.call("/history?" + new URLSearchParams({ channel: `#${h.channel.name}`, consume: "false" }));
  assert.deepEqual((await history.json()).messages.find((m: { id: string }) => m.id === body.messageId).actionMetadata, stored.actionMetadata);
  const replay = await h.send({ idempotencyKey: key, replyTo: h.original.id });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).messageId, body.messageId);
  const other = await createMessage(h.channel.id, "user", h.owner.id, "new request");
  for (const replyTo of [other.id, undefined]) assert.equal((await h.send({ idempotencyKey: key, replyTo })).status, 409);
});

test("native replies reject invalid, hidden and cross-channel origins", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl);
  const other = await createChannel(h.server.id, `other-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(other.id, h.owner.id);
  const hiddenMessage = await createMessage(other.id, "user", h.owner.id, "private content");
  const hidden = await h.send({ replyTo: hiddenMessage.id }), missing = await h.send({ replyTo: randomUUID() });
  assert.equal(hidden.status, 404); assert.equal(missing.status, 404); assert.deepEqual(await hidden.json(), await missing.json());
  await addAgent(other.id, h.agent.id);
  assert.equal((await h.send({ replyTo: hiddenMessage.id })).status, 404);
  assert.equal((await h.send({ replyTo: "bad-id" })).status, 400);
  const { apiKey } = await mintAgentCredential({ agentId: h.agent.id, scopes: ["read"], name: "read-only", createdByUserId: null });
  assert.equal((await h.call("/send", { target: `#${h.channel.name}`, content: "denied", replyTo: h.original.id }, apiKey)).status, 403);
});

test("completion is independent of quoting, canonical and fenced by the send key", async ({ db, app }) => {
  const h = await fixture(db, app.baseUrl);
  const second = await createMessage(h.channel.id, "user", h.owner.id, "change the requirement");
  const ids = [h.original.id,second.id].sort(), key = randomUUID();
  const response = await h.send({ replyTo: undefined, completedInputMessageIds: [second.id.slice(0,8),h.original.id,h.original.id], idempotencyKey: key });
  const result = await response.json(); assert.equal(response.status,200,JSON.stringify(result));
  const [stored] = await db.select().from(messages).where(eq(messages.id,result.messageId));
  assert.deepEqual(stored.actionMetadata,{kind:"message",completedInputMessageIds:ids});
  const again = await h.send({replyTo:undefined,completedInputMessageIds:ids,idempotencyKey:key});
  assert.equal((await again.json()).messageId,result.messageId);
  for(const completedInputMessageIds of [[],[h.original.id],undefined])
    assert.equal((await h.send({replyTo:undefined,completedInputMessageIds,idempotencyKey:key})).status,409);
  const quoted=await h.send({replyTo:h.original.id,completedInputMessageIds:[second.id]});
  const quotedBody=await quoted.json();assert.equal(quoted.status,200,JSON.stringify(quotedBody));
  const [q]=await db.select().from(messages).where(eq(messages.id,quotedBody.messageId));
  assert.deepEqual(q.actionMetadata,{kind:"message",replyTo:h.original.id,completedInputMessageIds:[second.id]});
  assert.equal((await h.send({replyPhase:"final"})).status,400);
});

test("completion rejects hidden, cross-channel, nonhuman and another coordinator's inputs", async ({db,app})=>{
  const h=await fixture(db,app.baseUrl);
  const other=await createChannel(h.server.id,`other-${randomUUID().slice(0,8)}`,undefined,"private");
  await addHuman(other.id,h.owner.id);
  const hidden=await createMessage(other.id,"user",h.owner.id,"private");
  const worker=await createMessage(h.channel.id,"agent",h.agent.id,"internal");
  const assigned=await createMessage(h.channel.id,"user",h.owner.id,"another coordinator","chat",undefined,
    {actionMetadata:{kind:"external-topic",recipientAgentId:randomUUID()}});
  for(const id of [hidden.id,worker.id,assigned.id,randomUUID()])
    assert.equal((await h.send({replyTo:undefined,completedInputMessageIds:[id]})).status,404);
  await addAgent(other.id,h.agent.id);
  assert.equal((await h.send({completedInputMessageIds:[hidden.id]})).status,404);
  assert.equal((await h.send({completedInputMessageIds:["bad"]})).status,400);
});

test("data migration preserves old quotes and final completions exactly once", async ({db,app})=>{
  const h=await fixture(db,app.baseUrl);
  const progress=await createMessage(h.channel.id,"agent",h.agent.id,"progress","chat",undefined,
    {actionMetadata:{kind:"reply",messageId:h.original.id,phase:"progress"}});
  const final=await createMessage(h.channel.id,"agent",h.agent.id,"final","chat",undefined,
    {actionMetadata:{kind:"reply",messageId:h.original.id,phase:"final"}});
  const migration=readFileSync(new URL("../../drizzle/0375_message_relations.sql",import.meta.url),"utf8");
  for(let i=0;i<2;i++)await db.execute(sql.raw(migration));
  const [p]=await db.select().from(messages).where(eq(messages.id,progress.id));
  const [f]=await db.select().from(messages).where(eq(messages.id,final.id));
  assert.deepEqual(p.actionMetadata,{kind:"message",replyTo:h.original.id});
  assert.deepEqual(f.actionMetadata,{kind:"message",replyTo:h.original.id,completedInputMessageIds:[h.original.id]});
});
