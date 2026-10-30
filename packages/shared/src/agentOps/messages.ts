// Message operations: read a conversation, send, reply.
//
// `readHistory` reads a target the way `raft message read` does and advances
// the seen frontier by the same rules (the Server's `model_seen_up_to_seq`
// for a contiguous window; exact seqs for an anchored `around` lookup).
// `sendMessage` attests that frontier so a reply into a conversation the agent
// has read is not held, and turns the Server's freshness hold into an
// `interrupted` outcome (interrupt.ts) the caller can act on, never an
// exception. `replyTo` sends to the target a received message came from.

import { agentApiReplyToSchema } from "../agentApiMessageContract";
import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiHistoryResponse } from "../agentApiContract";
import {
  agentApiStructuredMentionSchema,
  type AgentApiHeldFreshnessResponse,
  type AgentApiSendResponse,
  type AgentApiSendV2Body,
  type AgentApiStructuredMention,
} from "../agentApiMessageContract";
import { formatAgentMessages } from "../agentMessageText";
import type { SeenFrontier } from "./frontier";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import {
  inProcessSendResume,
  unreadMessagesInterrupt,
  type RaftInterrupt,
  type RaftInterruptCancel,
  type RaftInterrupted,
  type RaftInterruptResume,
} from "./interrupt";
import { formatAgentHold } from "../agentText/hold";
import { formatAgentThreadTargetCheck } from "../agentText/threadTarget";
import { detectThreadTargetMismatch, type ThreadTargetMismatch } from "./seenPolicy/threadTarget";
import { agentChannelRef } from "../agentText/server";
import { parseDmPeerRef } from "../dmPeerRef";
import { parseRaftRefTarget } from "../raftRefs";
import {
  channelCardRev,
  elideSeenSenderDescriptions,
  renderSendAttachment,
  senderObservationId,
  peerCardHasContent,
  peerCardId,
  peerCardRev,
  renderChannelCard,
  renderPeerCard,
  type ChannelCard,
  type PeerCard,
} from "./passiveResources";
import { projectRaftMessages, projectRaftMessagesInTarget, sortBySeq, toAgentMessageLike, type RaftMessage } from "./message";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

/** A conversation target as agents spell it. */
export const raftTargetSchema = lazySchema("raftTargetSchema", () => z.string().describe("Conversation: `#channel`, `dm:@peer`, or a thread `#channel:shortid` / `dm:@peer:shortid`."));

// ── read ──────────────────────────────────────────────────────────────────

export interface ReadHistoryRequest {
  target: string;
  /** Messages after this seq (exclusive); the `--after` the inbox listing prints. */
  after?: number;
  /** Messages before this seq (exclusive): browse older. */
  before?: number;
  /** Anchor a window around a seq or message id; records exact seqs only. */
  around?: number | string;
  limit?: number;
  /**
   * Read this target's unread: start right after the agent's read position
   * (where `inbox.list` counts unread from) and move it forward. The agent's
   * own messages are never unread: they are left out, and the read position
   * still moves past them. Cannot be combined with after/before/around.
   */
  unread?: boolean;
  /**
   * `false` reads without consuming: the Server does not mark the page read,
   * and nothing is recorded in the seen frontier. Use it when the result may
   * not reach the model (for example, code the agent wrote).
   */
  consume?: boolean;
}

export const readHistoryRequestSchema = lazySchema("readHistoryRequestSchema", () => requestSchema<ReadHistoryRequest>()(z.object({
  target: raftTargetSchema,
  after: z.number().int().nonnegative().optional().describe("Only messages after this seq (exclusive): read what is new since a position, for example the `--after` an inbox listing prints."),
  before: z.number().int().nonnegative().optional().describe("Only messages before this seq (exclusive): browse older history."),
  // A seq is sent to the Server as its string form either way, so "12345" and 12345 read the same window.
  around: z.union([z.number().int(), z.string()]).optional().describe("Anchor a window around a message: its seq number (for example \"12345\") or its message id."),
  limit: z.number().int().positive().optional().describe("Maximum messages in the window."),
  unread: z.boolean().optional().describe("true reads this conversation's unread messages: starts right after your read position and moves it forward. Cannot be combined with after, before, or around."),
  consume: z.boolean().optional().describe("false reads without consuming: the conversation is not marked read and nothing counts as seen."),
})));

export interface RaftHistoryPage {
  /** Canonical target the Server resolved (falls back to the requested spelling on older Servers). */
  target: string;
  messages: RaftMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  lastReadSeq: number | null;
  /** The contiguous boundary the Server considers model-seen after this read, when it computed one. */
  modelSeenUpToSeq: number | null;
  /** For an `unread` read: the read position the page started after. */
  unreadAfterSeq?: number;
  /**
   * For an `unread` read: the read position after it. Below the newest seq
   * when the newest messages are too recent to mark read (seq order is not
   * commit order); those come again on the next unread read.
   */
  readThroughSeq?: number;
  /**
   * For an `unread` read: seqs on this page the agent was already shown (per
   * the seen frontier, in the current context). They are still in `messages`;
   * `text` folds them into one line so a repeat is not read as new.
   */
  alreadyShownSeqs?: number[];
}

function historyNext(page: RaftHistoryPage, style: RaftHintStyle): RaftNextStep | null {
  const seqs = page.messages.map((m) => m.seq).filter((s): s is number => s !== null);
  // An unread read moved the read position, so the same call continues it.
  if (page.unreadAfterSeq !== undefined) {
    return page.hasNewer && seqs.length > 0
      ? hintStep(
        "read_newer",
        RAFT_HINTS.messageRead({ target: page.target, unread: true }),
        "More unread messages remain in this conversation.",
        style,
        { target: page.target, unread: true },
      )
      : null;
  }
  if (page.hasNewer && seqs.length > 0) {
    const max = Math.max(...seqs);
    return hintStep(
      "read_newer",
      RAFT_HINTS.messageRead({ target: page.target, after: max }),
      "Newer messages exist beyond this window.",
      style,
      { target: page.target, after: max },
    );
  }
  if (page.hasOlder && seqs.length > 0) {
    const min = Math.min(...seqs);
    return hintStep(
      "read_older",
      RAFT_HINTS.messageRead({ target: page.target, before: min }),
      "Older messages exist before this window; read them only if the task needs them.",
      style,
      { target: page.target, before: min },
    );
  }
  return null;
}

function historyText(page: RaftHistoryPage, style: RaftHintStyle): string {
  if (page.messages.length === 0) {
    return page.unreadAfterSeq !== undefined
      ? `No unread messages in ${page.target}. You have read through seq ${page.unreadAfterSeq}.`
      : `No messages in ${page.target}.`;
  }
  const folded = new Set(page.alreadyShownSeqs ?? []);
  const shown = page.messages.filter((m) => m.seq === null || !folded.has(m.seq));
  const lines: string[] = [];
  if (folded.size > 0 && page.unreadAfterSeq !== undefined) {
    const seqs = [...folded].sort((a, b) => a - b);
    const range = seqs.length === 1 ? `${seqs[0]}` : `${seqs[0]}-${seqs[seqs.length - 1]}`;
    const again = formatHint(RAFT_HINTS.messageRead({ target: page.target, after: page.unreadAfterSeq }), style);
    lines.push(`${shown.length === 0 ? `No new unread messages in ${page.target}. ` : ""}${seqs.length} message${seqs.length === 1 ? "" : "s"} you were already shown (seq ${range}) ${seqs.length === 1 ? "is" : "are"} not repeated. To see ${seqs.length === 1 ? "it" : "them"} again: ${again}`);
  }
  if (shown.length > 0) lines.push(formatAgentMessages(shown.map((m) => toAgentMessageLike(m.raw)), style));
  const next = historyNext(page, style);
  if (next?.command) lines.push(`${next.kind === "read_newer" ? "Newer" : "Older"} exist: ${next.command}`);
  return lines.join("\n");
}

/**
 * Frontier rules (FH-EXT-001, mirrored from the CLI): a contiguous window may
 * advance the high-water mark to the Server's `model_seen_up_to_seq`; an
 * `around` lookup and a legacy Server without that field record exact seqs.
 */
function recordHistorySeen(frontier: SeenFrontier | undefined, requested: string, page: RaftHistoryPage, around: boolean): void {
  if (!frontier) return;
  frontier.recordAlias(requested, page.target);
  const seqs = page.messages.map((m) => m.seq).filter((s): s is number => s !== null);
  // An explicit read of the conversation, in local read order (the thread-target check); not an `around` lookup.
  if (!around) frontier.recordRead(page.target, seqs.length > 0 ? Math.max(...seqs) : undefined);
  if (seqs.length === 0) return;
  if (!around && page.modelSeenUpToSeq !== null && page.modelSeenUpToSeq > 0) {
    frontier.recordUpTo(page.target, page.modelSeenUpToSeq);
    return;
  }
  frontier.recordExact(page.target, seqs);
}

/** Seqs in `messages` this frontier's context was already shown for `target` (the unread fold). */
function alreadyShownIn(frontier: SeenFrontier, target: string, messages: ReadonlyArray<{ seq?: unknown }>): Set<number> {
  const seen = frontier.attestation(target);
  const exact = new Set(seen.seenExactSeqs);
  const shown = new Set<number>();
  for (const m of messages) {
    if (typeof m.seq === "number" && ((seen.seenUpToSeq !== undefined && m.seq <= seen.seenUpToSeq) || exact.has(m.seq))) shown.add(m.seq);
  }
  return shown;
}

export async function readHistory(
  client: Pick<AgentApiClient, "history">,
  request: ReadHistoryRequest,
  frontier?: SeenFrontier,
  options: RaftCardOptions = {},
): Promise<RaftOutcome<RaftHistoryPage, "page" | "empty">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(readHistoryRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A target is required to read history." }));
  if (request.unread && (request.after !== undefined || request.before !== undefined || request.around !== undefined)) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "unread cannot be combined with after, before, or around: it always starts right after your read position." }));
  }
  const result = await client.history.read({
    channel: request.target,
    ...(request.after === undefined ? {} : { after: String(request.after) }),
    ...(request.before === undefined ? {} : { before: String(request.before) }),
    ...(request.around === undefined ? {} : { around: String(request.around) }),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ...(request.consume === false ? { consume: "false" as const } : {}),
    ...(request.unread ? { unread: "true" as const } : {}),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data as AgentApiHistoryResponse & { target?: string };
  // A Server that does not know `unread` ignores it and returns the latest page.
  if (request.unread && typeof data.unread_after_seq !== "number") {
    return failureOutcome(opError("INVALID_RESPONSE", {
      message: "This Server does not support unread reads yet; the page it returned was discarded instead of being shown as unread.",
      nextAction: "List unread conversations with inbox.list, then read one with messages.read and its after seq.",
    }));
  }
  // History already identifies its conversation; bare row envelopes inherit that target.
  const target = typeof data.target === "string" && data.target ? data.target : request.target;
  // Cards (conversationCards): sender descriptions once per context (with a
  // context; without one every description shows, as in the CLI), then the
  // conversation's cards. Only messages this read prints count: an unread read
  // folds the ones this context was already shown, and those claim nothing.
  const cards = options.conversationCards === true && frontier !== undefined;
  let envelopes = data.messages;
  let cardLines: string[] = [];
  if (cards) {
    const folded = request.unread ? alreadyShownIn(frontier, target, data.messages) : new Set<number>();
    const printed = data.messages.filter((m) => !(typeof m.seq === "number" && folded.has(m.seq)));
    if (frontier.contextId !== null) {
      const elided = elideSeenSenderDescriptions(printed, {
        get: (m) => ({
          type: m.sender_type ?? null,
          name: m.sender_name ?? null,
          description: m.sender_description ?? null,
          timezone: m.sender_timezone ?? null,
        }),
        withoutDescription: (m) => ({ ...m, sender_description: null, sender_timezone: null, senderDescription: null, senderTimezone: null }),
      }, (id, rev) => frontier.claimCard("sender", id, rev)).messages;
      const byOriginal = new Map(printed.map((m, i) => [m, elided[i]!]));
      envelopes = data.messages.map((m) => byOriginal.get(m) ?? m);
    }
    cardLines = cardLinesForRead(data, printed, frontier, style);
  }
  const page: RaftHistoryPage = {
    target,
    messages: sortBySeq(projectRaftMessagesInTarget(envelopes, target, style)),
    hasOlder: data.has_older === true,
    hasNewer: data.has_newer === true,
    lastReadSeq: typeof data.last_read_seq === "number" ? data.last_read_seq : null,
    modelSeenUpToSeq: typeof data.model_seen_up_to_seq === "number" ? data.model_seen_up_to_seq : null,
    ...(typeof data.unread_after_seq === "number" ? { unreadAfterSeq: data.unread_after_seq } : {}),
    ...(typeof data.read_through_seq === "number" ? { readThroughSeq: data.read_through_seq } : {}),
  };
  if (request.unread && frontier) {
    const alreadyShown = [...alreadyShownIn(frontier, page.target, page.messages)];
    if (alreadyShown.length > 0) page.alreadyShownSeqs = alreadyShown;
  }
  if (request.consume !== false) recordHistorySeen(frontier, request.target, page, request.around !== undefined);
  const text = historyText(page, style);
  return {
    ok: true,
    state: page.messages.length > 0 ? "page" : "empty",
    data: page,
    next: historyNext(page, style),
    text: cardLines.length > 0 ? `${cardLines.join("\n")}\n\n${text}` : text,
  };
}

/**
 * Options for the operations that show conversation cards. `conversationCards`
 * (createRaft's switch, default off): a read shows the channel's card the
 * first time in the frontier's context (and after it changed) and a DM peer's
 * card when the context has seen nothing of them; sender descriptions show
 * once per context; a send names the card versions its context has.
 */
export interface RaftCardOptions extends RaftHintOptions {
  conversationCards?: boolean;
  /**
   * Run the thread-target check on this send (glimpse G2-5): only for sends
   * the model makes. A program choosing a top-level target means it.
   */
  threadTargetCheck?: boolean;
}

/** The cards a read prints first, booked on the frontier (glimpse G1, as the CLI does). */
function cardLinesForRead(
  data: AgentApiHistoryResponse,
  printed: ReadonlyArray<{ sender_type?: unknown; sender_name?: unknown; senderType?: unknown; senderName?: unknown }>,
  frontier: SeenFrontier,
  style: RaftHintStyle,
): string[] {
  const lines: string[] = [];
  const card: ChannelCard | undefined = data.channel_card;
  if (card?.name) {
    const ref = agentChannelRef(card.name, card.type);
    const rev = channelCardRev(card);
    const before = frontier.seenCard("channel", ref);
    if (frontier.claimCard("channel", ref, rev)) {
      lines.push(...renderChannelCard(card, { changed: before !== undefined && before !== rev, style }));
    }
  }
  const peer: PeerCard | undefined = data.peer_card;
  if (peer?.name && peerCardHasContent(peer)) {
    const id = peerCardId(peer);
    const fromPeer = printed.some((m) => (m.sender_type ?? m.senderType) === peer.kind && (m.sender_name ?? m.senderName) === peer.name);
    const show = frontier.contextId === null
      ? !fromPeer
      : frontier.seenCard("sender", id) === undefined && frontier.claimCard("sender", id, peerCardRev(peer));
    if (show) lines.push(...renderPeerCard(peer, { style }));
  }
  return lines;
}

// ── send ──────────────────────────────────────────────────────────────────

/** Attempts for a keyed send whose request never reached the Server (transport failure only). */
const SEND_TRANSPORT_ATTEMPTS = 3;

export interface SendMessageRequest {
  replyTo?: string;
  target: string;
  content: string;
  attachmentIds?: string[];
  /**
   * One key per logical message. Generated with `crypto.randomUUID()` when
   * omitted, so a response lost after the Server committed can be retried
   * without posting twice; sending again after an interrupt reuses the same
   * key (`interrupt.resume.idempotencyKey`).
   */
  idempotencyKey?: string;
  mentions?: AgentApiStructuredMention[];
  /**
   * Override the frontier attestation for this send. Use when the runtime
   * tracks what its model saw itself (for example a stateless worker that
   * persisted the seq it last showed the model).
   */
  seen?: { upToSeq?: number; exactSeqs?: number[] };
  /**
   * The top-level target is intentional even though this context last read
   * one of its threads (resuming a `thread_target` interrupt).
   */
  targetConfirmed?: boolean;
}

const sendMessageFields = {
  content: z.string().describe("Message text (Markdown). May be empty only when attachmentIds are given."),
  attachmentIds: z.array(z.string()).optional().describe("Attachment ids from an upload, posted with this message."),
  idempotencyKey: z.string().optional().describe("One key per logical message; generated when omitted. Reuse it to retry, and to resume an interrupted send (interrupt.resume.idempotencyKey)."),
  mentions: z.array(agentApiStructuredMentionSchema).optional().describe("Structured @mentions (user or agent id and name), in addition to @handles in the text."),
  seen: z.object({
    upToSeq: z.number().int().nonnegative().optional(),
    exactSeqs: z.array(z.number().int().positive()).optional(),
  }).optional().describe("Override the seen attestation for this send (runtimes that track what their model saw themselves)."),
  targetConfirmed: z.boolean().optional().describe("The top-level target is intentional even though you last read one of its threads (answering a thread_target interrupt)."),
};

export const sendMessageRequestSchema = lazySchema("sendMessageRequestSchema", () => requestSchema<SendMessageRequest>()(z.object({
  replyTo: agentApiReplyToSchema.optional(),
  target: raftTargetSchema,
  ...sendMessageFields,
})));

/** `reply(message, request)` as one argument object: the received message (its `target`) and the send fields. */
export interface ReplyToRequest extends Omit<SendMessageRequest, "target"> {
  message: Pick<RaftMessage, "target">;
}

export const replyToRequestSchema = lazySchema("replyToRequestSchema", () => requestSchema<ReplyToRequest>()(z.object({
  message: z.object({ target: raftTargetSchema }).describe("The received message to reply to; only its `target` is used."),
  ...sendMessageFields,
})));

export interface RaftSent {
  messageId: string;
  messageSeq: number | null;
  /** Handles in the content that resolved to nobody (Server warning, sender-only). */
  unresolvedMentionHandles: string[];
  /** Newer messages the Server returned alongside the acceptance, if any. */
  recentUnread: RaftMessage[];
}

export type SendMessageOutcome = RaftOutcome<RaftSent, "sent"> | RaftInterrupted;

/**
 * The ways forward a held send prints after "choose one path." When the
 * preview does not account for every new message, resending right away would
 * be held again: read first.
 */
function heldSendPaths(interrupt: RaftInterrupt, style: RaftHintStyle): string {
  const key = interrupt.resume.idempotencyKey;
  const resend = key ? `send it again with idempotencyKey "${key}"` : "send it again";
  const first = interrupt.contextComplete || interrupt.withheld
    ? `To send it unchanged, ${resend}.`
    : `Not all of them are shown here: read the conversation first (${formatHint(RAFT_HINTS.messageRead({ target: interrupt.target }), style)}), then ${resend}.`;
  return `${first} To change it, send the revised content instead. You can also choose not to send anything.\n`;
}

/**
 * A Server freshness hold as an interrupt: the structured details, the held
 * text as `context` (the same text the CLI prints, `formatAgentHold`), and
 * the given resume / cancel.
 */
export function heldInterrupt(
  target: string,
  data: AgentApiHeldFreshnessResponse,
  action: string,
  resume: RaftInterruptResume,
  cancel?: RaftInterruptCancel,
  style: RaftHintStyle = "cli",
): RaftInterrupt {
  const interrupt = unreadMessagesInterrupt({ target, hold: data, context: "", resume, ...(cancel ? { cancel } : {}), hints: style });
  const paths = heldSendPaths(interrupt, style);
  return { ...interrupt, context: formatAgentHold(target, data, { heldAction: action, draftInstructions: paths, isolationInstructions: `${action} ${paths}` }, style).trimEnd() };
}

/**
 * The thread-target check (glimpse G2-5, the CLI's rule from shared): a
 * top-level send right after this context read one of the target's threads
 * stops before anything is sent. Sending to the thread, or resuming with
 * `targetConfirmed: true` (same idempotency key), are the ways on.
 */
function threadTargetInterrupted(
  request: SendMessageRequest,
  idempotencyKey: string,
  mismatch: ThreadTargetMismatch,
  frontier: SeenFrontier,
  style: RaftHintStyle,
): RaftInterrupted {
  const thread = mismatch.threadTarget;
  const context = formatAgentThreadTargetCheck(request.target, thread, {
    toThread: [`  ${formatHint(RAFT_HINTS.messageSend({ target: thread }), style)}`],
    confirm: {
      label: "If the top-level message is intentional, send it again with the target confirmed (same idempotencyKey):",
      lines: [`  ${formatHint(RAFT_HINTS.messageSend({ target: request.target, targetConfirmed: true }), style)}`],
    },
  });
  const interrupt: RaftInterrupt = {
    reason: "thread_target",
    context,
    resume: { idempotencyKey, with: { targetConfirmed: true } },
    target: request.target,
    threadTarget: thread,
    ...(frontier.contextId ? { contextId: frontier.contextId } : {}),
    newMessageCount: 0,
    heldMessages: [],
    omittedMessageCount: 0,
    formalMentionCount: 0,
    seenUpToSeq: null,
    withheld: false,
    contextComplete: true,
  };
  return {
    ok: true,
    state: "interrupted",
    interrupt,
    next: hintStep(
      "send_to_thread",
      RAFT_HINTS.messageSend({ target: thread }),
      "Nothing was sent: this context last read a thread under this target. Send there if the message belongs in the thread; otherwise resume with targetConfirmed: true.",
      style,
      { target: thread },
    ),
    text: context,
  };
}

function heldSendNext(interrupt: RaftInterrupt, style: RaftHintStyle): RaftNextStep {
  return hintStep(
    "resend",
    RAFT_HINTS.messageRead({ target: interrupt.target }),
    interrupt.reason === "unseen_card"
      ? "This context has not seen the conversation's card. Show interrupt.context to the model, call frontier.recordHeld(interrupt) (it books under interrupt.contextId), then resume the send (interrupt.resume, same idempotencyKey) or cancel it."
      : interrupt.withheld
      ? "Newer messages exist in this conversation but were withheld; read them, then resume the send (interrupt.resume, same idempotencyKey) or cancel it."
      : !interrupt.contextComplete
      ? "Newer messages arrived in this conversation and not all of them are shown here; read the conversation, then resume the send (interrupt.resume, same idempotencyKey) or cancel it."
      : "Newer messages arrived in this conversation. Show interrupt.context to the model, call frontier.recordHeld(interrupt) to attest that, then resume the send (interrupt.resume, same idempotencyKey) or cancel it.",
    style,
    { target: interrupt.target },
  );
}

export function isHeldResponse(data: unknown): data is AgentApiHeldFreshnessResponse {
  return Boolean(data) && typeof data === "object" && (data as { state?: unknown }).state === "held";
}

function sentOutcome(target: string, data: Extract<AgentApiSendResponse, { state: "sent" }>, style: RaftHintStyle): SendMessageOutcome {
  const sent: RaftSent = {
    messageId: data.messageId,
    messageSeq: typeof data.messageSeq === "number" ? data.messageSeq : null,
    unresolvedMentionHandles: data.unresolvedMentionHandles ?? [],
    recentUnread: projectRaftMessages(data.recentUnread ?? [], style),
  };
  const warn = sent.unresolvedMentionHandles.length > 0
    ? ` Unresolved @handles: ${sent.unresolvedMentionHandles.map((h) => `@${h}`).join(", ")}.`
    : "";
  return {
    ok: true,
    state: "sent",
    data: sent,
    next: sent.recentUnread.length > 0
      ? hintStep("read_target", RAFT_HINTS.messageRead({ target }), "Newer messages arrived while you were sending.", style, { target })
      : null,
    text: `Message sent to ${target}. Message ID: ${sent.messageId}${warn}`,
  };
}

/**
 * `seenCards` for a send (conversationCards): the card versions this
 * context has, null for unseen. Nothing without a context: such a caller is
 * never held for a card and gets the conversation after every send instead.
 */
function seenCardsForSend(target: string, frontier: SeenFrontier): { channel?: string | null; peer?: string | null } | undefined {
  if (frontier.contextId === null) return undefined;
  const ref = parseRaftRefTarget(target);
  if (ref?.kind === "channel" || ref?.kind === "channel-thread") {
    return { channel: frontier.seenCard("channel", `#${ref.channelName}`) ?? null };
  }
  if (ref?.kind === "dm" || ref?.kind === "dm-thread") {
    const parsed = parseDmPeerRef(ref.peerName);
    if (!parsed.ok) return undefined;
    const ids = parsed.peerKind
      ? [senderObservationId(parsed.peerKind, parsed.peerName)]
      : [senderObservationId("human", parsed.peerName), senderObservationId("agent", parsed.peerName)];
    for (const id of ids) {
      const rev = frontier.seenCard("sender", id);
      if (rev !== undefined) return { peer: rev };
    }
    return { peer: null };
  }
  return undefined;
}

/**
 * After a send with no context (conversationCards): the conversation's cards
 * and latest messages before the sent one, within the push budget. Best
 * effort: the message is committed, so a failed read adds nothing.
 */
async function sendAttachmentText(
  client: Partial<Pick<AgentApiClient, "history">>,
  target: string,
  sentMessageId: string,
  style: RaftHintStyle,
): Promise<string | null> {
  if (!client.history) return null;
  try {
    const result = await client.history.read({ channel: target, limit: "3", consume: "false", before: sentMessageId });
    if (!result.ok) return null;
    const data = result.data as AgentApiHistoryResponse;
    const lines = renderSendAttachment({
      target,
      channelCard: data.channel_card ?? null,
      peerCard: data.peer_card ?? null,
      messages: (data.messages ?? []).map((m) => ({
        seq: typeof m.seq === "number" ? m.seq : undefined,
        sender: m.sender_name ?? null,
        timestamp: m.timestamp ?? null,
        content: m.content ?? "",
      })),
    }, undefined, style);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

export async function sendMessage(
  client: Pick<AgentApiClient, "messages"> & Partial<Pick<AgentApiClient, "history">>,
  request: SendMessageRequest,
  frontier?: SeenFrontier,
  options: RaftCardOptions = {},
): Promise<SendMessageOutcome> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(sendMessageRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A target is required to send a message." }));
  if (typeof request.content !== "string" || (!request.content.trim() && !(request.attachmentIds?.length))) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Message content (or an attachment) is required." }));
  }
  const idempotencyKey = request.idempotencyKey?.trim() || crypto.randomUUID();
  if (frontier && options.threadTargetCheck === true && request.targetConfirmed !== true) {
    const mismatch = detectThreadTargetMismatch(request.target, frontier.latestThreadRead(request.target), frontier.readOrder(request.target));
    if (mismatch) return threadTargetInterrupted(request, idempotencyKey, mismatch, frontier, style);
  }
  const cards = options.conversationCards === true && frontier !== undefined;
  const seenCards = cards ? seenCardsForSend(request.target, frontier) : undefined;
  const attestation = request.seen
    ? { ...(request.seen.upToSeq === undefined ? {} : { seenUpToSeq: request.seen.upToSeq }), seenExactSeqs: request.seen.exactSeqs ?? [] }
    : frontier?.attestation(request.target) ?? { seenExactSeqs: [] };
  const body: AgentApiSendV2Body = {
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    target: request.target,
    content: request.content,
    ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
    idempotencyKey,
    ...(request.mentions?.length ? { mentions: request.mentions } : {}),
    ...(attestation.seenUpToSeq === undefined ? {} : { seenUpToSeq: attestation.seenUpToSeq }),
    ...(attestation.seenExactSeqs.length > 0 ? { seenExactSeqs: attestation.seenExactSeqs.slice(0, 2_500) } : {}),
    ...(seenCards ? { seenCards } : {}),
  };
  // The key makes a repeat safe, so a request that never reached the Server is retried (bounded).
  let result = await client.messages.sendV2(body);
  for (let attempt = 1; !result.ok && result.error.kind === "transport" && attempt < SEND_TRANSPORT_ATTEMPTS; attempt += 1) {
    result = await client.messages.sendV2(body);
  }
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  if (isHeldResponse(data)) {
    // The SDK keeps no draft, so there is no argv to offer: resuming is
    // sending the same request again with `resume.idempotencyKey`, and
    // cancelling is not sending it (nothing to clean up, so no `cancel`).
    const held = heldInterrupt(
      request.target,
      data,
      "Your message was not sent.",
      inProcessSendResume(idempotencyKey),
      undefined,
      style,
    );
    const shownCards = {
      ...(data.channelCard ? { channel: data.channelCard } : {}),
      ...(data.peerCard ? { peer: data.peerCard } : {}),
    };
    const reasons = data.holdReasons ?? [];
    const cardOnly = !reasons.includes("unread_messages") && (reasons.includes("channel_card") || reasons.includes("peer_card"));
    const interrupt: RaftInterrupt = {
      ...held,
      ...(cardOnly ? { reason: "unseen_card" as const } : {}),
      ...(Object.keys(shownCards).length > 0 ? { cards: shownCards } : {}),
      ...(frontier?.contextId ? { contextId: frontier.contextId } : {}),
    };
    return { ok: true, state: "interrupted", interrupt, next: heldSendNext(interrupt, style), text: interrupt.context };
  }
  if (data.state === "sent") {
    const outcome = sentOutcome(request.target, data, style);
    if (!cards) return outcome;
    const extra: string[] = [];
    // A card the reply carries (changed since this context saw it, or sent with an unseen one) is shown and booked.
    const replyCards = {
      ...(data.channelCard ? { channel: data.channelCard } : {}),
      ...(data.peerCard ? { peer: data.peerCard } : {}),
    };
    if (replyCards.channel) extra.push(renderChannelCard(replyCards.channel, { changed: data.channelCardChanged === true, style }).join("\n"));
    if (replyCards.peer) extra.push(renderPeerCard(replyCards.peer, { style }).join("\n"));
    if (replyCards.channel || replyCards.peer) frontier.recordCardsShown(request.target, replyCards);
    const kind = parseRaftRefTarget(request.target)?.kind;
    if (frontier.contextId === null && (kind === "channel" || kind === "channel-thread" || kind === "dm" || kind === "dm-thread")) {
      const attachment = await sendAttachmentText(client, request.target, data.messageId, style);
      if (attachment) extra.push(attachment);
    }
    return extra.length > 0 ? { ...outcome, text: `${outcome.text}\n\n${extra.join("\n\n")}` } : outcome;
  }
  // `committed` / `not_found` only come back from reconcile-only requests, which this operation does not issue.
  return failureOutcome(opError("INVALID_RESPONSE", { message: `Unexpected send state "${(data as { state: string }).state}".` }));
}

/** Reply where a received message came from. */
export function replyTo(
  client: Pick<AgentApiClient, "messages">,
  message: Pick<RaftMessage, "target">,
  request: Omit<SendMessageRequest, "target">,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<SendMessageOutcome> {
  return sendMessage(client, { ...request, target: message.target }, frontier, options);
}
