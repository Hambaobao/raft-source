import type { Request, Response } from "express";
import { isDeepStrictEqual } from "node:util";
import { structuredRaftMentionStillAppears } from "@botiverse/raft-shared";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelAgents, messages, messageMentions, agentChannelReadCursors, agentMessageBodyReads } from "../db/schema";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { isChannelReadOnlyByQuota, isChannelReadOnlyByBillingFeature } from "../services/planService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { externalMessageAuthority, externalMessageInputSchema, externalMessageLookupSchema, externalReplyPresentation } from "./externalMessages";
import { sendJsonServerError } from "./errorResponse";

const conversationId = z.string().min(1).max(512);
const inputSchema = externalMessageInputSchema.extend({ externalConversationId: conversationId, mentionRecipient: z.boolean() });
const lookupSchema = externalMessageLookupSchema.extend({ externalConversationId: conversationId, anchorMessageId: z.string().uuid(),
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
    const content = input.mentionRecipient && !structuredRaftMentionStillAppears(input.content, agent.name)
      ? `<@${agent.name}>\n${input.content}` : input.content;
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
    const batch = await db.select({ id: messages.id, seq: messages.seq, channelId: messages.channelId,
      senderId: messages.senderId, senderType: messages.senderType, content: messages.content,
      messageType: messages.messageType, actionMetadata: messages.actionMetadata })
      .from(messages).where(and(eq(messages.channelId, channel.id), gt(messages.seq, after)))
      .orderBy(asc(messages.seq)).limit(100);
    const candidates = batch.filter(m => m.senderType === "agent" && m.senderId === agent.id && m.messageType === "chat");
    const mentions = candidates.length ? await db.select({ messageId: messageMentions.messageId }).from(messageMentions)
      .where(and(inArray(messageMentions.messageId, candidates.map(m => m.id)), eq(messageMentions.targetType, "user"),
        eq(messageMentions.targetId, user.id), eq(messageMentions.confidence, "exact"), eq(messageMentions.notifiableAtSend, true))) : [];
    const mentioned = new Set(mentions.map(m => m.messageId));
    const replyId = (m: typeof candidates[number]): string | null => {
      const metadata = m.actionMetadata as { kind?: string; messageId?: string } | null;
      return metadata?.kind === "reply" && z.string().uuid().safeParse(metadata.messageId).success ? metadata.messageId! : null;
    };
    const replyIds = [...new Set(candidates.map(replyId).filter((id): id is string => id !== null))];
    const originals = replyIds.length ? await db.select({ id: messages.id, actionMetadata: messages.actionMetadata }).from(messages).where(and(
      inArray(messages.id, replyIds), eq(messages.channelId, channel.id), eq(messages.senderType, "user"),
      eq(messages.senderId, user.id), eq(messages.messageType, "chat"))) : [];
    const humanReplies = new Map(originals.map(m => [m.id, m]));
    const addressed = candidates.flatMap(message => {
      const id = replyId(message);
      const recipientMentioned = mentioned.has(message.id);
      const recipientReplyTo = id && humanReplies.has(id) ? id : null;
      const source = recipientReplyTo ? humanReplies.get(recipientReplyTo)?.actionMetadata as Record<string, unknown> | null : null;
      const recipientExternalMessageId = source?.kind === "external-topic" && source.bindingId === binding.id
        && source.bridgeAgentId === binding.bridgeAgentId && source.recipientAgentId === agent.id
        && source.externalUserId === binding.externalUserId && source.externalConversationId === parsed.data.externalConversationId
        && typeof source.externalMessageId === "string" ? source.externalMessageId : null;
      return recipientMentioned || recipientReplyTo ? [{ ...message, recipientMentioned, recipientReplyTo, recipientExternalMessageId }] : [];
    });
    const [cursor] = await db.select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channel.id)));
    // Only return exact facts for requested inputs belonging to this binding,
    // human and conversation; never expose another channel's consumption.
    const requested = parsed.data.readMessageIds ?? [];
    const readInputs = requested.length ? await db.select({ id: messages.id, metadata: messages.actionMetadata })
      .from(messages).innerJoin(agentMessageBodyReads, eq(agentMessageBodyReads.messageId, messages.id))
      .where(and(eq(agentMessageBodyReads.agentId, agent.id), eq(messages.channelId, channel.id),
        eq(messages.senderType, "user"), eq(messages.senderId, user.id), inArray(messages.id, requested))) : [];
    const readMessageIds = readInputs.filter(input => {
      const source = input.metadata as Record<string, unknown> | null;
      return source?.kind === "external-topic" && source.bindingId === binding.id
        && source.bridgeAgentId === binding.bridgeAgentId && source.recipientAgentId === agent.id
        && source.externalUserId === binding.externalUserId && source.externalConversationId === parsed.data.externalConversationId;
    }).map(input => input.id);
    res.json({ anchorMessageId: origin.id, channelId: channel.id, recipientId: user.id, coordinatorId: agent.id,
      messages: await externalReplyPresentation(addressed, user.id), nextSeq: batch.at(-1)?.seq ?? after, hasMore: batch.length === 100,
      delivery: { targetHandle: agent.name, lastReadSeq: cursor?.seq ?? 0, readMessageIds, signal: "message_body_read_or_cursor" } });
  } catch (err) { sendJsonServerError(req, res, { error: "Failed to read topic messages", logPrefix: "external-topic.messages", err }); }
}
