import { messageRelations } from "../services/messageRelations";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, isNull, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, users, serverMembers, messages, agentChannelReadCursors, agentMessageBodyReads, messageMentions } from "../db/schema";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { isChannelReadOnlyByQuota, isChannelReadOnlyByBillingFeature } from "../services/planService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { sendJsonServerError } from "./errorResponse";

// Deployment-controlled delegation, never granted by an Agent's request body.
// Removing a binding revokes both ingestion and reply lookup on the next request.
const bindingSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  serverId: z.string().uuid(), bridgeAgentId: z.string().uuid(),
  userId: z.string().uuid(), agentId: z.string().uuid(),
  externalUserId: z.string().min(1).max(256),
  allowTopics: z.boolean(),
}).strict();
const bindingsSchema = z.array(bindingSchema).max(100).superRefine((rows, ctx) => {
  const ids = new Set<string>(), peers = new Set<string>();
  for (const row of rows) {
    const peer = JSON.stringify([row.serverId, row.bridgeAgentId, row.externalUserId]);
    if (ids.has(row.id) || peers.has(peer)) ctx.addIssue({ code: "custom", message: "Duplicate DM binding" });
    ids.add(row.id); peers.add(peer);
  }
});
export const externalMessageInputSchema = z.object({
  externalUserId: z.string().min(1).max(256),
  externalMessageId: z.string().min(1).max(256),
  content: z.string().min(1).max(32000).refine(value => value.trim().length > 0),
}).strict();
export const externalMessageLookupSchema = z.object({
  externalUserId: z.string().min(1).max(256),
  readMessageIds: z.string().max(3699).transform(value => value.split(",")).pipe(z.array(z.string().uuid()).max(100)).optional(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

function unavailable(res: Response) { res.status(404).json({ code: "external_dm_unavailable" }); }
export async function externalMessageAuthority(req: Request, res: Response, externalUserId: string) {
  let bindings: z.infer<typeof bindingsSchema>;
  try { bindings = bindingsSchema.parse(JSON.parse(process.env.RAFT_EXTERNAL_MESSAGE_BINDINGS || "[]")); }
  catch { res.status(503).json({ code: "external_dm_config_invalid" }); return null; }
  const binding = bindings.find(row => row.id === req.params.bindingId && row.serverId === req.serverId
    && row.bridgeAgentId === req.actingAgentId && row.externalUserId === externalUserId);
  if (!binding || !req.actingAgentIsExternal) { unavailable(res); return null; }
  const db = getDb();
  const [user] = await db.select({ id: users.id, name: users.name, displayName: users.displayName })
    .from(users).innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(users.id, binding.userId), eq(serverMembers.serverId, binding.serverId), isNull(users.retiredAt)));
  const [agent] = await db.select({ id: agents.id, name: agents.name, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents).where(and(eq(agents.id, binding.agentId), eq(agents.serverId, binding.serverId), isNull(agents.deletedAt)));
  if (!user || !agent || (agent.assistantOwnerUserId && agent.assistantOwnerUserId !== user.id)) {
    unavailable(res); return null;
  }
  return { binding, user, agent };
}

export async function externalDmBinding(req: Request, res: Response) {
  try {
    const parsed = externalMessageLookupSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ code: "external_dm_invalid_request" }); return; }
    const auth = await externalMessageAuthority(req, res, parsed.data.externalUserId);
    if (!auth) return;
    res.json({ bindingId: auth.binding.id, topicsEnabled: auth.binding.allowTopics === true, user: auth.user, agent: { id: auth.agent.id, name: auth.agent.name } });
  } catch (err) { sendJsonServerError(req, res, { error: "Failed to resolve DM binding", logPrefix: "external-dm.binding", err }); }
}

export async function externalDmSend(req: Request, res: Response) {
  try {
    const parsed = externalMessageInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "external_dm_invalid_request" }); return; }
    const input = parsed.data, auth = await externalMessageAuthority(req, res, input.externalUserId);
    if (!auth) return;
    const { binding, user, agent } = auth;
    // This is the same canonical human/Agent pair used by the Web DM UI.
    const dm = await channelService.findOrCreateDM(binding.serverId, user.id, agent.id);
    if (!dm || !await channelService.canUserPostToChannel(dm.id, user.id)
      || !await channelService.canAgentAccessChannel(dm.id, agent.id)) { unavailable(res); return; }
    if (await isChannelReadOnlyByQuota(dm.id, req.serverId!) || await isChannelReadOnlyByBillingFeature(dm.id, req.serverId!)) {
      res.status(403).json({ code: "external_dm_read_only" }); return;
    }
    const randomId = "external-message-" + createHash("sha256").update(JSON.stringify([
      binding.serverId, binding.bridgeAgentId, binding.id, input.externalMessageId,
    ])).digest("hex");
    const metadata = { kind: "external-dm", bindingId: binding.id, bridgeAgentId: binding.bridgeAgentId,
      recipientAgentId: agent.id, externalUserId: input.externalUserId, externalMessageId: input.externalMessageId };
    const message = await messageService.broadcastAndDeliver(req.app.get("io"), req.app.get("agentOrchestrator") as AgentOrchestrator, {
      channelId: dm.id, senderType: "user", senderId: user.id, senderName: user.displayName || user.name,
      content: input.content, randomId, actionMetadata: metadata,
      mentionContract: "v2",
    });
    res.json({ messageId: message.id, messageSeq: message.seq, channelId: dm.id,
      target: `dm:@${user.name}~human`, recipientId: agent.id, recipientHandle: agent.name });
  } catch (err) {
    if (err instanceof messageService.UserRandomIdConflictError) { res.status(409).json({ code: err.code }); return; }
    if (err instanceof channelService.ChannelArchivedError) { res.status(409).json({ code: "channel_archived" }); return; }
    sendJsonServerError(req, res, { error: "Failed to send external DM", logPrefix: "external-dm.send", err });
  }
}

export async function externalDmReplies(req: Request, res: Response) {
  try {
    const parsed = externalMessageLookupSchema.safeParse(req.query);
    const messageId = z.string().uuid().safeParse(req.params.messageId);
    if (!parsed.success || !messageId.success) {
      res.status(400).json({ code: "external_dm_invalid_request" }); return;
    }
    const auth = await externalMessageAuthority(req, res, parsed.data.externalUserId);
    if (!auth) return;
    const { binding, user, agent } = auth, db = getDb();
    const [origin] = await db.select().from(messages).where(eq(messages.id, messageId.data));
    const meta = origin?.actionMetadata as Record<string, unknown> | null;
    if (!origin || origin.senderType !== "user" || origin.senderId !== user.id || meta?.kind !== "external-dm"
      || meta.bindingId !== binding.id || meta.bridgeAgentId !== binding.bridgeAgentId
      || meta.recipientAgentId !== agent.id || meta.externalUserId !== binding.externalUserId
      || !await channelService.canUserAccessChannel(origin.channelId, user.id, req.serverId!)
      || !await channelService.canAgentAccessChannel(origin.channelId, agent.id)) { unavailable(res); return; }
    const channel = await channelService.getChannel(origin.channelId);
    if (channel?.type !== "dm" || channel.serverId !== req.serverId) { unavailable(res); return; }
    // An external input anchors a persistent, authorized DM stream. Later
    // human inputs never reassign old answers or close the conversation.
    const after = Math.max(origin.seq, parsed.data.after ?? 0);
    const batch = await db.select({ id: messages.id, seq: messages.seq, channelId: messages.channelId,
      senderId: messages.senderId, senderType: messages.senderType, content: messages.content,
      messageType: messages.messageType, actionMetadata: messages.actionMetadata })
      .from(messages).where(and(eq(messages.channelId, origin.channelId), gt(messages.seq, after)))
      .orderBy(asc(messages.seq)).limit(100);
    const replies = batch.filter(m => m.senderType === "agent" && m.senderId === agent.id && m.messageType === "chat");
    const delivery = await externalInputReads(auth, origin.channelId, parsed.data.readMessageIds ?? []);
    res.json({ messageId: origin.id, channelId: origin.channelId, recipientId: user.id, coordinatorId: agent.id,
      messages: await externalReplyPresentation(await externalReplyRelations(replies, auth, origin.channelId), user.id),
      nextSeq: batch.at(-1)?.seq ?? after, hasMore: batch.length === 100, delivery });

  } catch (err) { sendJsonServerError(req, res, { error: "Failed to read external DM replies", logPrefix: "external-dm.replies", err }); }
}

// Only strip a leading address confirmed by Raft's durable, exact mention fact.
// Handle-at-send-time keeps replies correct after the recipient renames their handle.
export async function externalReplyPresentation<T extends { id: string; content: string }>(replies: T[], userId: string) {
  const facts = replies.length ? await getDb().select({ messageId: messageMentions.messageId, handle: messageMentions.handleAtSendTime })
    .from(messageMentions).where(and(inArray(messageMentions.messageId, replies.map(m => m.id)),
      eq(messageMentions.targetType, "user"), eq(messageMentions.targetId, userId), eq(messageMentions.confidence, "exact"))) : [];
  return replies.map(message => {
    let recipientMentionPrefix: string | null = null;
    for (const fact of facts.filter(f => f.messageId === message.id)) {
      for (const token of [`<@${fact.handle}>`, `@${fact.handle}`]) {
        const leading = message.content.length - message.content.trimStart().length;
        const start = message.content.slice(leading);
        if (start.startsWith(token) && /^(?:\s|[,，:：]|$)/u.test(start.slice(token.length))) {
          const length = leading + token.length;
          recipientMentionPrefix = message.content.slice(0, length) + (message.content.slice(length).match(/^[\s,，:：]*/u)?.[0] ?? "");
        }
      }
    }
    return { ...message, recipientMentionPrefix };
  });
}


// Project only references visible in this conversation; completion does not
// address a recipient. Both DM and channel adapters share these relations.
export async function externalReplyRelations<T extends { actionMetadata: unknown }>(
  replies: T[], auth: NonNullable<Awaited<ReturnType<typeof externalMessageAuthority>>>,
  channelId: string, externalConversationId?: string,
) {
  const { binding, user, agent } = auth;
  const relations = replies.map(m => messageRelations(m.actionMetadata));
  const ids = [...new Set(relations.flatMap(m => [...(m.replyTo ? [m.replyTo] : []), ...(m.completedInputMessageIds ?? [])]))];
  const originals = ids.length ? await getDb().select({ id: messages.id, senderType: messages.senderType,
    senderId: messages.senderId, content: messages.content, metadata: messages.actionMetadata })
    .from(messages).where(and(inArray(messages.id, ids), eq(messages.channelId, channelId), eq(messages.messageType, "chat"))) : [];
  const byId = new Map(originals.map(m => [m.id, m]));
  const externalId = (source: unknown): string | null => {
    const meta = source as Record<string, unknown> | null;
    return meta?.kind === (externalConversationId === undefined ? "external-dm" : "external-topic")
      && meta.bindingId === binding.id && meta.bridgeAgentId === binding.bridgeAgentId
      && meta.recipientAgentId === agent.id && meta.externalUserId === binding.externalUserId
      && (externalConversationId === undefined || meta.externalConversationId === externalConversationId)
      && typeof meta.externalMessageId === "string" ? meta.externalMessageId : null;
  };
  return replies.map((message, i) => {
    const relation = relations[i]!;
    const quote = relation.replyTo ? byId.get(relation.replyTo) : undefined;
    const isRecipient = (m: typeof originals[number] | undefined) => m?.senderType === "user" && m.senderId === user.id;
    const completedInputs = (relation.completedInputMessageIds ?? []).flatMap(id => {
      const input = byId.get(id);
      return isRecipient(input) ? [{ messageId: id, externalMessageId: externalId(input!.metadata) }] : [];
    });
    return { ...message, recipientReplyTo: isRecipient(quote) ? quote!.id : null,
      quote: quote ? { messageId: quote.id, content: quote.content, externalMessageId: externalId(quote.metadata) } : null,
      completedInputs };
  });
}

export async function externalInputReads(
  auth: NonNullable<Awaited<ReturnType<typeof externalMessageAuthority>>>, channelId: string,
  requested: string[], externalConversationId?: string,
) {
  const { binding, user, agent } = auth, db = getDb();
  const [cursor] = await db.select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
    .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channelId)));
  const reads = requested.length ? await db.select({ id: messages.id, metadata: messages.actionMetadata })
    .from(messages).innerJoin(agentMessageBodyReads, eq(agentMessageBodyReads.messageId, messages.id))
    .where(and(eq(agentMessageBodyReads.agentId, agent.id), eq(messages.channelId, channelId),
      eq(messages.senderType, "user"), eq(messages.senderId, user.id), inArray(messages.id, requested))) : [];
  const readMessageIds = reads.filter(input => {
    const source = input.metadata as Record<string, unknown> | null;
    return source?.kind === (externalConversationId === undefined ? "external-dm" : "external-topic")
      && source.bindingId === binding.id && source.bridgeAgentId === binding.bridgeAgentId
      && source.recipientAgentId === agent.id && source.externalUserId === binding.externalUserId
      && (externalConversationId === undefined || source.externalConversationId === externalConversationId);
  }).map(input => input.id);
  return { targetHandle: agent.name, lastReadSeq: cursor?.seq ?? 0, readMessageIds, signal: "message_body_read_or_cursor" };
}
