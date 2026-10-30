import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, isNull, or, sql, inArray } from "drizzle-orm";
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
    // A DM is already a user-facing conversation. Normal Agent messages need
    // no external reply command. Stop at the next human input so a Web-only
    // question does not silently become an external conversation. Explicit
    // source associations distinguish replies to earlier inputs.
    // Membership/system notices also use senderType=user; only chat inputs supersede.
    const [nextInput] = await db.select({ seq: messages.seq }).from(messages).where(and(
      eq(messages.channelId, origin.channelId), eq(messages.senderType, "user"), eq(messages.messageType, "chat"), gt(messages.seq, origin.seq),
    )).orderBy(asc(messages.seq)).limit(1);
    const replies = await db.select({ id: messages.id, seq: messages.seq, channelId: messages.channelId,
      senderId: messages.senderId, senderType: messages.senderType, content: messages.content, actionMetadata: messages.actionMetadata })
      .from(messages).where(and(eq(messages.channelId, origin.channelId), eq(messages.senderType, "agent"),
        eq(messages.senderId, agent.id), eq(messages.messageType, "chat"), gt(messages.seq, Math.max(origin.seq, parsed.data.after ?? 0)),
        or(and(sql`${messages.actionMetadata}->>'kind' = 'reply'`, sql`${messages.actionMetadata}->>'messageId' = ${origin.id}`),
          and(sql`COALESCE(${messages.actionMetadata}->>'kind', '') <> 'reply'`,
            sql`NOT EXISTS (SELECT 1 FROM messages later_input
              WHERE later_input.channel_id = ${origin.channelId} AND later_input.sender_type = 'user' AND later_input.message_type = 'chat'
              AND later_input.seq > ${origin.seq} AND later_input.seq < ${messages.seq})`)),
      )).orderBy(asc(messages.seq)).limit(100);
    const [cursor] = await db.select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, origin.channelId)));
    const [bodyRead] = await db.select({ messageId: agentMessageBodyReads.messageId }).from(agentMessageBodyReads)
      .where(and(eq(agentMessageBodyReads.agentId, agent.id), eq(agentMessageBodyReads.messageId, origin.id)));
    // Native unmentioned DMs have no mention ACK. Name the actual signal;
    // never present persistence or online/idle status as a runtime receipt.
    res.json({ messageId: origin.id, channelId: origin.channelId, recipientId: user.id, messages: await externalReplyPresentation(replies, user.id), superseded: Boolean(nextInput),
      delivery: { targetHandle: agent.name, outcome: bodyRead || (cursor && cursor.seq >= origin.seq) ? "read" : "pending", signal: bodyRead ? "message_body_read" : "read_cursor" } });
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
