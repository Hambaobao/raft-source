import type { Request, Response } from "express";
import { isDeepStrictEqual } from "node:util";
import { structuredRaftMentionStillAppears } from "@botiverse/raft-shared";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db/index";
import { channels, channelAgents, messages, messageMentions } from "../db/schema";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { isChannelReadOnlyByQuota, isChannelReadOnlyByBillingFeature } from "../services/planService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { externalNativeUserMessages, externalMessageAuthority, externalMessageInputSchema, externalMessageLookupSchema, externalReplyContent, externalReplyPresentation, externalReplyRelations, externalInputReads } from "./externalMessages";
import { sendJsonServerError } from "./errorResponse";

const conversationId = z.string().min(1).max(512);
const inputSchema = externalMessageInputSchema.extend({ externalConversationId: conversationId, mentionRecipient: z.boolean() });
const lookupSchema = externalMessageLookupSchema.extend({ externalConversationId: conversationId, anchorMessageId: z.string().uuid(),
  includeThreadMessages: z.enum(["true", "false"]).optional(),
  readMessageIds: z.string().max(3699).transform(value => value.split(",")).pipe(z.array(z.string().uuid()).max(100)).optional(),
});
function unavailable(res: Response) { res.status(404).json({ code: "external_topic_unavailable" }); }

// Explicit deployment opt-in delegates writing as one bound user only in private
// channels administered by this Bridge, with both user and recipient still present.
// A normal channel membership, a DM, or an arbitrary request userId grants nothing.
async function authority(req: Request, res: Response, externalUserId: string) {
  const auth = await externalMessageAuthority(req, res, externalUserId);
  if (!auth) return null;
  const id = z.string().uuid().safeParse(req.params.channelId);
  if (!auth.binding.allowTopics || !id.success) { unavailable(res); return null; }
  const channel = await channelService.getChannel(id.data);
  const [membership] = await getDb().select({ role: channelAgents.role }).from(channelAgents)
    .where(and(eq(channelAgents.channelId, id.data), eq(channelAgents.agentId, auth.binding.bridgeAgentId)));
  if (!channel || channel.type !== "private" || channel.serverId !== req.serverId || channel.deletedAt
    || membership?.role !== "admin"
    || !await channelService.canUserPostToChannel(channel.id, auth.user.id)
    || !await channelService.canAgentAccessChannel(channel.id, auth.agent.id)) { unavailable(res); return null; }
  return { ...auth, channel };
}

export async function externalTopicSend(req: Request, res: Response) {
  try {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "external_topic_invalid_request" }); return; }
    const input = parsed.data, auth = await authority(req, res, input.externalUserId);
    if (!auth) return;
    const { binding, user, agent, channel } = auth;
    if (await isChannelReadOnlyByQuota(channel.id, req.serverId!) || await isChannelReadOnlyByBillingFeature(channel.id, req.serverId!)) {
      res.status(403).json({ code: "external_topic_read_only" }); return;
    }
    const randomId = "external-message-" + createHash("sha256").update(JSON.stringify([
      binding.serverId, binding.bridgeAgentId, binding.id, input.externalMessageId,
    ])).digest("hex");
    const metadata = { kind: "external-topic", bindingId: binding.id, bridgeAgentId: binding.bridgeAgentId,
      recipientAgentId: agent.id, externalUserId: input.externalUserId, externalMessageId: input.externalMessageId,
      externalConversationId: input.externalConversationId, mentionRecipient: input.mentionRecipient,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      requestDigest: createHash("sha256").update(input.content).digest("hex") };
    // Recover the original rendered mention after a handle rename or lost receipt.
    const [prior] = await getDb().select().from(messages).where(and(eq(messages.randomId, randomId),
      eq(messages.senderType, "user"), eq(messages.senderId, user.id), eq(messages.serverId, binding.serverId)));
    if (prior) {
      if (prior.channelId !== channel.id || !isDeepStrictEqual(prior.actionMetadata, metadata)) throw new messageService.UserRandomIdConflictError();
      res.json({ messageId: prior.id, messageSeq: prior.seq, channelId: channel.id,
        target: `#${channel.name}`, recipientId: agent.id, recipientHandle: agent.name });
      return;
    }
    const mentionedContent = input.mentionRecipient && !structuredRaftMentionStillAppears(input.content, agent.name)
      ? `<@${agent.name}>\n${input.content}` : input.content;
    const content = await externalReplyContent({ ...input, content: mentionedContent }, binding.serverId, channel.id, "channel", res);
    if (content === null) return;
    const message = await messageService.broadcastAndDeliver(req.app.get("io"), req.app.get("agentOrchestrator") as AgentOrchestrator, {
      channelId: channel.id, senderType: "user", senderId: user.id, senderName: user.displayName || user.name,
      content, randomId, actionMetadata: metadata, mentionContract: "v2",
      ...(input.mentionRecipient ? { mentions: [{ type: "agent", id: agent.id, name: agent.name }] } : {}),
    });
    res.json({ messageId: message.id, messageSeq: message.seq, channelId: channel.id,
      target: `#${channel.name}`, recipientId: agent.id, recipientHandle: agent.name });
  } catch (err) {
    if (err instanceof messageService.UserRandomIdConflictError) { res.status(409).json({ code: err.code }); return; }
    if (err instanceof channelService.ChannelArchivedError) { res.status(409).json({ code: "channel_archived" }); return; }
    sendJsonServerError(req, res, { error: "Failed to send external topic message", logPrefix: "external-topic.send", err });
  }
}

export async function externalTopicMessages(req: Request, res: Response) {
  try {
    const parsed = lookupSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ code: "external_topic_invalid_request" }); return; }
    const auth = await authority(req, res, parsed.data.externalUserId);
    if (!auth) return;
    const { binding, user, agent, channel } = auth, db = getDb();
    const [origin] = await db.select().from(messages).where(eq(messages.id, parsed.data.anchorMessageId));
    const meta = origin?.actionMetadata as Record<string, unknown> | null;
    if (!origin || origin.channelId !== channel.id || origin.senderType !== "user" || origin.senderId !== user.id
      || origin.messageType !== "chat" || meta?.kind !== "external-topic" || meta.bindingId !== binding.id
      || meta.bridgeAgentId !== binding.bridgeAgentId || meta.recipientAgentId !== agent.id
      || meta.externalUserId !== binding.externalUserId || meta.externalConversationId !== parsed.data.externalConversationId) {
      unavailable(res); return;
    }
    // This anchor proves the external conversation binding; it is not the question
    // being answered. Scan every channel message so internal-only pages advance too.
    const after = Math.max(origin.seq, parsed.data.after ?? 0);
    // Direct threads inherit this private channel's read authority. Verify both
    // the stored parent channel and the root message, never an arbitrary ID
    // supplied by the Bridge. Keep one global-seq cursor across the whole stream.
    const parent = alias(messages, "external_thread_parent");
    const rows = await db.select({ id: messages.id, seq: messages.seq, channelId: messages.channelId,
      senderId: messages.senderId, senderType: messages.senderType, content: messages.content,
      messageType: messages.messageType, actionMetadata: messages.actionMetadata, parentMessageId: parent.id })
      .from(messages).innerJoin(channels, eq(channels.id, messages.channelId))
      .leftJoin(parent, eq(parent.id, channels.parentMessageId))
      .where(and(gt(messages.seq, after), or(eq(messages.channelId, channel.id),
        parsed.data.includeThreadMessages === "true" ? and(eq(channels.type, "thread"),
          eq(channels.serverId, binding.serverId), isNull(channels.deletedAt),
          eq(channels.parentChannelId, channel.id), eq(parent.channelId, channel.id)) : undefined)))
      .orderBy(asc(messages.seq)).limit(100);
    const batch = rows.map(({ parentMessageId, ...message }) => ({ ...message,
      ...(message.channelId !== channel.id ? { thread: { parentChannelId: channel.id, parentMessageId: parentMessageId! } } : {}) }));
    const candidates = batch.filter(m => m.senderType === "agent" && m.senderId === agent.id && m.messageType === "chat");
    const mentions = candidates.length ? await db.select({ messageId: messageMentions.messageId }).from(messageMentions)
      .where(and(inArray(messageMentions.messageId, candidates.map(m => m.id)), eq(messageMentions.targetType, "user"),
        eq(messageMentions.targetId, user.id), eq(messageMentions.confidence, "exact"), eq(messageMentions.notifiableAtSend, true))) : [];
    const mentioned = new Set(mentions.map(m => m.messageId));
    const related = (await Promise.all([...new Set(candidates.map(m => m.channelId))].map(id => {
      const source = candidates.filter(m => m.channelId === id);
      return externalReplyRelations(source, auth, id, parsed.data.externalConversationId, source[0]?.thread?.parentMessageId);
    }))).flat().sort((a, b) => a.seq - b.seq);
    const addressed = related.filter(m => mentioned.has(m.id) || m.recipientReplyTo)
      .map(m => ({ ...m, recipientMentioned: mentioned.has(m.id) }));
    const delivery = await externalInputReads(auth, channel.id, parsed.data.readMessageIds ?? [], parsed.data.externalConversationId);
    res.json({ anchorMessageId: origin.id, channelId: channel.id, recipientId: user.id, coordinatorId: agent.id,
      ...(parsed.data.includeUserMessages === "true" ? { userMessages: externalNativeUserMessages(batch, user.id, user.displayName || user.name) } : {}),
      messages: await externalReplyPresentation(addressed, user.id), nextSeq: batch.at(-1)?.seq ?? after, hasMore: batch.length === 100, delivery });

  } catch (err) { sendJsonServerError(req, res, { error: "Failed to read topic messages", logPrefix: "external-topic.messages", err }); }
}
