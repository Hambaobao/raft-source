import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelAgents, messages, agentChannelReadCursors } from "../db/schema";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { isChannelReadOnlyByQuota, isChannelReadOnlyByBillingFeature } from "../services/planService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { externalMessageAuthority, externalMessageInputSchema, externalMessageLookupSchema } from "./externalMessages";
import { sendJsonServerError } from "./errorResponse";

const conversationId = z.string().min(1).max(512);
const inputSchema = externalMessageInputSchema.extend({ externalConversationId: conversationId });
const lookupSchema = externalMessageLookupSchema.extend({ externalConversationId: conversationId });
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
      externalConversationId: input.externalConversationId };
    const message = await messageService.broadcastAndDeliver(req.app.get("io"), req.app.get("agentOrchestrator") as AgentOrchestrator, {
      channelId: channel.id, senderType: "user", senderId: user.id, senderName: user.displayName || user.name,
      content: input.content, randomId, actionMetadata: metadata, mentionContract: "v2",
    });
    res.json({ messageId: message.id, messageSeq: message.seq, channelId: channel.id,
      target: `#${channel.name}`, recipientId: agent.id, recipientHandle: agent.name });
  } catch (err) {
    if (err instanceof messageService.UserRandomIdConflictError) { res.status(409).json({ code: err.code }); return; }
    if (err instanceof channelService.ChannelArchivedError) { res.status(409).json({ code: "channel_archived" }); return; }
    sendJsonServerError(req, res, { error: "Failed to send external topic message", logPrefix: "external-topic.send", err });
  }
}

export async function externalTopicReplies(req: Request, res: Response) {
  try {
    const parsed = lookupSchema.safeParse(req.query), id = z.string().uuid().safeParse(req.params.messageId);
    if (!parsed.success || !id.success) { res.status(400).json({ code: "external_topic_invalid_request" }); return; }
    const auth = await authority(req, res, parsed.data.externalUserId);
    if (!auth) return;
    const { binding, user, agent, channel } = auth, db = getDb();
    const [origin] = await db.select().from(messages).where(eq(messages.id, id.data));
    const meta = origin?.actionMetadata as Record<string, unknown> | null;
    if (!origin || origin.channelId !== channel.id || origin.senderType !== "user" || origin.senderId !== user.id
      || meta?.kind !== "external-topic" || meta.bindingId !== binding.id || meta.bridgeAgentId !== binding.bridgeAgentId
      || meta.recipientAgentId !== agent.id || meta.externalUserId !== binding.externalUserId
      || meta.externalConversationId !== parsed.data.externalConversationId) { unavailable(res); return; }
    // A shared channel contains coordination as well as user-facing answers.
    // Only the bound leader's native, exact replies to this human input qualify.
    // Read the next-human boundary in the same query: a stale answer must not be
    // reattached to a correction or a Web-only question arriving concurrently.
    const replies = await db.select({ id: messages.id, seq: messages.seq, channelId: messages.channelId,
      senderId: messages.senderId, senderType: messages.senderType, content: messages.content, actionMetadata: messages.actionMetadata })
      .from(messages).where(and(eq(messages.channelId, channel.id), eq(messages.senderType, "agent"),
        eq(messages.senderId, agent.id), eq(messages.messageType, "chat"), gt(messages.seq, Math.max(origin.seq, parsed.data.after ?? 0)),
        sql`${messages.actionMetadata}->>'kind' = 'reply'`, sql`${messages.actionMetadata}->>'messageId' = ${origin.id}`,
        sql`NOT EXISTS (SELECT 1 FROM messages later_input WHERE later_input.channel_id = ${channel.id}
          AND later_input.sender_type = 'user' AND later_input.message_type = 'chat' AND later_input.seq > ${origin.seq} AND later_input.seq < ${messages.seq})`,
      )).orderBy(asc(messages.seq)).limit(100);
    // Membership/system notices also use senderType=user; only chat inputs supersede.
    const [nextInput] = await db.select({ seq: messages.seq }).from(messages).where(and(
      eq(messages.channelId, channel.id), eq(messages.senderType, "user"), eq(messages.messageType, "chat"), gt(messages.seq, origin.seq),
    )).orderBy(asc(messages.seq)).limit(1);
    const [cursor] = await db.select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channel.id)));
    res.json({ messageId: origin.id, channelId: channel.id, messages: replies, superseded: Boolean(nextInput),
      delivery: { targetHandle: agent.name, outcome: cursor && cursor.seq >= origin.seq ? "read" : "pending", signal: "read_cursor" } });
  } catch (err) { sendJsonServerError(req, res, { error: "Failed to read topic replies", logPrefix: "external-topic.replies", err }); }
}
