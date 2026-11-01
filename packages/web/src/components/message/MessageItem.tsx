import Tooltip from "../ui/Tooltip";
import { memo, useCallback, useEffect, useMemo, useRef, useState, Children } from "react";
import type { ChangeEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, TouchEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Copy, MessageCirclePlus, MessageCircleOff, Download, ClipboardCheck, Play, Pause, Volume2, CheckCircle, RotateCcw, Link, Bookmark, BookmarkMinus, Languages, AlertTriangle, Plus, Eye, Music } from "lucide-react";
import {
  Badge,
  Card,
  ContextMenuPopup,
  MessageAttachmentDiffAddition,
  MessageAttachmentDiffDeletion,
  MessageAttachmentDiffSummary,
  MessageAttachmentGroup,
  MessageImageGallery,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemContinuationTime,
  MessageItemFooter,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemInlineStatus,
  MessageItemMeta,
  MessageItemSender,
  MessageItemSenderButton,
  MessageItemTime,
  MessageItemSavedIndicator,
  MessageItemSearchMatch,
  MessageItemTranslationAction,
  MessageItemTranslationFailedStatus,
  MessageItemTranslationOriginal,
  MessageItemTranslationOriginalLabel,
  MessageItemTranslationRetryAction,
  MessageItemTranslationStatus,
  MessageMultiSelectCheckbox,
  MessageReferenceChip,
  MessageReferenceText,
  MessageVideoPreview,
  MessageVideoPreviewAction,
  MessageVideoPreviewFailureAction,
  MessageVideoPreviewFailureContent,
  MessageVideoPreviewFailureIcon,
  MessageVideoPreviewFailureTitle,
  MessageVideoPreviewFallback,
  MessageVideoPreviewMedia,
  PopoverPopup,
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
  Skeleton,
  Spinner,
  SystemMessage,
  SystemMessageContent,
  SystemMessageTime,
  TaskChip,
  TaskStatusIcon,
  ThreadIcon,
  toast,
  buildMessageImageGalleryRows,
  MessageImageGalleryRow,
} from "@botiverse/raft-ui";
import type { Components } from "react-markdown";

// Shared across renders — never created inside a component (task #709).
import { useStore } from "zustand";
import {
  createRaftBareTaskRefRegex,
  createRaftChannelRefRegex,
  createRaftChannelThreadRefRegex,
  createRaftDmRefRegex,
  createRaftDmThreadRefRegex,
  createRaftMalformedDmKindRefRegex,
  createRaftMessageRefRegex,
  createRaftStructuredUserRefRegex,
  createRaftUserRefRegex,
  formatRaftRefTarget,
  messageReactionActorsDiscussion,
  messageRef as canonicalMessageRef,
  parseRaftPermalink,
  parseRaftRefTarget,
  resolveRaftMentionHandle,
} from "@botiverse/raft-shared";
import type {
  ActionCardMetadata,
  ExternalActorKind,
  ExternalMessageAuthorProjection,
  RaftRefTarget,
  ReactionActorRef,
  SyncScopeKey,
} from "@botiverse/raft-shared";
import { useMessageStore } from "../../store/messageStore";
import type { Message, MessageAttachment, MessageMention } from "../../store/messageStore";
import { ActionCard } from "../actions/ActionCard";
import { toRuiTaskStatus } from "../task/taskStatusUi";
import { useAuthStore } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";

import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
// Parked with its render site below — see the note there.
// import TaskChipList from "../task/TaskChipList";
import { isThreadFollowed, useThreadStore } from "../../store/threadStore";
import type { OpenThreadRequest, ThreadSummary } from "../../store/threadStore";
import type { ThreadRepliesScope } from "../../store/threadRepliesReadModel";
import { hasInlineThreadReplySurface, InlineThreadReplies } from "./InlineThreadReplies";
import { useSavedStore } from "../../store/savedStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useAppNavigate, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { useProfileStore } from "../../store/profileStore";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import { useServerStore } from "../../store/serverStore";
import { useTranslationStore } from "../../store/translationStore";
import type { PreferredTranslationDisplay, TranslationEntry } from "../../store/translationStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import {
  getMessageBodyFontSizeClass,
  getMessageBodyFontSizeStyle,
  getMessageMetaSizeClass,
  getMessageNameSizeClass,
  useAppearanceStore,
} from "../../store/appearanceStore";
import api from "../../api/client";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { LightboxCommentContext } from "../../store/imageLightboxStore";
import QuotedMessagePermalinkPreview from "./QuotedMessagePermalinkPreview";
import {
  extractFirstQuotedMessagePermalink,
  localizeExternalReplyPermalink,
  matchesUnavailableQuotedPermalink,
} from "./quotedMessagePermalink";
import MentionLink from "./MentionLink";
import { GalleryImageItem } from "./GalleryImageItem";
import { PermalinkReferenceChip } from "./PermalinkReferenceChip";
import ProfilePreviewCardContent from "./ProfilePreviewCardContent";
import ExternalIdentityPreviewCard from "./ExternalIdentityPreviewCard";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useRefreshingMediaUrl } from "../../hooks/useRefreshingMediaUrl";
import { agentModelLabel, useShowAgentModelName } from "../../utils/agentModelName";
import { useCatalogModelLabel } from "../../store/modelLabelCatalogStore";
import StatusDot from "../ui/StatusDot";
import type { StatusDotProps } from "../ui/StatusDot";
import { formatAgentDisplayStateText } from "../../utils/activity";
import AvatarSlot from "../ui/AvatarSlot";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import DismissBackdrop from "../ui/DismissBackdrop";
import { isAudioPreviewAttachment, isDiffPatchAttachment, isDocumentPreviewAttachment, isVideoPreviewAttachment } from "./attachmentPreview";
import type { DiffAttachmentPreview, DocumentAttachmentPreview } from "./attachmentPreview";
import MarkdownContent, {MarkdownCode, MarkdownLink} from "../markdown/MarkdownContent";
import { isCustomProtocolHref } from "../markdown/CustomProtocolLink";
import { MessageReadReceiptScopeProvider } from "./messageReadReceiptScope";
import type { MessageReadReceiptScope } from "./messageReadReceiptScope";
import { projectReadReceipt } from "../../store/readReceiptDomain";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { fetchAttachmentPreviewSummary } from "./attachmentPreviewSummaryCache";
import { fetchInlineAttachmentUrls } from "./inlineAttachmentUrlCache";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";
import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DOCUMENT_PREVIEW_LABEL_ID, INLINE_AUDIO_PREVIEW_CARD_CLASS } from "./attachmentPreviewSurfaces";
import { parseTimestampLabel, setPendingVideoSeek } from "./attachmentCommentAnchors";
import { useAttachmentCommentsEnabled } from "./useAttachmentCommentsEnabled";
import {
  READ_RECEIPTS_FEATURE_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";
import {
  isLegacyMessageReaction,
  messageReactionParentScopeKey,
} from "../../store/normalizedMessageReactions";
import {
  reactionReadModelStore,
  selectReactionActors,
} from "../../store/reactionReadModels";
import { setMessageReaction } from "../../store/reactionCommandFacade";
import { AttachmentCommentRefChip } from "./AttachmentCommentRefChip";
import { shouldShowGroupedMessageHeader } from "./messageGrouping";
import type { MessageGroupState } from "./messageGrouping";
import { MessageHoverToolbar } from "./MessageHoverToolbar";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentMetaText } from "./AttachmentMetaText";
import ReadOnlyMessageAttachments from "./ReadOnlyMessageAttachments";
import { getHumanDepartureLabel } from "../member/humanMembershipStatus";
import {
  buildImageInlineFallbackKey,
  getImageGalleryPreviewSrc,
  isOptimisticAttachment,
  isPreviewableImageAttachment,
  removeImageInlineFallbackUrl,
  retainImageInlineFallbackUrls,
  setImageInlineFallbackUrl,
  shouldRenderImageAsAttachmentChip,
  splitImageInlineFallbackKey,
} from "./urlImageFallback";
import { ThreadRepliesBadge } from "./ThreadRepliesBadge";
import CollapsibleMessageContent from "./CollapsibleMessageContent";

import { formatReminderReceiptContentTitle, formatReminderReceiptTime, formatReminderReceiptTooltip, splitReminderReceiptFireAtTokens } from "../../utils/reminderReceiptTime";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import type { TimeFormatOptions } from "../../utils/timeFormatting";
import {
  buildThreadRefHandoffPath,
  captureThreadRouteAuthorityGuard,
  findThreadRefParentChannel,
  resolveThreadTargetByShortId,
} from "../../utils/threadRefNavigation";
import type {
  ThreadRefIntent,
  ThreadRouteTarget,
} from "../../utils/threadRefNavigation";
import { MESSAGE_MARKDOWN_REHYPE_PLUGINS, messageMarkdownRemarkPlugins } from "./messageMarkdownSecurity";
import { highlightThreadSearchInTree, normalizeThreadSearchQuery } from "./threadSearch";
import {
  messageTokenNode,
  plainTextOf,
  replaceLinksInTree,
  replaceTokensInTree,
} from "./remarkMessageTokens";
import type { TextTokenMatcher } from "./remarkMessageTokens";
import { repairGeneratedMarkdown, unwrapDmKindStrikethrough } from "./repairGeneratedMarkdown";
import type { Root as MdastRoot } from "mdast";
import type { VFile } from "vfile";
import { QUICK_REACTION_EMOJIS } from "./reactionConstants";
import ReactionGlyph from "./ReactionGlyph";
import { useFloatingOverlayPosition } from "../ui/useFloatingOverlayPosition";
import { placeTouchMessageContextMenu } from "./messageContextMenuPosition";
import { isForwardedBundleMetadata } from "./ForwardedBundleCard";
import type { ForwardedBundleAttachmentSnapshot, ForwardedBundleItem } from "./ForwardedBundleCard";
import ForwardedBundleRouteCard from "./ForwardedBundleRouteCard";
import { openConversationAgentActivity, openConversationAgentProfile } from "../../utils/profilePanelUrl";
import { formatMemberRole } from "../../utils/memberRoleLabel";
import { findDmByPeer } from "../../utils/refTarget";
import { dispatchSenderMentionInsert } from "./senderMentionInsert";
import { dismissLayerProps } from "../ui/dismissLayer";

// raft-ui's task status ids are kebab-case; slock's are snake_case.

const REACTION_PICKER_EVENT = "raft:message-reaction-picker-open";
const REACTION_PICKER_WIDTH = 224;
const REACTION_PICKER_HEIGHT = 42;
const REACTION_PICKER_VIEWPORT_MARGIN = 8;
const QUICK_REACTION_GLYPH_SIZE = 18;
const SENDER_AVATAR_LONG_PRESS_MS = 500;
const SENDER_AVATAR_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
function ThreadSearchFragmentHighlight({ children }: { children?: ReactNode }) {
  return (
    <MessageItemSearchMatch data-testid="thread-search-fragment-highlight">
      {children}
    </MessageItemSearchMatch>
  );
}

function highlightThreadSearchInlineCode(
  children: ReactNode,
  query: string | undefined,
): ReactNode {
  const normalizedQuery = normalizeThreadSearchQuery(query ?? "");
  if (!normalizedQuery) return children;

  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;

    const lowerText = child.toLocaleLowerCase();
    const fragments: ReactNode[] = [];
    let cursor = 0;
    let matchIndex = lowerText.indexOf(normalizedQuery);
    while (matchIndex !== -1) {
      fragments.push(child.slice(cursor, matchIndex));
      const matchEnd = matchIndex + normalizedQuery.length;
      fragments.push(
        <ThreadSearchFragmentHighlight key={`${matchIndex}:${matchEnd}`}>
          {child.slice(matchIndex, matchEnd)}
        </ThreadSearchFragmentHighlight>,
      );
      cursor = matchEnd;
      matchIndex = lowerText.indexOf(normalizedQuery, cursor);
    }
    fragments.push(child.slice(cursor));
    return fragments;
  });
}

function buildOptimisticReactionMessage(
  message: Message,
  emoji: string,
  alreadyReacted: boolean,
  viewerUserId: string,
  viewerReactionName: string,
  unknownReactorName: string,
): Message {
  const reactions = message.reactions ?? [];
  if (!reactions.every(isLegacyMessageReaction)) return message;
  const existingIndex = reactions.findIndex((reaction) => reaction.emoji === emoji);

  if (alreadyReacted) {
    if (existingIndex < 0) return message;
    const existing = reactions[existingIndex];
    const nextReactorIds: string[] = [];
    const nextReactorNames: string[] = [];

    existing.reactorIds.forEach((reactorId, index) => {
      if (reactorId === viewerUserId) return;
      nextReactorIds.push(reactorId);
      nextReactorNames.push(existing.reactorNames[index] ?? unknownReactorName);
    });

    const nextReaction = {
      ...existing,
      count: nextReactorIds.length,
      reactorIds: nextReactorIds,
      reactorNames: nextReactorNames,
    };
    const nextReactions = reactions.map((reaction, index) => (
      index === existingIndex ? nextReaction : reaction
    ));
    return { ...message, reactions: nextReactions };
  }

  if (existingIndex >= 0) {
    const existing = reactions[existingIndex];
    if (existing.reactorIds.includes(viewerUserId)) return message;
    const nextReaction = {
      ...existing,
      count: existing.count + 1,
      reactorIds: [...existing.reactorIds, viewerUserId],
      reactorNames: [...existing.reactorNames, viewerReactionName],
    };
    const nextReactions = reactions.map((reaction, index) => (
      index === existingIndex ? nextReaction : reaction
    ));
    return { ...message, reactions: nextReactions };
  }

  return {
    ...message,
    reactions: [
      ...reactions,
      {
        emoji,
        count: 1,
        reactorIds: [viewerUserId],
        reactorNames: [viewerReactionName],
      },
    ],
  };
}

function replaceReactionForEmoji(
  message: Message,
  source: Message,
  emoji: string,
): Message {
  const sourceReaction = (source.reactions ?? []).find((reaction) => reaction.emoji === emoji);
  const reactions = message.reactions ?? [];

  if (!sourceReaction) {
    return { ...message, reactions: reactions.filter((reaction) => reaction.emoji !== emoji) };
  }

  if (reactions.some((reaction) => reaction.emoji === emoji)) {
    return {
      ...message,
      reactions: reactions.map((reaction) => reaction.emoji === emoji ? sourceReaction : reaction),
    };
  }

  return { ...message, reactions: [...reactions, sourceReaction] };
}

function mergeReactionResponsePreservingPending(
  currentMessage: Message,
  serverMessage: Message,
  pendingEmojis: Set<string>,
): Message {
  if (pendingEmojis.size === 0) return serverMessage;

  let merged = serverMessage;
  for (const emoji of pendingEmojis) {
    merged = replaceReactionForEmoji(merged, currentMessage, emoji);
  }
  return merged;
}

function ReactionCount({ count }: { count: number }) {
  const previousCountRef = useRef(count);
  const [animationKey, setAnimationKey] = useState(0);

  // animation-key bump pattern: functional updater bumps an internal counter
  // (NOT derived from count — it's a change-event counter used to retrigger
  // CSS animation on key change). `previousCountRef` guard ensures only real
  // count transitions bump. The rule's "compute during render" suggestion
  // cannot express this (the key is animation state, not derived data).
  useEffect(() => {
    if (previousCountRef.current === count) return;
    previousCountRef.current = count;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAnimationKey((key) => key + 1);
  }, [count]);

  return (
    <span
      key={animationKey}
      className={`font-mono text-mono-meta font-bold tabular-nums ${animationKey > 0 ? "reaction-count-bump" : ""}`}
    >
      {count}
    </span>
  );
}

export interface MentionEntry {
  displayName: string;
  /** `external` = linked provider member — never linkable, renders as text. */
  type: "agent" | "user" | "external";
  id: string;
  agent?: Agent;
}

// External-origin text has no Raft mention authority of its own: free text such
// as `@owner` stays plain in the Human UI. Only mention facts the server minted
// for the message (Slack usergroup, linked identity, typed member name) are
// highlighted, through the structured map. Keep this shared empty map
// referentially stable so MessageMarkdownBody remains memo-friendly.
const EXTERNAL_MESSAGE_MENTION_MAP = new Map<string, MentionEntry>();

/** Build a lookup map of all mentionable names → display info */
export function buildMentionMap(
  agents: Agent[],
  humans: ServerMember[],
  channelAgents: Agent[] = [],
  channelHumans: ChannelHuman[] = [],
): Map<string, MentionEntry> {
  const map = new Map<string, MentionEntry>();
  for (const agent of [...agents, ...channelAgents]) {
    map.set(agent.name, {
      displayName: agent.displayName || agent.name,
      type: "agent",
      id: agent.id,
      agent,
    });
  }
  for (const human of humans) {
    map.set(human.name, {
      displayName: human.displayName || human.name,
      type: "user",
      id: human.userId,
    });
  }
  for (const human of channelHumans) {
    map.set(human.name, {
      displayName: human.displayName || human.name,
      type: "user",
      id: human.id,
    });
  }
  return map;
}

function buildStructuredMentionMap(mentions: MessageMention[] | undefined): Map<string, MentionEntry> {
  const map = new Map<string, MentionEntry>();
  for (const mention of mentions ?? []) {
    const name = mention.name.trim();
    if (!name) continue;
    map.set(name, {
      displayName: mention.displayName?.trim() || name,
      type: mention.type,
      id: mention.id,
    });
  }
  return map;
}

const mentionIdentityMapCache = new WeakMap<Map<string, MentionEntry>, Map<string, MentionEntry>>();

function buildMentionIdentityMap(mentionMap: Map<string, MentionEntry>): Map<string, MentionEntry> {
  const cached = mentionIdentityMapCache.get(mentionMap);
  if (cached) return cached;
  const map = new Map<string, MentionEntry>();
  for (const entry of mentionMap.values()) {
    map.set(`${entry.type}:${entry.id}`, entry);
  }
  mentionIdentityMapCache.set(mentionMap, map);
  return map;
}

function getRaftRefProp(node: any, prop: string): string | undefined {
  const value = node?.properties?.[prop] ?? node?.properties?.[`data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`];
  return typeof value === "string" ? value : undefined;
}

/** Render message content as Markdown with @mention and #channel highlighting.
    Hook-named: it memoizes the markdown components map and handlers (task #709),
    and is called exactly once, unconditionally, inside MessageMarkdownBody. */
function useRenderMessageMarkdown(
  content: string,
  channels: Channel[],
  mentionMap: Map<string, MentionEntry>,
  structuredMentionMap: Map<string, MentionEntry>,
  onNavigateChannel: (channel: Channel) => void,
  onNavigateDm: (channel: Channel) => void,
  onNavigateAgent: (agentId: string) => void,
  onNavigateHuman: (userId: string) => void,
  onNavigateExternal: ((profile: ExternalMessageAuthorProjection) => void) | undefined,
  onNavigateComputer: (machineId: string) => void,
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>,
  resolvingThreadRefKey?: string | null,
  onOpenTaskRef?: (taskNumber: number) => void,
  onOpenMessageRef?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>,
  onOpenPermalink?: (href: string) => void,
  currentServerSlug?: string,
  refAuthorityServerSlug?: string,
  threadRefAuthorityUnavailable = false,
  knownTaskNumbers?: Set<number>,
  taskByNumber?: ReadonlyMap<number, Task>,
  timeFormatOptions: TimeFormatOptions = {},
  threadSearchHighlightQuery?: string,
  formatMessage?: IntlShape["formatMessage"],
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>,
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>,
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>,
  unavailableQuotedPermalinkUrl?: string | null,
  mentionsDisplayOnly = false,
) {
  // Inline task refs render rui's inline `TaskChip` when the referenced task is
  // loaded in the client store. The chip is designed for running text —
  // borderless and body-sized — so a mixed line (#mention-mix) keeps its
  // baseline; it reads the same `task-status-*` tokens as every other surface,
  // so the status colour still matches (task-status unification).
  // Unknown tasks keep a neutral badge so the chip never claims a status it
  // does not know.
  //
  // The inline badge shows the status icon + `#N` and deliberately NOT the
  // assignee: the badge sits inside the sender's sentence, and an `@name`
  // there reads as a mention the author never wrote (task #1252 — "等 #211
  // @peng 做完", where @peng came from the badge). The footer badge is not
  // inside a sentence and keeps the assignee; the task detail shows it too.
  //
  // No Tooltip wrapper here on purpose: the footer badge's tooltip mounts a
  // base-ui trigger with an auto-generated id, and the evidence contract in
  // tests/taskRefChannelScope.evidence.test.tsx requires the rendered ref
  // markup to be byte-identical across renders of the same number.
  const renderTaskBadge = useCallback((taskNumber: number) => {
    const task = taskByNumber?.get(taskNumber);
    if (!task) return null;
    return (
      <TaskChip
        variant="inline"
        status={toRuiTaskStatus(task.status)}
        data-status={task.status}
        data-testid="message-task-ref-badge"
        render={
          <a
            href="#"
            className="cursor-default"
            data-message-affordance="open-linked-task"
            onClick={(e) => {
              e.preventDefault();
              onOpenTaskRef?.(taskNumber);
            }}
          >
            <TaskStatusIcon status={toRuiTaskStatus(task.status)} />
            <span className="shrink-0">{taskNumberSigil(task.taskNumber)}</span>
          </a>
        }
      />
    );
  }, [taskByNumber, onOpenTaskRef]);
  // Task #762: every ref below is recognised on the parsed markdown tree
  // (remarkMessageTokens), so code, links and escapes are skipped by the
  // parser itself. Matchers run in this order; each sees only the text the
  // earlier ones left alone, which is the precedence the old placeholders
  // enforced (thread refs before mentions, `dm:@peer` before `@peer`).
  const messageRefsPlugin = useMemo(() => {
    const channelNameSet = new Set(channels.map((c) => c.name.toLowerCase()));
    const crossServerAuthority = !!refAuthorityServerSlug
      && !!currentServerSlug
      && refAuthorityServerSlug !== currentServerSlug;
    let mentionIdentityMap: Map<string, MentionEntry> | null = null;
    const resolveMentionByIdentity = (type: "agent" | "user" | "external", id: string) => {
      mentionIdentityMap ??= buildMentionIdentityMap(mentionMap);
      return mentionIdentityMap.get(`${type}:${id}`);
    };
    const plain = (text: string) => messageTokenNode("span", text);
    const raftRefAnchor = (target: RaftRefTarget, label: string) =>
      messageTokenNode("a", label, {
        dataRaftRefKind: target.kind,
        dataRaftRefTarget: formatRaftRefTarget(target),
      });
    const mentionAnchor = (name: string, entry: MentionEntry) => {
      const resolvedMention = resolveMentionByIdentity(entry.type, entry.id);
      const visibleLabel = resolvedMention?.displayName ? `@${resolvedMention.displayName}` : `@${name}`;
      return messageTokenNode("a", visibleLabel, {
        dataMention: name,
        dataMentionType: entry.type,
        dataMentionId: entry.id,
      });
    };

    const matchers: TextTokenMatcher[] = [
      // `<target>` refs. `\<target>` is the escape: it stays literal text and
      // no later matcher may claim part of it.
      {
        pattern: /<([^<>\n]+)>/g,
        replace: (match, { escaped }) => {
          const target = parseRaftRefTarget(match[1]);
          if (!target) return false;
          if (escaped) return plain(match[0]);
          return raftRefAnchor(target, formatRaftRefTarget(target));
        },
      },
      {
        pattern: createRaftMessageRefRegex(),
        replace: (match) => {
          const [, channelName, threadParentShortId, messageId] = match;
          const target = parseRaftRefTarget(
            threadParentShortId
              ? `#${channelName}:${threadParentShortId} msg=${messageId}`
              : `#${channelName} msg=${messageId}`,
          );
          return target ? raftRefAnchor(target, formatRaftRefTarget(target)) : false;
        },
      },
      // Thread refs MUST run before the mention matchers: `dm:@peer(:shortId)?`
      // contains `@peer`, and letting mentions claim it first breaks the ref
      // into `dm:` + mention chip (+ `:shortId`) — the production regression
      // where `dm:@artin:1f1def75` stopped being clickable.
      {
        pattern: createRaftChannelThreadRefRegex(),
        replace: (match) => {
          const [text, chanName, shortId] = match;
          if (threadRefAuthorityUnavailable) return plain(text);
          if (!channelNameSet.has(chanName.toLowerCase()) && !crossServerAuthority) return false;
          const chan = channels.find((c) => c.name.toLowerCase() === chanName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint"));
          return messageTokenNode("a", `#${chanName}:${shortId}`, {
            dataThreadRef: shortId,
            dataThreadParent: crossServerAuthority ? "" : chan?.id || "",
            dataThreadParentName: chanName,
          });
        },
      },
      {
        pattern: createRaftDmThreadRefRegex(),
        replace: (match) => {
          const [text, peerName, shortId] = match;
          if (threadRefAuthorityUnavailable) return plain(text);
          const dm = findDmByPeer(channels, peerName);
          // Unresolvable refs must read identically to the source — claim the
          // whole token as plain text instead of letting the mention matcher
          // chip `@peer` out of it.
          if (!dm && !crossServerAuthority) return plain(text);
          return messageTokenNode("a", `dm:@${peerName}:${shortId}`, {
            dataThreadRef: shortId,
            dataThreadParent: crossServerAuthority ? "" : dm?.id || "",
            dataThreadParentName: crossServerAuthority ? peerName : dm?.name || peerName,
            dataThreadParentType: "dm",
          });
        },
      },
      // Bare `dm:@peer` refs: claim the whole token (same preemption rule) and
      // render through the raft-ref anchor path, which navigates to the DM.
      {
        pattern: createRaftDmRefRegex(),
        replace: (match) => {
          const [text, peerName] = match;
          if (!findDmByPeer(channels, peerName)) return plain(text);
          return raftRefAnchor({ kind: "dm", peerName }, text);
        },
      },
      // `dm:@name~bot` (unknown peer kind) is not a ref: keep it plain text so
      // neither `dm:@name` nor the mention matcher turns it into another target.
      { pattern: createRaftMalformedDmKindRefRegex(), replace: (match) => plain(match[0]) },
      // A selected mention is an identity-backed entity, not a fresh username
      // guess. Keep it mentionable after left-boundary edits such as
      // `草案@Mona` and before CJK suffixes such as `@Mona的`; a Latin right
      // boundary still prevents a stale `@Mona` entity from claiming `@Monica`.
      ...[...structuredMentionMap].flatMap(([name, entry]): TextTokenMatcher[] => {
        const pattern = createRaftStructuredUserRefRegex(name);
        return pattern ? [{ pattern, replace: () => mentionAnchor(name, entry) }] : [];
      }),
      // Free text still uses the conservative grammar so emails/package-like
      // strings never become notifications merely because a directory name
      // happens to match.
      {
        pattern: createRaftUserRefRegex(),
        replace: (match) => {
          const [, prefix, token] = match;
          const resolved = resolveRaftMentionHandle(
            token,
            (name) => structuredMentionMap.has(name) || mentionMap.has(name),
          );
          if (!resolved) return false; // Not a known name — keep as plain text
          const entry = structuredMentionMap.get(resolved.handle) ?? mentionMap.get(resolved.handle);
          if (!entry) return false;
          return [
            { type: "text", value: prefix },
            mentionAnchor(resolved.handle, entry),
            { type: "text", value: resolved.suffix },
          ];
        },
      },
      // "task #205" always links; bare "#205" only if it's a known task.
      {
        pattern: createRaftBareTaskRefRegex(),
        replace: (match) => {
          const [, prefix, taskKeyword, taskNumber] = match;
          if (!taskKeyword && !knownTaskNumbers?.has(Number(taskNumber))) return false;
          return [
            { type: "text", value: `${prefix}${taskKeyword ?? ""}` },
            messageTokenNode("a", `#${taskNumber}`, { dataTaskRef: taskNumber }),
          ];
        },
      },
      // #channel refs: only a known channel becomes a link.
      {
        pattern: createRaftChannelRefRegex(),
        replace: (match) => {
          const [, name] = match;
          if (!channelNameSet.has(name.toLowerCase())) return false;
          return messageTokenNode("a", `#${name}`, { dataChannel: name });
        },
      },
    ];

    return () => (tree: MdastRoot, file: VFile) => {
      repairGeneratedMarkdown(tree, file);
      unwrapDmKindStrikethrough(tree, file);
      replaceLinksInTree(tree, (link) => {
        // `[label](<target>)` and `<dm:@peer>`: the parser made these links,
        // and only the angle-bracket forms are refs (`[x](#general)` is not).
        const source = file.value ? String(file.value).slice(link.position?.start.offset ?? 0, link.position?.end.offset ?? 0) : "";
        const isLabelled = /\]\(<[^<>\n]+>\)$/.test(source);
        const isAutolink = source === `<${link.url}>`;
        if (!isLabelled && !isAutolink) return null;
        const target = parseRaftRefTarget(link.url);
        if (!target) return null;
        return raftRefAnchor(target, isLabelled ? plainTextOf(link) : formatRaftRefTarget(target));
      });
      replaceTokensInTree(tree, matchers, file);
      highlightThreadSearchInTree(tree, threadSearchHighlightQuery ?? "");
    };
  }, [
    channels, mentionMap, structuredMentionMap, knownTaskNumbers, threadRefAuthorityUnavailable,
    refAuthorityServerSlug, currentServerSlug, threadSearchHighlightQuery,
  ]);
  const remarkPlugins = useMemo(
    () => messageMarkdownRemarkPlugins(messageRefsPlugin),
    [messageRefsPlugin],
  );

  // Chat body shares its visual styling (code blocks, lists, headings, table,
  // etc.) with attachment preview via BASE_MARKDOWN_COMPONENTS in
  // MarkdownContent. We override only the elements that need chat-specific
  // behavior — `a` (mentions / channel refs / task refs / thread refs /
  // raft permalinks) and `span` (reminder receipts).
  // stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137).
  const markdownComponents = useMemo(() => ({
    code: ({ children, className }) => (
      <MarkdownCode className={className}>
        {className
          ? children
          : highlightThreadSearchInlineCode(children, threadSearchHighlightQuery)}
      </MarkdownCode>
    ),
    // Links — handle @mention, #channel, and regular URLs
    a: ({ href, children, node }) => {
          const raftRefTarget = getRaftRefProp(node, "dataRaftRefTarget");
          if (raftRefTarget) {
            const target = parseRaftRefTarget(raftRefTarget);
            if (!target) return <span>{children}</span>;

            if (target.kind === "user") {
              const entry = structuredMentionMap.get(target.name) ?? mentionMap.get(target.name);
              if (!entry) return <span>{children}</span>;
              if (mentionsDisplayOnly) return renderDisplayOnlyMention(children);
              return (
                <MentionLink
                  mentionType={entry.type}
                  mentionId={entry.id}
                  fallbackLabel={target.name}
                  fallbackAgent={entry.type === "agent" ? channelParticipantAgentsById?.get(entry.id) : undefined}
                  fallbackMember={entry.type === "user" ? channelParticipantMembersById?.get(entry.id) : undefined}
                  fallbackExternal={entry.type === "external" ? channelParticipantExternalsById?.get(entry.id) : undefined}
                  onNavigateAgent={onNavigateAgent}
                  onNavigateHuman={onNavigateHuman}
                  onNavigateExternal={onNavigateExternal}
                >
                  {children}
                </MentionLink>
              );
            }

            if (target.kind === "computer") {
              return (
                <MessageReferenceChip
                  variant="link"
                  className="cursor-default"
                  render={
                    <a data-testid={`computer-reference-${target.machineId}`}
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigateComputer(target.machineId);
                      }}>
                      {children}
                    </a>
                  }
                />
              );
            }

            if (target.kind === "app") {
              return (
                <Tooltip content={formatMessage?.({ id: "message.messageItem.appReferenceOnly" })}>
                <MessageReferenceText
                  variant="primary"
                                    render={
                    <span data-testid={`app-reference-${target.appId}`} />}>
                  {children}
                </MessageReferenceText>
                </Tooltip>
              );
            }

            if (target.kind === "channel" || target.kind === "channel-thread" || target.kind === "message") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const channel = channels.find(
                (entry) =>
                  entry.name.toLowerCase() === target.channelName.toLowerCase() &&
                  (entry.type === "channel" || entry.type === "private" || entry.type === "joint"),
              );
              const crossServerThreadTarget = crossServerAuthority
                && (target.kind === "channel-thread" || (target.kind === "message" && !!target.threadParentShortId));
              if (!channel && !crossServerThreadTarget) return <span>{children}</span>;

              if (target.kind === "channel") {
                if (!channel) return <span>{children}</span>;
                return (
                  <MessageReferenceChip
                    variant="accent"
                    className="cursor-default"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigateChannel(channel);
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }

              if (target.kind === "channel-thread") {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                if (!onOpenThread) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                const parentChannelId = crossServerAuthority ? null : channel?.id ?? null;
                const threadRefKey = `${routeServerSlug}:${target.channelName.toLowerCase()}:${target.threadShortId.toLowerCase()}`;
                const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
                return (
                  <MessageReferenceChip
                    variant="link"
                    className={`${isResolvingThreadRef ? "cursor-wait opacity-80" : "cursor-default"}`}
                    render={
                      <a href="#"
                        aria-busy={isResolvingThreadRef}
                        onClick={(e) => {
                          e.preventDefault();
                          if (isResolvingThreadRef) return;
                          void onOpenThread({
                            serverSlug: routeServerSlug,
                            parentChannelName: target.channelName,
                            parentChannelId,
                            shortId: target.threadShortId,
                          });
                        }}>
                        <span>{children}</span>
                        {isResolvingThreadRef ? (
                          <Spinner size="xs" className="ml-1 align-[-1px]" aria-label={formatMessage?.({ id: "common.loadingLabel" })} />
                        ) : null}
                      </a>
                    }
                  />
                );
              }

              if (target.threadParentShortId && onOpenThread) {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                return (
                  <MessageReferenceText
                    variant="primary"
                    className="cursor-default"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void onOpenThread({
                            serverSlug: routeServerSlug,
                            parentChannelName: target.channelName,
                            parentChannelId: crossServerAuthority ? null : channel?.id ?? null,
                            shortId: target.threadParentShortId!,
                            focusedMessageId: target.messageId,
                          });
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }

              if (!onOpenMessageRef) return <span>{children}</span>;
              if (!channel) return <span>{children}</span>;
              return (
                <MessageReferenceText
                  variant="primary"
                  className="cursor-default"
                  render={
                    <a href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void onOpenMessageRef?.(channel, target.messageId, target.threadParentShortId);
                      }}>
                      {children}
                    </a>
                  }
                />
              );
            }

            if (target.kind === "dm" || target.kind === "dm-thread") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const dm = findDmByPeer(channels, target.peerName);
              if (!dm && !(crossServerAuthority && target.kind === "dm-thread")) return <span>{children}</span>;
              if (target.kind === "dm") {
                if (!dm) return <span>{children}</span>;
                return (
                  <MessageReferenceChip
                    variant="accent"
                    className="cursor-default"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigateDm(dm);
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }
              if (!onOpenThread) return <span>{children}</span>;
              if (threadRefAuthorityUnavailable) return <span>{children}</span>;
              const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
              if (!routeServerSlug) return <span>{children}</span>;
              return (
                <MessageReferenceChip
                  variant="link"
                  className="cursor-default"
                  render={
                    <a href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void onOpenThread({
                          serverSlug: routeServerSlug,
                          parentChannelName: crossServerAuthority ? target.peerName : dm!.name,
                          parentChannelType: "dm",
                          parentChannelId: crossServerAuthority ? null : dm!.id,
                          shortId: target.threadShortId,
                        });
                      }}>
                      {children}
                    </a>
                  }
                />
              );
            }

            if (target.kind === "task" && onOpenTaskRef) {
              const taskBadge = renderTaskBadge(target.taskNumber);
              if (taskBadge) return taskBadge;
              return (
                <a
                  href="#"
                  className="cursor-default"
                  data-message-affordance="open-linked-task"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenTaskRef(target.taskNumber);
                  }}>
                  <Badge variant="muted">{children}</Badge>
                </a>
              );
            }

            return <span>{children}</span>;
          }

          // @mention → clickable, navigates to agent or human detail
          const mentionName = node?.properties?.dataMention as string | undefined;
          if (mentionName) {
            const mentionType = node?.properties?.dataMentionType as string | undefined;
            const mentionId = node?.properties?.dataMentionId as string | undefined;

            if (mentionsDisplayOnly) return renderDisplayOnlyMention(children);
            if (!mentionId || (mentionType !== "agent" && mentionType !== "user" && mentionType !== "external")) {
              return (
                <span className="font-bold text-foreground underline decoration-foreground-hint decoration-[1.5px] underline-offset-[3px] select-text">
                  {children}
                </span>
              );
            }

            return (
              <MentionLink
                mentionType={mentionType}
                mentionId={mentionId}
                fallbackLabel={mentionName}
                fallbackAgent={mentionType === "agent" ? channelParticipantAgentsById?.get(mentionId) : undefined}
                fallbackMember={mentionType === "user" ? channelParticipantMembersById?.get(mentionId) : undefined}
                fallbackExternal={mentionType === "external" ? channelParticipantExternalsById?.get(mentionId) : undefined}
                onNavigateAgent={onNavigateAgent}
                onNavigateHuman={onNavigateHuman}
                onNavigateExternal={onNavigateExternal}
              >
                {children}
              </MentionLink>
            );
          }
          // Thread reference → clickable, opens thread panel
          const threadRef = node?.properties?.dataThreadRef as string | undefined;
          if (threadRef && onOpenThread) {
            if (threadRefAuthorityUnavailable) return <span>{children}</span>;
            const parentId = node?.properties?.dataThreadParent as string | undefined;
            const parentName = node?.properties?.dataThreadParentName as string | undefined;
            const parentType = node?.properties?.dataThreadParentType === "dm" ? "dm" : "channel";
            const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
            const crossServerAuthority = !!refAuthorityServerSlug
              && !!currentServerSlug
              && refAuthorityServerSlug !== currentServerSlug;
            if (!routeServerSlug || !parentName || (!parentId && !crossServerAuthority)) {
              return (
                <MessageReferenceChip
                  variant="link"
                  className="opacity-60"
                  render={
                    <span />}>
                  {children}
                </MessageReferenceChip>
              );
            }
            const threadRefKey = `${routeServerSlug}:${parentName.toLowerCase()}:${threadRef.toLowerCase()}`;
            const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
            return (
              <MessageReferenceChip
                variant="link"
                className={`${isResolvingThreadRef ? "cursor-wait opacity-80" : "cursor-default"}`}
                render={
                  <a href="#"
                    aria-busy={isResolvingThreadRef}
                    onClick={(e) => {
                      e.preventDefault();
                      if (isResolvingThreadRef) return;
                      void onOpenThread({
                        serverSlug: routeServerSlug,
                        parentChannelName: parentName,
                        parentChannelType: parentType,
                        parentChannelId: crossServerAuthority ? null : parentId,
                        shortId: threadRef,
                      });
                    }}>
                    <span>{children}</span>
                    {isResolvingThreadRef ? (
                      <Spinner size="xs" className="ml-1 align-[-1px]" aria-label={formatMessage?.({ id: "common.loadingLabel" })} />
                    ) : null}
                  </a>
                }
              />
            );
          }
          // #channel → clickable, navigates to channel
          const channelName = node?.properties?.dataChannel as string | undefined;
          if (channelName) {
            const channel = channels.find(
              (c) => c.name.toLowerCase() === channelName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint")
            );
            if (!channel) {
              return (
                <MessageReferenceChip
                  variant="accent"
                  className="opacity-60"
                  render={
                    <span />}>
                  {children}
                </MessageReferenceChip>
              );
            }
            return (
              <MessageReferenceChip
                variant="accent"
                className="cursor-default"
                render={
                  <a href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigateChannel(channel);
                    }}>
                    {children}
                  </a>
                }
              />
            );
          }
          // #205 → clickable, resolves a task in the current channel context.
          // Task refs reuse the message-side task badge (task #662); unknown
          // tasks keep a neutral badge that claims no status color.
          const taskRef = node?.properties?.dataTaskRef as string | undefined;
          if (taskRef && onOpenTaskRef) {
            const taskNumber = Number(taskRef);
            if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
              return (
                <span className="opacity-60">
                  <Badge variant="muted">{children}</Badge>
                </span>
              );
            }
            const taskBadge = renderTaskBadge(taskNumber);
            if (taskBadge) return taskBadge;
            return (
              <a
                href="#"
                className="cursor-default"
                data-message-affordance="open-linked-task"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenTaskRef(taskNumber);
                }}>
                <Badge variant="muted">{children}</Badge>
              </a>
            );
          }
          const raftPermalink = href
            ? parseRaftPermalink(
                href,
                typeof window !== "undefined" ? window.location.hostname : undefined
              )
            : null;
          if (href && raftPermalink) {
            const quotedMessageUnavailable = matchesUnavailableQuotedPermalink(
              href,
              unavailableQuotedPermalinkUrl,
              typeof window !== "undefined" ? window.location.hostname : undefined,
            );
            const channel = channels.find((entry) => entry.id === raftPermalink.channelId);
            const channelLabel = quotedMessageUnavailable
              ? (formatMessage
                ? formatMessage({ id: "message.messageItem.unavailableLinkedMessage" })
                : "Unavailable linked message")
              : channel
              ? channel.type === "dm"
                ? `@${channel.peerDisplayName || channel.peerName || channel.name}`
                : `#${channel.name}`
              : (formatMessage
                ? formatMessage({ id: "message.messageItem.linkedMessageFallback" })
                : "linked message");
            return (
              <PermalinkReferenceChip
                href={href}
                quotedMessageUnavailable={quotedMessageUnavailable}
                channelLabel={channelLabel}
                onOpenPermalink={onOpenPermalink}
              />
            );
          }
          // Custom-protocol links (obsidian:// and friends, per the sanitize
          // href allowlist) delegate to the canonical MarkdownLink, which
          // confirms before handing off to the OS (task #734).
          if (isCustomProtocolHref(href)) {
            return <MarkdownLink href={href}>{children}</MarkdownLink>;
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground-link underline decoration-2 underline-offset-2 hover:decoration-attention select-text"
            >
              {children}
            </a>
          );
        },
        // Reminder-receipt span: when ReactMarkdown sees `<span data-reminder-fire-at="...">...</span>`
        // (rehypeRaw + sanitize lets that data attribute through), re-render
        // with a humanized fire time + tooltip. Other `<span>`s pass through
        // unchanged.
        span: ({ children, node, ...props }) => {
          const reminderFireAt = (node?.properties?.dataReminderFireAt
            || node?.properties?.["data-reminder-fire-at"]) as string | undefined;
          if (reminderFireAt) {
            return (
              <Tooltip content={formatReminderReceiptTooltip(reminderFireAt, timeFormatOptions)}>
              <span
                {...props}
              >
                {formatMessage
                  ? formatReminderReceiptTime(reminderFireAt, formatMessage, new Date(), timeFormatOptions)
                  : reminderFireAt}
              </span>
              </Tooltip>
            );
          }
          return <span {...props}>{children}</span>;
        },
        mark: ({ children }) => (
          <ThreadSearchFragmentHighlight>{children}</ThreadSearchFragmentHighlight>
        ),
      } as Components), [
      threadSearchHighlightQuery, structuredMentionMap, mentionMap,
      channelParticipantAgentsById, channelParticipantMembersById, channelParticipantExternalsById,
      onNavigateAgent, onNavigateHuman, onNavigateExternal, onNavigateComputer, onNavigateChannel,
      onNavigateDm, onOpenThread, onOpenMessageRef, onOpenTaskRef, onOpenPermalink,
      formatMessage, channels, refAuthorityServerSlug, currentServerSlug,
      threadRefAuthorityUnavailable, resolvingThreadRefKey, renderTaskBadge,
      timeFormatOptions, unavailableQuotedPermalinkUrl, mentionsDisplayOnly,
    ]);
  return (
    <MarkdownContent
      source={content}
      density="compact"
      enableMermaid
      remarkPlugins={remarkPlugins}
      rehypePlugins={MESSAGE_MARKDOWN_REHYPE_PLUGINS}
      components={markdownComponents}
    />
  );
}

function isPreviewableHtmlAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  const mimeType = att.mimeType.split(";")[0]?.trim().toLowerCase();
  return mimeType === "text/html" || /\.html?$/i.test(att.filename);
}

function isPreviewableDocumentAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isDocumentPreviewAttachment(att);
}

function isPreviewableVideoAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isVideoPreviewAttachment(att);
}

function isPreviewableAudioAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isAudioPreviewAttachment(att);
}

interface DocumentAttachmentPreviewState {
  preview: DocumentAttachmentPreview;
  truncated: boolean;
}

const EMPTY_IMAGE_INLINE_FALLBACK_URLS: Record<string, string> = {};

function ImageInlineFallbackLoader({
  fallbackKey,
  children,
}: {
  fallbackKey: string;
  children: (fallbackUrls: Record<string, string>) => ReactNode;
}) {
  // The parent seam must keep empty keys off this state/effect-bearing path.
  // Stryker disable next-line all: this invariant is the oracle for mutations of that parent seam.
  if (!fallbackKey) throw new Error("ImageInlineFallbackLoader requires a non-empty fallback key");
  const [fallbackUrls, setFallbackUrls] = useState<Record<string, string>>({});

  // Stryker disable all: this fetch lifecycle moved unchanged from MessageItem;
  // its URL/error semantics remain covered by the existing fallback contracts.
  // CDN thumbnails are the preferred inline source. When a normal image lacks
  // one (for example, CDN previews disabled/unavailable), use the authenticated
  // attachment URL so image messages still render inline instead of degrading
  // permanently to a file chip.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    const attachmentIds = splitImageInlineFallbackKey(fallbackKey);
    let cancelled = false;
    const controller = new AbortController();
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackUrls((current) => retainImageInlineFallbackUrls(current, attachmentIds));

    // One request for the whole gallery instead of one per image.
    void fetchInlineAttachmentUrls(attachmentIds)
      .then((urls) => {
        if (cancelled) return;
        for (const attachmentId of attachmentIds) {
          const url = urls.get(attachmentId);
          setFallbackUrls((current) => url
            ? setImageInlineFallbackUrl(current, attachmentId, url)
            : removeImageInlineFallbackUrl(current, attachmentId));
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fallbackKey]);
  // Stryker restore all

  return children(fallbackUrls);
}

function renderWithImageInlineFallback(
  fallbackKey: string,
  children: (fallbackUrls: Record<string, string>) => ReactNode,
) {
  if (!fallbackKey) return children(EMPTY_IMAGE_INLINE_FALLBACK_URLS);
  return <ImageInlineFallbackLoader fallbackKey={fallbackKey}>{children}</ImageInlineFallbackLoader>;
}

function DiffPatchStatsLine({ preview }: { preview: DiffAttachmentPreview | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="text-foreground-hint">{formatMessage({ id: "message.messageItem.diffPreview" })}</span>;
  }

  const { files, hunks, additions, deletions } = preview.stats;

  return (
    <MessageAttachmentDiffSummary className="inline-flex min-w-0 items-center">
      <span className="text-foreground-hint">{formatMessage({ id: "message.messageItem.diffStats" }, { fileCount: files, hunkCount: hunks })}</span>
      <MessageAttachmentDiffAddition>+{additions}</MessageAttachmentDiffAddition>
      <MessageAttachmentDiffDeletion>-{deletions}</MessageAttachmentDiffDeletion>
    </MessageAttachmentDiffSummary>
  );
}

function DocumentPreviewSummaryLine({ preview }: { preview: DocumentAttachmentPreviewState | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.documentPreview" })}</span>;
  }

  if (preview.preview.kind === "csv") {
    const id = preview.truncated
      ? "message.messageItem.documentSummaryFirst"
      : "message.messageItem.documentSummaryPreview";
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id }, { rowCount: preview.preview.rows.length, columnCount: preview.preview.columnCount })}</span>;
  }
  if (preview.preview.kind === "markdown") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.markdownDocument" })}</span>;
  }
  if (preview.preview.kind === "text") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.plainTextDocument" })}</span>;
  }
  if (preview.preview.kind === "xlsx") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.xlsxDocument" })}</span>;
  }
  return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.pdfDocument" })}</span>;
}

// Locale-aware document-preview label for attachment card metadata. The modal
// header intentionally shows only the filename and actions.

/** Popover click shield — module scope so it is never recreated (task #709). */
const stopClickPropagation = (event: React.MouseEvent) => {
  event.stopPropagation();
};

function AttachmentCard({
  attachment,
  isOptimistic,
  isHtml,
  isImage,
  isVideo,
  isAudio,
  isHtmlLoading,
  onClick,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  isHtml: boolean;
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  isHtmlLoading: boolean;
  onClick: (attachment: NonNullable<Message["attachments"]>[number]) => void;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onClick(attachment), [onClick, attachment]);
  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);

  const audioSecondaryDownload = useMemo(() => isAudio
    ? { onClick: handleDownload, label: formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }), affordanceName: "audio-download" }
    : undefined, [isAudio, handleDownload, formatMessage, attachment.filename]);
  const [diffPreview, setDiffPreview] = useState<DiffAttachmentPreview | null>(null);
  const [documentPreview, setDocumentPreview] = useState<DocumentAttachmentPreviewState | null>(null);
  const isDiffPatch = isDiffPatchAttachment(attachment);
  const isDocumentPreview = isPreviewableDocumentAttachment(attachment);

  // Async-loader: reset previews + fetch new ones when `attachment.id` or
  // preview-type flags change. Same FP family as Cluster 2's
  // ChannelFilesPanel / QuotedMessagePermalinkPreview async-loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    if ((!isDiffPatch && !isDocumentPreview) || isOptimistic) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDiffPreview(null);
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDocumentPreview(null);
      return;
    }
    void fetchAttachmentPreviewSummary(attachment.id)
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status === "ok" && data.data.kind === "diff") {
          setDiffPreview(data.data);
          setDocumentPreview(null);
          return;
        }
        if (data.status === "ok" && (data.data.kind === "csv" || data.data.kind === "xlsx" || data.data.kind === "markdown" || data.data.kind === "pdf" || data.data.kind === "text")) {
          setDocumentPreview({ preview: data.data, truncated: data.truncated === true });
          setDiffPreview(null);
          return;
        }
        setDiffPreview(null);
        setDocumentPreview(null);
      })
      .catch(() => {
        if (!cancelled) {
          setDiffPreview(null);
          setDocumentPreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, isDiffPatch, isDocumentPreview, isOptimistic]);

  if (isDiffPatch) {
    return (
      <AttachmentChip
        attachment={attachment}
        isOptimistic={isOptimistic}
        onClick={handleDownload}
        affordance="download"
        meta={<AttachmentMetaText label={attachment.mimeType || formatMessage({ id: "message.messageItem.metaPatch" })} sizeBytes={attachment.sizeBytes} />}
        summary={<DiffPatchStatsLine preview={diffPreview} />}
      />
    );
  }

  if (isDocumentPreview) {
    return (
      <AttachmentChip
        attachment={attachment}
        isOptimistic={isOptimistic}
        loading={isHtmlLoading}
        loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
        onClick={handleClick}
        affordance="preview"
        affordanceName="document-preview"
        meta={<AttachmentMetaText label={documentPreview ? formatMessage({ id: DOCUMENT_PREVIEW_LABEL_ID[documentPreview.preview.kind] }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaDocument" })} sizeBytes={attachment.sizeBytes} />}
        summary={<DocumentPreviewSummaryLine preview={documentPreview} />}
      />
    );
  }

  // Stryker disable next-line ConditionalExpression,LogicalOperator: shared card branch matrix predates audio; this PR's audio branch is covered by audioAttachmentPreview.behavior.test.tsx.
  const primaryIsPreview = isImage || isHtml || isVideo || isAudio;
  // Stryker disable next-line ConditionalExpression: audio/non-preview click behavior is covered by audioAttachmentPreview.behavior.test.tsx; legacy image/html/video branches are covered elsewhere.
  const primaryOnClick = primaryIsPreview ? handleClick : handleDownload;
  // Stryker disable next-line ConditionalExpression,StringLiteral: visual affordance labels for legacy branches are source-pinned; audio/file behavior is covered by DOM tests.
  const primaryAffordance = primaryIsPreview ? "preview" : "download";
  // Stryker disable next-line ConditionalExpression,StringLiteral: data-affordance names are source/query contracts; audio/file names are additionally covered by DOM tests.
  const primaryAffordanceName = isHtml ? "html-preview" : isImage ? "image-preview" : isVideo ? "video-preview" : isAudio ? "audio-preview" : "file-download";
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: meta copy for legacy preview types is source-pinned; audio/file copy is covered by DOM tests.
  const primaryMetaLabel = isHtml ? formatMessage({ id: "message.messageItem.htmlPreview" }) : isVideo ? formatMessage({ id: "message.messageItem.videoPreview" }) : isAudio ? formatMessage({ id: "message.messageItem.audioPreview" }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaFile" });

  return (
    <AttachmentChip
      attachment={attachment}
      isOptimistic={isOptimistic}
      loading={isHtmlLoading}
      loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
      onClick={primaryOnClick}
      affordance={primaryAffordance}
      affordanceName={primaryAffordanceName}
      meta={<AttachmentMetaText label={primaryMetaLabel} sizeBytes={attachment.sizeBytes} />}
      secondaryDownload={audioSecondaryDownload}
    />
  );
}

function InlineVideoAttachmentCard({
  attachment,
  isOptimistic,
  onOpenPreview,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  onOpenPreview: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const media = useRefreshingMediaUrl({
    attachmentId: attachment.id,
    localPreviewUrl: attachment.localPreviewUrl,
    disabled: isOptimistic,
    mediaKind: "video",
  });
  const { url: inlineUrl, loading: loadingUrl, failure, load: loadInlineVideoUrl, abort: abortInlineVideoUrl } = media;

  const handleOpenPreview = useCallback(() => {
    if (!isOptimistic) void onOpenPreview(attachment);
  }, [onOpenPreview, attachment, isOptimistic]);
  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineVideoUrl();
      return abortInlineVideoUrl;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          loadInlineVideoUrl();
        } else {
          videoRef.current?.pause();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      abortInlineVideoUrl();
    };
  }, [attachment.id, isOptimistic, loadInlineVideoUrl, abortInlineVideoUrl]);

  const downloadAction = (
    <MessageVideoPreviewFailureAction
      onClick={handleDownload}
      aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
    >
      <Download size={13} />
      {formatMessage({ id: "message.messageItem.downloadToView" })}
    </MessageVideoPreviewFailureAction>
  );

  return (
    <Tooltip content={attachment.filename}>
    <MessageVideoPreview
      ref={containerRef}
      data-message-affordance="inline-video-preview"
    >
      {inlineUrl && !failure ? (
        <MessageVideoPreviewMedia
          render={<video
            ref={videoRef}
            title={formatMessage({ id: "message.messageItem.videoAttachmentTitle" }, { filename: attachment.filename })}
            src={inlineUrl}
            controls
            playsInline
            preload="metadata"
            {...media.mediaEvents}
          />}
        />
      ) : (
        <MessageVideoPreviewFallback>
          {isOptimistic || loadingUrl ? (
            <Spinner size="md" variant="inverse" aria-label={formatMessage({ id: "common.loadingLabel" })} />
          ) : failure === "unsupported" ? (
            <MessageVideoPreviewFailureContent>
              <MessageVideoPreviewFailureIcon>
                <AlertTriangle size={24} />
              </MessageVideoPreviewFailureIcon>
              <MessageVideoPreviewFailureTitle>{formatMessage({ id: "message.messageItem.codecWarning" })}</MessageVideoPreviewFailureTitle>
              {downloadAction}
            </MessageVideoPreviewFailureContent>
          ) : failure === "unavailable" ? (
            <MessageVideoPreviewFailureContent>
              <MessageVideoPreviewFailureIcon>
                <AlertTriangle size={24} />
              </MessageVideoPreviewFailureIcon>
              <MessageVideoPreviewFailureTitle>{formatMessage({ id: "message.messageItem.videoLoadFailed" })}</MessageVideoPreviewFailureTitle>
              <div className="flex items-center gap-3">
                <MessageVideoPreviewFailureAction
                  onClick={media.retry}
                  aria-label={formatMessage({ id: "message.messageItem.retryVideoPreview" }, { filename: attachment.filename })}
                >
                  <RotateCcw size={13} />
                  {formatMessage({ id: "message.messageItem.videoRetry" })}
                </MessageVideoPreviewFailureAction>
                {downloadAction}
              </div>
            </MessageVideoPreviewFailureContent>
          ) : (
            <Play size={32} />
          )}
        </MessageVideoPreviewFallback>
      )}
      {!isOptimistic && (
        <Tooltip content={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}>
        <MessageVideoPreviewAction
          onClick={handleOpenPreview}
          aria-label={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}
          data-message-affordance="inline-video-expand"
        >
          <Eye size={12} />
        </MessageVideoPreviewAction>
        </Tooltip>
      )}
    </MessageVideoPreview>
    </Tooltip>
  );
}

function formatAudioTimestamp(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function InlineAudioPlayer({
  filename,
  url,
  mediaEvents,
}: {
  filename: string;
  url: string;
  mediaEvents: ReturnType<typeof useRefreshingMediaUrl>["mediaEvents"];
}) {
  const { formatMessage } = useIntl();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const durationKnown = duration > 0;
  const boundedCurrentTime = durationKnown ? Math.min(currentTime, duration) : currentTime;
  const progress = durationKnown ? Math.max(0, Math.min(100, (boundedCurrentTime / duration) * 100)) : 0;
  const volumeProgress = Math.round(volume * 100);
  const currentTimeLabel = formatAudioTimestamp(boundedCurrentTime);
  const durationLabel = formatAudioTimestamp(duration);
  const timeLabel = `${currentTimeLabel} / ${durationLabel}`;

  const syncMediaState = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime || 0);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    setPlaying(!audio.paused && !audio.ended);
  }, []);

  const handleTogglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    try {
      const playResult = audio.play();
      void playResult.catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  }, [playing]);

  const handleSeek = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.currentTarget.value);
    if (!Number.isFinite(nextTime)) return;
    const audio = audioRef.current;
    const boundedTime = durationKnown ? Math.max(0, Math.min(duration, nextTime)) : 0;
    if (audio) audio.currentTime = boundedTime;
    setCurrentTime(boundedTime);
  }, [duration, durationKnown]);

  const handleVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.currentTarget.value);
    if (!Number.isFinite(nextVolume)) return;
    const boundedVolume = Math.max(0, Math.min(1, nextVolume));
    const audio = audioRef.current;
    if (audio) audio.volume = boundedVolume;
    setVolume(boundedVolume);
  }, []);

  return (
    <div data-message-affordance="inline-audio-player" className="w-full rounded-control bg-fill-muted p-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-message-affordance="audio-play-toggle"
          aria-label={formatMessage({ id: playing ? "message.messageItem.pauseAudio" : "message.messageItem.playAudio" }, { filename })}
          className="flex size-8 shrink-0 items-center justify-center rounded-control border-[1.5px] border-line-strong bg-layer-card text-foreground outline-none hover:press-overlay active:press-overlay focus-visible:shadow-focus"
          onClick={handleTogglePlayback}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <div className="relative h-8 min-w-0 flex-1">
          <input
            type="range"
            data-message-affordance="audio-seek"
            aria-label={formatMessage({ id: "message.messageItem.seekAudio" }, { filename })}
            aria-valuetext={timeLabel}
            min={0}
            max={durationKnown ? duration : 1}
            step={0.1}
            value={durationKnown ? boundedCurrentTime : 0}
            disabled={!durationKnown}
            className="peer absolute inset-0 z-10 h-8 w-full opacity-0"
            onChange={handleSeek}
          />
          <div
            data-message-affordance="audio-seek-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-[4px] border border-line-hairline bg-layer-card peer-focus-visible:shadow-focus"
            aria-hidden="true"
          >
            <div className="h-full bg-info" style={{ width: `${progress}%` }} />
          </div>
          <span
            data-message-affordance="audio-seek-thumb"
            className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-[1.5px] border-line-strong bg-layer-card peer-focus-visible:shadow-focus"
            style={{ left: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
        <div data-message-affordance="audio-time" className="w-[4.75rem] shrink-0 text-right font-mono text-mono-meta tabular-nums text-foreground-hint">
          {timeLabel}
        </div>
      </div>
      <div data-message-affordance="audio-volume-control" className="mt-1.5 flex items-center gap-2 pl-10">
        <Volume2 size={16} className="shrink-0 text-foreground-muted" aria-hidden="true" />
        <div className="relative h-6 min-w-0 flex-1">
          <input
            type="range"
            data-message-affordance="audio-volume"
            aria-label={formatMessage({ id: "message.messageItem.audioVolume" }, { filename })}
            aria-valuetext={`${volumeProgress}%`}
            min={0}
            max={1}
            step={0.05}
            value={volume}
            className="peer absolute inset-0 z-10 h-6 w-full opacity-0"
            onChange={handleVolumeChange}
          />
          <div
            data-message-affordance="audio-volume-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-[3px] border border-line-hairline bg-layer-card peer-focus-visible:shadow-focus"
            aria-hidden="true"
          >
            <div className="h-full bg-foreground-muted" style={{ width: `${volumeProgress}%` }} />
          </div>
          <span
            data-message-affordance="audio-volume-thumb"
            className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-[1.5px] border-line-strong bg-layer-card peer-focus-visible:shadow-focus"
            style={{ left: `${volumeProgress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
      <audio
        ref={audioRef}
        title={formatMessage({ id: "message.messageItem.audioPreviewTitle" }, { filename })}
        src={url}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(event) => {
          syncMediaState();
          mediaEvents.onLoadedMetadata(event);
        }}
        onDurationChange={syncMediaState}
        onTimeUpdate={syncMediaState}
        onPlay={() => {
          setPlaying(true);
          mediaEvents.onPlay();
        }}
        onPause={() => {
          setPlaying(false);
          mediaEvents.onPause();
        }}
        onEnded={() => setPlaying(false)}
        onError={mediaEvents.onError}
      />
    </div>
  );
}

function InlineAudioAttachmentCard({
  attachment,
  isOptimistic,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const media = useRefreshingMediaUrl({
    attachmentId: attachment.id,
    localPreviewUrl: attachment.localPreviewUrl,
    disabled: isOptimistic,
    mediaKind: "audio",
  });
  const { url: inlineUrl, loading: loadingUrl, load: loadInlineAudioUrl, abort: abortInlineAudioUrl } = media;
  const loadFailed = media.failure !== null;

  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineAudioUrl();
      return abortInlineAudioUrl;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          loadInlineAudioUrl();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      abortInlineAudioUrl();
    };
  }, [attachment.id, isOptimistic, loadInlineAudioUrl, abortInlineAudioUrl]);

  const downloadButton = (
    <Tooltip content={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}>
    <button
      type="button"
      data-message-affordance="audio-download"
      aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
      className="flex size-8 items-center justify-center rounded-control text-foreground outline-none hover:bg-fill-pressed active:bg-fill-pressed focus-visible:shadow-focus"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        handleDownload();
      }}
    >
      <Download size={18} />
    </button>
    </Tooltip>
  );

  return (
    <div
      ref={containerRef}
      data-message-affordance="inline-audio-preview"
      className="w-full max-w-xl"
    >
      {inlineUrl && !loadFailed ? (
        <Card className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-chip bg-fill-muted text-foreground-muted">
                <Music size={18} className="text-current" />
              </div>
              <div className="min-w-0">
                <Tooltip content={attachment.filename}><div className="truncate text-callout font-semibold text-foreground">{attachment.filename}</div></Tooltip>
                <div className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {downloadButton}
          </div>
          <InlineAudioPlayer
            key={inlineUrl}
            filename={attachment.filename}
            url={inlineUrl}
            mediaEvents={media.mediaEvents}
          />
        </Card>
      ) : (
        <Card className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-chip bg-fill-muted text-foreground-muted">
                <Music size={18} className="text-current" />
              </div>
              <div className="min-w-0">
                <Tooltip content={attachment.filename}><div className="truncate text-callout font-semibold text-foreground">{attachment.filename}</div></Tooltip>
                <div className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {!isOptimistic && !loadFailed ? downloadButton : null}
          </div>
          <button
            type="button"
            className={`flex h-10 w-full items-center justify-center rounded-control bg-fill-muted text-footnote font-semibold text-foreground-muted outline-none focus-visible:shadow-focus ${loadFailed ? "hover:press-overlay active:press-overlay" : "cursor-default"}`}
            onClick={loadFailed ? handleDownload : undefined}
            aria-label={loadFailed ? formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }) : formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
          >
            {isOptimistic || loadingUrl ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />
                {formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
              </span>
            ) : loadFailed ? (
              <span className="inline-flex items-center gap-1.5">
                <Download size={16} />
                {formatMessage({ id: "message.messageItem.downloadToView" })}
              </span>
            ) : (
              <span>{formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}</span>
            )}
          </button>
        </Card>
      )}
    </div>
  );
}

// Lets renderer-specific layers inside the preview (e.g. the HTML comment
// overlay) see the shell's comment mode and push captured anchors into the
// composer without the generic shell knowing any renderer internals.

// Per-attachment host-message context handed to the image lightbox so its
// comments panel can resolve the review conversation (F10, task #10).
// DORMANT: image comments are descoped (cindyz 6/11) — no caller passes
// this until image region anchors get their own design. The lightbox side
// stays wired and renders no affordance without contexts.
// oxlint-disable-next-line no-unused-vars
function buildLightboxCommentContexts(
  images: MessageAttachment[],
  message: Message,
): Record<string, LightboxCommentContext> {
  const contexts: Record<string, LightboxCommentContext> = {};
  for (const img of images) {
    contexts[img.id] = {
      parentMessage: {
        id: message.id,
        channelId: message.channelId,
        senderId: message.senderId,
        senderType: message.senderType,
      },
    };
  }
  return contexts;
}

export interface ReadOnlySenderProjection {
  displayName: string;
  /** Stable public @handle. Absent while web and server versions roll. */
  handle?: string | null;
  avatarUrl: string | null;
  description: string | null;
}

interface MessageItemProps {
  message: Message;
  mentionMap: Map<string, MentionEntry>;
  channels: Channel[];
  previewSenderAgent?: Agent;
  previewSenderMember?: ServerMember;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>;
  threadSummary?: ThreadSummary;
  parentChannelId?: string;
  parentMessageId?: string;
  hideThreadActions?: boolean;
  showThreadFollowAction?: boolean;
  linkedTask?: Task;
  senderAvatarTestId?: string;
  mentionComposerChannelId?: string;
  /**
   * The local collection that owns this rendered message. Thread responses do
   * not carry conversationContext on every HTTP/update shape, so callers that
   * know the collection must pass it instead of reconstructing scope from the
   * message payload.
   */
  reactionParentScopeKey?: SyncScopeKey;
  /** Mutation authority for this rendered channel/thread. Readable messages
   * may still be non-interactive when the viewer is not a member. */
  canReact?: boolean;
  /** Render the canonical message row for a narrow, anonymous/read-only DTO. */
  readOnlyProjection?: boolean;
  /** Extra classes for the row root — per-theme alignment offsets (e.g. the
   *  avatar/header-icon-column correction) live at the callsite. */
  className?: string;
  /** Display-only identity from a narrow public DTO. It never grants profile
   * navigation, mention authority, or access to a member/agent store row. */
  readOnlySender?: ReadOnlySenderProjection;
  /** Read-only projection: the inline reply preview, supplied by the host page
   *  because a read-only page has no thread store to read it from. */
  readOnlyReplyScope?: ThreadRepliesScope;
  onReadOnlyNavigateChannel?: (channel: Channel) => void;
  onBeforeOpenThread?: () => void;
  onOpenThread?: (request: OpenThreadRequest) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  threadSearchHighlightQuery?: string;
  threadSearchActive?: boolean;
  /**
   * Consecutive-same-sender grouping state (task #44). When a message continues
   * the previous sender's group, avatar + name are hidden and the timestamp
   * moves to a hover gutter. Optional — surfaces that don't compute grouping
   * (thread / DM panels) omit it and keep the full header.
   */
  groupState?: MessageGroupState;
  /**
   * Rhythm marker (messageGrouping.followedByFor): the kind of row that
   * follows this one. The root carries it as `data-followed-by` and the recipe
   * collapses this row's bottom padding so group interiors read 16 apart while
   * group breaks stay 24.
   */
  followedBy?: "compact" | "group";
  /** Rhythm marker (messageGrouping.followsSystemFor): this row directly
   * follows a system note, whose 12/12 rhythm the row completes. */
  followsSystem?: boolean;
  /**
   * #693 DM read status (artin, option C): set by ChatPanel on the LAST message
   * of a DM at the live edge. The status line renders below this message only
   * when it is also the viewer's own message and the peer has read it.
   */
  showDmReadStatus?: boolean;
}

// Isolated subscriber — only re-renders when this agent's activity changes.
function AgentStatusDot({
  agentId,
  fallbackAgent,
  className,
  ...rest
}: {
  agentId: string;
  fallbackAgent?: Pick<Agent, "status"> | null;
} & Omit<StatusDotProps, "activity" | "external" | "tone">) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId, fallbackAgent);
  const activityText = formatAgentDisplayStateText(intl, displayState);
  return (
    <StatusDot
      activity={displayState.activity}
      external={displayState.isExternal && !displayState.isOnline}
      title={activityText}
      className={className}
      {...rest}
    />
  );
}

// Isolates hover-card state so opening the card doesn't re-render the whole MessageItem.
// Stryker disable all: sender preview-card composition is covered by the existing sender-resolution contracts plus manual visual validation; this migration batch is not adding new hover DOM tests.
function MessageSenderAvatar({
  showAgent,
  showExternal,
  isDeactivatedAgent,
  senderId,
  agentAvatarUrl,
  avatarUrl,
  gravatarHash,
  email,
  hoverAgent,
  hoverMember,
  readOnlySender,
  externalAvatarUrl,
  externalDisplayName,
  externalProvider,
  externalWorkspaceName,
  externalActorKind,
  testId,
  onNavigateAgent,
  onNavigateAgentActivity,
  onNavigateHuman,
  onNavigateExternal,
  onContextMenu,
  onLongPressMention,
}: {
  showAgent: boolean;
  showExternal: boolean;
  isDeactivatedAgent: boolean;
  senderId: string;
  agentAvatarUrl: string | null;
  avatarUrl: string | null;
  gravatarHash: string | undefined;
  email?: string | null;
  hoverAgent?: Agent | null;
  hoverMember?: ServerMember | null;
  readOnlySender?: ReadOnlySenderProjection;
  externalAvatarUrl?: string | null;
  externalDisplayName: string;
  externalProvider?: string | null;
  externalWorkspaceName?: string | null;
  externalActorKind?: ExternalActorKind | null;
  testId?: string;
  onNavigateAgent: (id: string) => void;
  onNavigateAgentActivity: (id: string) => void;
  onNavigateHuman: (id: string) => void;
  onNavigateExternal: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onLongPressMention?: () => void;
}) {
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const longPressStartedAtRef = useRef<number | null>(null);
  const longPressStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const longPressArmedRef = useRef(false);
  const longPressFiredRef = useRef(false);
  const [avatarPressed, setAvatarPressed] = useState(false);
  const mentionType = showAgent ? "agent" : "user";
  const onClickAgent = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    previewActionsRef.current?.close();
    onNavigateAgent(senderId);
  };
  // Same close-before-navigate rule as onClickAgent above: the hover card must
  // be dismissed before we move, or it stays floating over the destination.
  const onOpenAgentActivity = useCallback((agentId: string) => {
    previewActionsRef.current?.close();
    onNavigateAgentActivity(agentId);
  }, [onNavigateAgentActivity]);
  const onClickHuman = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    previewActionsRef.current?.close();
    onNavigateHuman(senderId);
  };
  const handleAvatarTouchStart = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(true);
    if (!onLongPressMention) return;
    event.stopPropagation();
    const touch = event.touches[0];
    longPressStartPointRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    longPressStartedAtRef.current = event.timeStamp;
    longPressArmedRef.current = true;
    longPressFiredRef.current = false;
  }, [onLongPressMention]);
  const handleAvatarPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      onLongPressMention
      && event.pointerType === "touch"
      && document.activeElement?.tagName === "TEXTAREA"
    ) {
      // PointerDown is cancelable on mobile browsers; TouchStart listeners may
      // be passive. Prevent the avatar button from stealing composer focus so
      // an already-open keyboard remains open through the long press.
      event.preventDefault();
    }
  }, [onLongPressMention]);
  const handleAvatarTouchMove = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    if (!longPressArmedRef.current) return;
    event.stopPropagation();
    const start = longPressStartPointRef.current;
    const touch = event.touches[0];
    if (start && touch) {
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (deltaX * deltaX + deltaY * deltaY <= SENDER_AVATAR_LONG_PRESS_MOVE_TOLERANCE_PX ** 2) {
        return;
      }
    }
    setAvatarPressed(false);
    longPressArmedRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
  }, []);
  const handleAvatarTouchEnd = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(false);
    if (!longPressArmedRef.current) return;
    event.stopPropagation();
    const startedAt = longPressStartedAtRef.current;
    longPressArmedRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
    longPressFiredRef.current = startedAt !== null && event.timeStamp - startedAt >= SENDER_AVATAR_LONG_PRESS_MS;
    if (!longPressFiredRef.current || !onLongPressMention) return;
    event.preventDefault();
    previewActionsRef.current?.close();
    onLongPressMention();
  }, [onLongPressMention]);
  const handleAvatarTouchCancel = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(false);
    event.stopPropagation();
    longPressArmedRef.current = false;
    longPressFiredRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
  }, []);
  const handleAvatarContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (longPressArmedRef.current || longPressFiredRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onContextMenu?.(event);
  }, [onContextMenu]);
  const humanAvatarSource = isRaftUploadedHumanAvatarUrl(avatarUrl)
    ? "uploaded"
    : gravatarHash
      ? "gravatar-hash"
      : email
        ? "email-fallback"
        : "placeholder";
  if (showExternal) {
    return (
      <ExternalIdentityPreviewCard
        displayName={externalDisplayName}
        provider={externalProvider}
        workspaceName={externalWorkspaceName}
        actorKind={externalActorKind}
        avatarUrl={externalAvatarUrl}
        testId={testId}
        onNavigate={onNavigateExternal}
      />
    );
  }
  // Unified wrapper structure for both agent + human paths so the avatar
  // top sits at the same vertical offset regardless of sender kind. Was:
  // agent had an extra wrapping <div relative> (for AgentStatusDot's
  // absolute positioning) which inherited inline-block baseline alignment
  // and pushed the inner button down by ~11px. human had only the bare
  // button. Net effect: agent avatar drifted noticeably below human
  // avatar across an otherwise identical message row. (#wg-theme:7470ca2a
  // stdrc 2026-05-11.)
  //
  // Now both kinds render `<button>` as the avatar wrapper. Agent activity is
  // composed inside raft-ui AvatarBadge, so there is still no extra wrapper or
  // inline-block baseline drift.
  //
  // `mt-1` (was `mt-0.5`) pushes the avatar's top border down to the
  // visible cap-top of the sender-name first line, not the bare line-box
  // top. With text-sm + leading-5, the rendered cap-top of the first line
  // is roughly 4–5px below the line-box top, so a 4px `mt` keeps the
  // avatar's outer border visually flush with the first line of text
  // rather than floating above it. Per stdrc: "头像的上面要留一些空间，
  // 使得头像的顶部边框与其右边第一行内容的顶部保持对齐."
  if (showAgent) {
    return (
      <PreviewCard actionsRef={previewActionsRef}>
        <PreviewCardTrigger
          delay={200}
          closeDelay={120}
          render={
            <button
              type="button"
              onClick={onClickAgent}
              onContextMenu={handleAvatarContextMenu}
              onPointerDown={handleAvatarPointerDown}
              onTouchStart={handleAvatarTouchStart}
              onTouchMove={handleAvatarTouchMove}
              onTouchEnd={handleAvatarTouchEnd}
              onTouchCancel={handleAvatarTouchCancel}
              data-testid={testId}
              data-avatar-kind="agent"
              data-avatar-source={agentAvatarUrl ? "agent-avatar" : "placeholder"}
              data-avatar-pressed={avatarPressed ? "true" : "false"}
              className={`relative mt-0.5 shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
            >
              <AvatarSlot
                context="message-row"
                type="agent"
                agentAvatarUrl={agentAvatarUrl}
                badge={!isDeactivatedAgent ? (
                  <AgentStatusDot agentId={senderId} fallbackAgent={hoverAgent} />
                ) : undefined}
                className={isDeactivatedAgent ? "grayscale opacity-60" : ""}
              />
            </button>
          }
        />
        <PreviewCardContent sideOffset={6} collisionPadding={6}>
          <ProfilePreviewCardContent
            mentionType={mentionType}
            mentionId={senderId}
            fallbackAgent={hoverAgent}
            readOnlyProfile={readOnlySender}
            onOpenAgentActivity={onOpenAgentActivity}
          />
        </PreviewCardContent>
      </PreviewCard>
    );
  }
  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
          onClick={onClickHuman}
          onContextMenu={handleAvatarContextMenu}
          onPointerDown={handleAvatarPointerDown}
            onTouchStart={handleAvatarTouchStart}
            onTouchMove={handleAvatarTouchMove}
            onTouchEnd={handleAvatarTouchEnd}
            onTouchCancel={handleAvatarTouchCancel}
            data-testid={testId}
            data-avatar-kind="human"
            data-avatar-source={humanAvatarSource}
            data-avatar-pressed={avatarPressed ? "true" : "false"}
            data-avatar-has-uploaded={isRaftUploadedHumanAvatarUrl(avatarUrl) ? "true" : "false"}
            data-avatar-has-gravatar-hash={gravatarHash ? "true" : "false"}
            data-avatar-has-email-fallback={email ? "true" : "false"}
            className={`mt-0.5 shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
          >
            <AvatarSlot
              context="message-row"
              type="human"
              humanAvatarUrl={avatarUrl}
              gravatarHash={gravatarHash}
              email={email}
            />
          </button>
        }
      />
      <PreviewCardContent sideOffset={6} collisionPadding={6}>
        <ProfilePreviewCardContent mentionType={mentionType} mentionId={senderId} fallbackMember={hoverMember} readOnlyProfile={readOnlySender} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

// Returns a stable semantic `action` so the click handler never depends on the
// (now localized) label text — comparing a localized label to "Retry" would
// misroute the action under zh.
function translationIndicatorText(
  entry: TranslationEntry,
  showOriginal: boolean,
  formatMessage: IntlShape["formatMessage"],
) {
  if (hasUsableTranslatedContent(entry)) {
    return showOriginal
      ? { label: formatMessage({ id: "message.messageItem.showTranslation" }), message: "", title: formatMessage({ id: "message.messageItem.showTranslationTitle" }), tone: "normal" as const, action: "toggle" as const }
      : { label: formatMessage({ id: "message.messageItem.showOriginal" }), message: "", title: formatMessage({ id: "message.messageItem.showOriginalTitle" }), tone: "normal" as const, action: "toggle" as const };
  }
  if (entry.status === "pending") {
    return { label: "", message: formatMessage({ id: "message.messageItem.translating" }), title: formatMessage({ id: "message.messageItem.translatingTitle" }), tone: "pending" as const, action: "toggle" as const };
  }
  return { label: formatMessage({ id: "message.messageItem.translationRetry" }), message: formatMessage({ id: "message.messageItem.translationUnavailable" }), title: formatMessage({ id: "message.messageItem.translationUnavailable" }), tone: "failed" as const, action: "retry" as const };
}

function hasUsableTranslatedContent(entry: TranslationEntry | undefined) {
  return entry?.status === "translated"
    && typeof entry.translatedContent === "string"
    && entry.translatedContent.trim().length > 0;
}

function shouldRenderTranslationIndicator(entry: TranslationEntry) {
  return hasUsableTranslatedContent(entry)
    || entry.status === "pending"
    || entry.status === "failed";
}

function TranslationIndicator({
  entry,
  onToggleOriginal,
  onRetry,
  onUpgrade,
  showOriginal,
}: {
  entry: TranslationEntry;
  onToggleOriginal: () => void;
  onRetry: () => void;
  onUpgrade: () => void;
  showOriginal: boolean;
}) {
  const { formatMessage } = useIntl();
  if (!shouldRenderTranslationIndicator(entry)) return null;
  const text = translationIndicatorText(entry, showOriginal, formatMessage);
  const Icon = text.tone === "failed" ? AlertTriangle : Languages;
  // onUpgrade retained for API compatibility; no translation entry currently
  // maps to an upgrade action (the former "Upgrade" label branch was dead).
  void onUpgrade;
  const handleAction = text.action === "retry" ? onRetry : onToggleOriginal;
  const ActionComponent = text.action === "retry" ? MessageItemTranslationRetryAction : MessageItemTranslationAction;
  const action = text.label
    ? (
      <Tooltip content={text.title}>
      <ActionComponent
        onClick={handleAction}
        aria-label={text.label || text.title}
      >
        {text.label}
      </ActionComponent>
      </Tooltip>
    )
    : null;

  const StatusWrapper = text.tone === "failed" ? MessageItemTranslationFailedStatus : MessageItemTranslationStatus;
  const indicator = (
    <StatusWrapper
      data-testid={`message-translation-indicator-${entry.messageId}`}
    >
      <Icon size={12} className={text.tone === "pending" ? "animate-pulse" : ""} />
      {text.message && <span>{text.message}</span>}
      {text.message && action && <span aria-hidden>·</span>}
      {action}
    </StatusWrapper>
  );

  return action ? indicator : <Tooltip content={text.title}>{indicator}</Tooltip>;
}

interface MessageMarkdownBodyProps {
  content: string;
  channels: Channel[];
  mentionMap: Map<string, MentionEntry>;
  structuredMentionMap: Map<string, MentionEntry>;
  onNavigateChannel: (channel: Channel) => void;
  onNavigateDm: (channel: Channel) => void;
  onNavigateAgent: (agentId: string) => void;
  onNavigateHuman: (userId: string) => void;
  /** Click handler for `type:"external"` mentions — opens the
   *  external-identity panel via `openExternalProfile`. */
  onNavigateExternal: (profile: ExternalMessageAuthorProjection) => void;
  onNavigateComputer: (machineId: string) => void;
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>;
  resolvingThreadRefKey?: string | null;
  onOpenTask?: (taskNumber: number) => void;
  onOpenMessage?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>;
  onOpenPermalink?: (href: string) => void;
  serverSlug?: string;
  refAuthorityServerSlug?: string;
  threadRefAuthorityUnavailable?: boolean;
  knownTaskNumbers?: Set<number>;
  /** Task payloads for inline task refs (task #662 research prototype: refs
   *  reuse the message-side task badge). Referentially stable via useMemo in
   *  the parent; an unstable map would defeat the memo above. */
  taskByNumber?: ReadonlyMap<number, Task>;
  timeFormatOptions: TimeFormatOptions;
  threadSearchHighlightQuery?: string;
  /** #693 per-@mentioned-agent read badge. Primitives only, so the memo above
   *  still short-circuits — an object prop would defeat it. */
  readReceiptChannelId: string;
  readReceiptMessageSeq: number | undefined;
  readReceiptEnabled: boolean;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>;
  unavailableQuotedPermalinkUrl?: string | null;
  /** Read-only projection: mentions are highlighted text, never profile links
   *  or hover cards (those read member stores and load profiles). */
  mentionsDisplayOnly?: boolean;
}

// Memoized markdown body. `renderContent` runs the full markdown preprocessing
// + react-markdown parse, which the 2026-06-06 prod CPU trace showed to be ~33%
// of main-thread JS in the message list. Wrapping it in a memo'd component lets
// it skip that work whenever the parent MessageItem re-renders WITHOUT a change
// to the actual markdown inputs — provided callers pass referentially-stable
// props (the navigate/open handlers are now useCallback'd and useAppNavigate is
// memoized). #wg-frontend-perf.
const MessageMarkdownBody = memo(function MessageMarkdownBody(props: MessageMarkdownBodyProps) {
  const { formatMessage } = useIntl();
  const readReceiptScope = useMemo<MessageReadReceiptScope>(() => ({
    channelId: props.readReceiptChannelId,
    messageSeq: props.readReceiptMessageSeq,
    enabled: props.readReceiptEnabled,
  }), [props.readReceiptChannelId, props.readReceiptMessageSeq, props.readReceiptEnabled]);
  const body = useRenderMessageMarkdown(
    props.content,
    props.channels,
    props.mentionMap,
    props.structuredMentionMap,
    props.onNavigateChannel,
    props.onNavigateDm,
    props.onNavigateAgent,
    props.onNavigateHuman,
    props.onNavigateExternal,
    props.onNavigateComputer,
    props.onOpenThread,
    props.resolvingThreadRefKey,
    props.onOpenTask,
    props.onOpenMessage,
    props.onOpenPermalink,
    props.serverSlug,
    props.refAuthorityServerSlug,
    props.threadRefAuthorityUnavailable,
    props.knownTaskNumbers,
    props.taskByNumber,
    props.timeFormatOptions,
    props.threadSearchHighlightQuery,
    formatMessage,
    props.channelParticipantAgentsById,
    props.channelParticipantMembersById,
    props.channelParticipantExternalsById,
    props.unavailableQuotedPermalinkUrl,
    props.mentionsDisplayOnly,
  );
  return (
    <MessageReadReceiptScopeProvider value={readReceiptScope}>
      {body}
    </MessageReadReceiptScopeProvider>
  );
});

// Persistent thread-ref notice is keyed (not a formatted string) so it
// re-localizes on a language switch while still displayed.
type ThreadRefNoticeKey =
  | "message.messageItem.threadServerUnknown"
  | "message.messageItem.threadUnavailable"
  | "message.messageItem.sourceUnavailable";

/** `#` is markup, not translatable copy. */
function taskNumberSigil(taskNumber: number): string {
  return `#${taskNumber}`;
}

/** Task-assignee handle inside the footer task badge. One shared JSX node
 *  keeps the file's audited `@` literal count at one —
 *  scripts/i18n-literal-baseline.json audits exactly one. Inline task refs
 *  do NOT render the assignee (task #1252): the badge must not fabricate an
 *  `@` into the sender's sentence. */
function taskAssigneeHandle(claimedByName: string) {
  return <span className="min-w-0 truncate">@{claimedByName}</span>;
}

const ignoreReadOnlyProjectionNavigation = () => undefined;

/** A mention on a read-only projection: the member highlight, no link. */
function renderDisplayOnlyMention(children: ReactNode) {
  return (
    <MessageReferenceText variant="secondary" render={<span data-message-mention="display-only" />}>
      {children}
    </MessageReferenceText>
  );
}

const ConnectedMessageItem = memo(function ConnectedMessageItem({ message, mentionMap, channels, previewSenderAgent, previewSenderMember, channelParticipantAgentsById, channelParticipantMembersById, channelParticipantExternalsById, threadSummary, parentChannelId, parentMessageId, hideThreadActions, showThreadFollowAction, linkedTask, senderAvatarTestId, mentionComposerChannelId, reactionParentScopeKey, canReact = true, readOnlyProjection = false, readOnlySender, readOnlyReplyScope, onReadOnlyNavigateChannel, onBeforeOpenThread, onOpenThread, onOpenProfile, threadSearchHighlightQuery, threadSearchActive, groupState, followedBy, followsSystem, showDmReadStatus = false, className }: MessageItemProps) {
  // Feature flag gate: outside enabled scope, NO comment
  // affordance renders — preview comments context, re: chips, chip counts.
  const commentsEnabled = useAttachmentCommentsEnabled(!readOnlyProjection);
  const isHighlightedInChannel = useMessageStore((s) => s.highlightedMessageId === message.id);
  // A thread reply permalink owns highlight chrome only inside that thread.
  // The same store focus must never color a stale channel row when another
  // thread opens while the channel URL still carries its old `msg=` anchor.
  const isHighlightedInThread = useThreadStore(
    (s) => Boolean(parentMessageId) && s.focusedMessageId === message.id,
  );
  const isHighlighted = isHighlightedInChannel || isHighlightedInThread || !!threadSearchActive;
  const isAgent = message.senderType === "agent";
  const isExternal = message.senderType === "external_projection";
  const isSystem = message.messageType === "system";
  const humanDepartureLabel = isAgent || isExternal
    ? null
    : getHumanDepartureLabel(message.senderMembershipStatus);
  const structuredMentionMap = useMemo(() => buildStructuredMentionMap(message.mentions), [message.mentions]);
  // A read-only projection has no member directory: its only mention facts are
  // the display-only ones carried on the message, which also supply the label.
  const effectiveMentionMap = readOnlyProjection
    ? structuredMentionMap
    : isExternal ? EXTERNAL_MESSAGE_MENTION_MAP : mentionMap;
  const effectiveStructuredMentionMap = structuredMentionMap;
  const { formatMessageTime, formatClock, formatMediumDateTime, options: timeFormatOptions } = useTimeFormatter();
  const intl = useIntl();
  const { formatMessage } = intl;
  // Render reads formatMessage directly; effects/handlers read
  // formatMessageRef.current so a locale switch never re-runs them.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const time = formatMessageTime(message.createdAt);
  // Bare HH:MM clock for the continuation-row hover gutter (task #44); the
  // full `time` above ("Yesterday 3:04") is too wide for the narrow gutter.
  // Fixed-width clock in the gutter (stdrc); full date+time in the tooltip. Both
  // go through the shared time formatter so no raw browser time API lives here.
  const gutterClock = formatClock(message.createdAt);
  const gutterFullTimestamp = formatMediumDateTime(message.createdAt);
  // Grouping defaults: surfaces that don't pass groupState (thread/DM panels)
  // keep the full header — avatar + name always shown, timestamp inline.
  const viewer = useAuthStore((s) => s.user);
  const currentUser = viewer;
  const storeSenderAgent = useAgentStore((s) =>
    message.senderType === "agent"
      ? s.agents.find((agent) => agent.id === message.senderId)
      : undefined
  );
  const storeSenderMember = useServerStore((s) =>
    message.senderType === "user"
      ? s.members.find((member) => member.userId === message.senderId)
      : undefined
  );
  const currentUserServerRole = useServerStore((s) => s.current?.role);
  // The server agent directory is the live identity source. Channel/member
  // previews are relation snapshots and can outlive an avatar/profile update;
  // keep them only as a cold-start / cross-server fallback.
  const senderAgent = storeSenderAgent ?? previewSenderAgent;
  // Desktop-only, opt-in: a model label next to an agent sender's name.
  const showAgentModelNameOption = useShowAgentModelName();
  // Subscribe per row: this component is memoized, so a catalog that arrives
  // after the first message render must still update the name (task #700).
  // Subscribe per row: this component is memoized, so a catalog that arrives
  // after the first message render must still update the name (task #700).
  const catalogModelLabelText = useCatalogModelLabel(
    senderAgent?.machineId,
    senderAgent?.runtime,
    senderAgent?.model,
  );
  // A hosted agent's runtime/model are the "External agent" placeholders; name the hosting instead.
  const hostedModelLabelText = senderAgent?.hostedRuntime
    ? intl.formatMessage({ id: "message.agentModel.hosted" })
    : null;
  const agentModelLabelText = showAgentModelNameOption
    ? hostedModelLabelText ?? catalogModelLabelText ?? agentModelLabel(senderAgent)
    : null;
  const senderMember = useMemo(() => {
    if (previewSenderMember) return previewSenderMember;
    const memberById = new Map<string, ServerMember>();
    if (storeSenderMember) memberById.set(storeSenderMember.userId, storeSenderMember);
    return resolveMessageSenderMember(message, memberById, currentUser, currentUserServerRole);
  }, [currentUser, currentUserServerRole, message, previewSenderMember, storeSenderMember]);
  const isDeactivatedAgent = isAgent && !!senderAgent?.deletedAt;
  const viewerUserId = viewer?.id ?? null;
  const serverId = useServerStore((s) => s.current?.id ?? null);

  const reactionActorCache = useStore(
    reactionReadModelStore,
    (state) => state.actorCache,
  );
  const readReceiptsEnabled = useServerFeatureFlag(
    READ_RECEIPTS_FEATURE_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  // #693: the aggregate footer "Read" chip is REMOVED. It collapsed every peer
  // into one boolean, so a message with no @agent at all still showed "Read"
  // once any un-mentioned agent had read the channel, and large-channel summary
  // scopes produced it too — both contradicting the per-@mentioned-agent
  // contract. Read state is now shown only on each @mentioned agent's own
  // mention (see MentionLink + messageReadReceiptScope).
  // #693: the per-@mentioned-agent badge shares the SAME visibility rule as the
  // legacy chip (only this message's human sender sees it) but is independent
  // of `isReadByPeer`, which collapses human+agent peers.
  const agentReadBadgesEnabled =
    message.senderType === "user"
    && viewerUserId === message.senderId
    && readReceiptsEnabled;
  // #693 follow-up: a DM has no @mention to hang the per-agent badge on, so
  // removing the legacy footer chip left DMs with NO read indicator at all.
  // Restored here, but scoped to DMs only — that is exactly where the chip was
  // never ambiguous: a DM has ONE exposed peer, so "read" cannot silently mean
  // "some unrelated agent read it", which is why it had to go in channels.
  // The `channels` prop carries ONLY non-DM channels: the store keeps DMs in a
  // separate `dmChannels` collection and ChatPanel passes `s.channels`. Deriving
  // DM-ness from the prop therefore reads false for every real DM, so the chip
  // could never render outside a test that hand-builds the prop. Ask the store,
  // which is the actual authority for both collections.
  const isDmSurface = useChannelStore(
    (state) =>
      state.dmChannels.some((candidate) => candidate.id === message.channelId)
      || state.channels.some(
        (candidate) => candidate.id === message.channelId && candidate.type === "dm",
      ),
  );
  const dmReadReceiptScope = useReadReceiptStore(
    (state) => state.scopes[message.channelId],
  );
  // artin (option C): one status line under the DM's last message, never a
  // per-message footer chip. A chip in the footer created the footer row the
  // moment the peer read the message, so every read message grew ~26px, and
  // the watermark made it repeat on every earlier message too.
  const showDmReadReceipt = showDmReadStatus
    && agentReadBadgesEnabled
    && isDmSurface
    && projectReadReceipt(dmReadReceiptScope, message.seq ?? undefined).read;
  const viewerReactionName = viewer?.displayName || viewer?.name || viewer?.email || formatMessage({ id: "message.messageItem.reactorYou" });

  const serverSlug = useServerStore((s) => s.current?.slug);
  const referenceSurfaceChannelId = parentChannelId || message.channelId;
  // task #187 collapse-long-messages: per-user, per-channel server-persisted
  // pref. OFF = long messages on this surface always render fully expanded
  // (CollapsibleMessageContent behaves as if disabled). Missing hydration
  // defaults to collapsing — the server default.
  const storedCollapseLongMessages = useChannelStore(
    (state) =>
      (state.channels.find((candidate) => candidate.id === referenceSurfaceChannelId)
        ?? state.dmChannels.find((candidate) => candidate.id === referenceSurfaceChannelId))
        ?.collapseLongMessages ?? true,
  );
  const collapseLongMessages = storedCollapseLongMessages;
  const isJointReferenceSurface = channels.some(
    (channel) => channel.id === referenceSurfaceChannelId && channel.type === "joint",
  );
  const storeSenderKnownOnCurrentServer = !!storeSenderAgent || !!storeSenderMember;
  const previewRefAuthorityServerSlug = previewSenderAgent?.serverSlug
    ?? previewSenderMember?.serverSlug
    ?? undefined;
  const previewSenderKnownOnCurrentServer = (!!serverId && previewSenderAgent?.serverId === serverId)
    || (!!serverId && previewSenderMember?.serverId === serverId)
    || (!!serverSlug && previewRefAuthorityServerSlug === serverSlug);
  const senderKnownOnCurrentServer = message.senderId === viewerUserId
    || storeSenderKnownOnCurrentServer
    || previewSenderKnownOnCurrentServer;
  const explicitRefAuthorityServerSlug = senderKnownOnCurrentServer
    ? serverSlug
    : previewRefAuthorityServerSlug;
  const threadRefAuthorityUnavailable = isJointReferenceSurface
    && !explicitRefAuthorityServerSlug
    && !senderKnownOnCurrentServer;
  const refAuthorityServerSlug = explicitRefAuthorityServerSlug
    ?? (threadRefAuthorityUnavailable ? undefined : serverSlug);
  // dmChannels is stable across inbound-message activity bumps now that
  // `lastMessageAt` lives in the `channelActivity` slice (not the channel
  // objects), so this per-row subscription no longer re-renders on every message.
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const requestTransientFocus = useMessageStore((s) => s.requestTransientFocus);
  const nav = useAppNavigate();
  const translationSettings = useTranslationStore((s) => s.settings);
  const translationEntry = useTranslationStore((s) => s.entries[message.id]);
  const requestTranslations = useTranslationStore((s) => s.requestTranslations);
  const retryTranslation = useTranslationStore((s) => s.retryMessage);
  const setTranslationShowOriginal = useTranslationStore((s) => s.setShowOriginal);
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const messageBodyFontSizeClass = getMessageBodyFontSizeClass(messageBodyFontSize);
  const messageNameSizeClass = getMessageNameSizeClass(messageBodyFontSize);
  const messageMetaSizeClass = getMessageMetaSizeClass(messageBodyFontSize);
  const messageBodyFontSizeStyle = useMemo(() => ({
    ...getMessageBodyFontSizeStyle(messageBodyFontSize),
    userSelect: "text" as const,
    WebkitUserSelect: "text" as const,
  }), [messageBodyFontSize]);
  const imagePreviewAttachments = useMemo(
    () => (message.attachments ?? []).filter((att) => isPreviewableImageAttachment(att)),
    [message.attachments],
  );
  const lightboxImages = useMemo(
    () => imagePreviewAttachments.filter((att) => !isOptimisticAttachment(att)),
    [imagePreviewAttachments],
  );
  const actionMetadata = message.actionMetadata as { kind?: string; replyTo?: string } | null | undefined;
  const isActionCardMessage = actionMetadata?.kind === "action-card";
  const translationTargetLanguage = translationSettings.available && translationSettings.preferredTranslationMode !== "off"
    ? translationSettings.effectiveLanguage
    : null;
  const isOwnHumanMessage = message.senderType === "user" && viewerUserId === message.senderId;
  const translationEligible =
    !isSystem &&
    !!translationTargetLanguage &&
    (translationSettings.preferredTranslationMode === "manual" || !isOwnHumanMessage);
  const currentTranslationEntry =
    translationEntry &&
    translationEntry.targetLanguage === translationTargetLanguage &&
    (!translationEntry.originalContent || translationEntry.originalContent === message.content)
      ? translationEntry
      : undefined;
  const activeTranslationEntry = translationEligible ? currentTranslationEntry : undefined;
  const activeTranslationHasContent = hasUsableTranslatedContent(activeTranslationEntry);
  const manualTranslationPending = activeTranslationEntry?.status === "pending";
  const showManualTranslationAction =
    translationSettings.preferredTranslationMode === "manual"
    && translationEligible
    && message.content.trim().length > 0
    && !isActionCardMessage
    && !activeTranslationHasContent
    && activeTranslationEntry?.status !== "failed";
  const activeTranslationDisplay: PreferredTranslationDisplay = activeTranslationEntry?.showOriginal === true
    ? "original"
    : activeTranslationEntry?.showOriginal === false
      ? translationSettings.preferredTranslationDisplay === "original"
        ? "translated"
        : translationSettings.preferredTranslationDisplay
      : translationSettings.preferredTranslationDisplay;
  const activeTranslationShowOriginal = activeTranslationDisplay === "original";
  const handleToggleTranslationOriginal = useCallback(() => {
    setTranslationShowOriginal(message.id, !activeTranslationShowOriginal);
  }, [setTranslationShowOriginal, message.id, activeTranslationShowOriginal]);
  const handleRetryTranslation = useCallback(() => {
    if (!translationTargetLanguage) return;
    void retryTranslation(message, { targetLanguage: translationTargetLanguage, viewerUserId });
  }, [translationTargetLanguage, retryTranslation, message, viewerUserId]);
  const handleUpgradePlan = useCallback(() => {
    nav.toSettings("server");
  }, [nav]);
  const isTranslationPending =
    translationEligible &&
    translationSettings.preferredTranslationMode === "auto" &&
    !activeTranslationShowOriginal &&
    (
      activeTranslationEntry?.status === "pending" ||
      (!activeTranslationEntry && translationSettings.preferredTranslationMode === "auto")
    );
  const translatedContent =
    activeTranslationHasContent &&
    activeTranslationDisplay !== "original"
      ? activeTranslationEntry?.translatedContent ?? null
      : null;
  const showBilingualOriginal =
    !!translatedContent &&
    activeTranslationDisplay === "bilingual" &&
    !!message.content;
  const currentOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  const originalMessageContent = localizeExternalReplyPermalink(message.content ?? "", message.actionMetadata,
    message.channelId, serverSlug, currentOrigin);
  const visibleMessageContent = translatedContent === null ? originalMessageContent
    : localizeExternalReplyPermalink(translatedContent, message.actionMetadata, message.channelId, serverSlug, currentOrigin);
  const forwardedBundleMetadata = isForwardedBundleMetadata(actionMetadata) ? actionMetadata : null;
  const forwardedItemCount = Array.isArray(forwardedBundleMetadata?.forwardedItems)
    ? forwardedBundleMetadata.forwardedItems.length
    : 0;
  const generatedForwardContent = forwardedBundleMetadata
    ? `Forwarded ${forwardedItemCount} message${forwardedItemCount === 1 ? "" : "s"}`
    : null;
  const currentHostname = typeof window !== "undefined" ? window.location.hostname : undefined;
  const quotedPermalink = useMemo(
    () => extractFirstQuotedMessagePermalink(originalMessageContent, currentHostname, serverSlug),
    [currentHostname, originalMessageContent, serverSlug],
  );
  const [unavailableQuotedPermalinkUrl, setUnavailableQuotedPermalinkUrl] = useState<string | null>(null);
  const quotedPermalinkUnavailable = quotedPermalink?.rawUrl === unavailableQuotedPermalinkUrl;
  const handleQuotedPermalinkUnavailable = useCallback(() => {
    if (quotedPermalink) setUnavailableQuotedPermalinkUrl(quotedPermalink.rawUrl);
  }, [quotedPermalink]);
  const isReplyQuote = !readOnlyProjection && !!quotedPermalink
    && (actionMetadata?.kind === "external-dm" || actionMetadata?.kind === "external-topic")
    && actionMetadata.replyTo === quotedPermalink.parsed.messageId
    && quotedPermalink.parsed.channelId === message.channelId
    && originalMessageContent.startsWith(`${quotedPermalink.rawUrl}\n\n`);
  // The reply block owns its generated link. Preserve authored links and restore
  // the original reference when the preview is unavailable.
  const quotePrefix = isReplyQuote && !quotedPermalinkUnavailable ? `${quotedPermalink.rawUrl}\n\n` : null;
  const replyBodyContent = quotePrefix && visibleMessageContent.startsWith(quotePrefix)
    ? visibleMessageContent.slice(quotePrefix.length) : visibleMessageContent;
  const bilingualOriginalContent = quotePrefix && originalMessageContent.startsWith(quotePrefix)
    ? originalMessageContent.slice(quotePrefix.length) : originalMessageContent;
  const forwardedBundleBodyContent = forwardedBundleMetadata
    && replyBodyContent.trim() === generatedForwardContent ? "" : replyBodyContent;
  // Stable so they don't break the memoized markdown body (renderContent) below.
  const handleNavigateAgent = useCallback((agentId: string) => {
    const knownAgent = senderAgent?.id === agentId
      ? senderAgent
      : [...mentionMap.values()].find((entry) => entry.type === "agent" && entry.id === agentId)?.agent;
    if (knownAgent) setCachedAgentProfile(serverId, knownAgent);
    if (onOpenProfile) {
      onOpenProfile("agent", agentId);
      return;
    }
    openConversationAgentProfile(useProfileStore.getState().openProfile, agentId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [mentionMap, onOpenProfile, parentMessageId, senderAgent, serverId]);

  // Opens the SAME profile panel as clicking the mention, just landing on the
  // activity tab. Deliberately not a route change to /agent/:id — every other
  // mention interaction opens the panel and stays in the channel, and diverging
  // here would make one affordance in the card behave unlike its siblings.
  const handleNavigateAgentActivity = useCallback((agentId: string) => {
    const knownAgent = senderAgent?.id === agentId
      ? senderAgent
      : [...mentionMap.values()].find((entry) => entry.type === "agent" && entry.id === agentId)?.agent;
    if (knownAgent) setCachedAgentProfile(serverId, knownAgent);
    openConversationAgentActivity(useProfileStore.getState().openProfile, agentId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [mentionMap, parentMessageId, senderAgent, serverId]);

  const handleNavigateHuman = useCallback((userId: string) => {
    if (onOpenProfile) {
      onOpenProfile("human", userId);
      return;
    }
    useProfileStore.getState().openProfile("human", userId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [onOpenProfile, parentMessageId]);

  const handleNavigateExternal = useCallback(() => {
    const profile = message.externalAuthor;
    if (!profile) return;
    useProfileStore.getState().openExternalProfile(message.id, profile, {
      channelId: message.channelId,
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [message.channelId, message.externalAuthor, message.id, parentMessageId]);

  const handleNavigateExternalMention = useCallback((profile: ExternalMessageAuthorProjection) => {
    // Thread panels pass the thread's channelId, but the Slack binding lives
    // on the parent channel — use the same parent-first lookup the avatar
    // path uses so refresh/back restores the right channel.
    const channelId = parentChannelId || message.channelId;
    useProfileStore.getState().openExternalProfile(profile.projectionId, profile, {
      channelId,
      openSource: parentMessageId ? "thread" : "channel",
      isMention: true,
    });
  }, [message.channelId, parentChannelId, parentMessageId]);

  const handleNavigateComputer = useCallback((machineId: string) => {
    const computer = useMachineStore.getState().machines.find((machine) => machine.id === machineId && machine.isComputer);
    if (computer) nav.toComputer(machineId);
  }, [nav]);

  const handleNavigateChannel = useCallback((channel: Channel) => {
    nav.toChannel(channel.id);
  }, [nav]);

  const handleNavigateDm = useCallback((channel: Channel) => {
    nav.toDm(channel.id);
  }, [nav]);

  // Look up agent's avatar
  const agentAvatarUrl = readOnlyProjection
    ? readOnlySender?.avatarUrl ?? null
    : senderAgent?.avatarUrl ?? null;
  const humanAvatarUrl = readOnlyProjection
    ? readOnlySender?.avatarUrl ?? null
    : senderMember?.avatarUrl ?? null;
  const externalAvatarUrl = readOnlyProjection
    ? null
    : message.externalAuthor?.avatarUrl ?? null;
  const senderAgentDmChannel = isAgent
    ? dmChannels.find((channel) => channel.peerType === "agent" && channel.peerId === message.senderId)
    : null;
  const senderEmailForAvatar =
    !isAgent && currentUser?.id === message.senderId && !senderMember?.gravatarHash
      ? currentUser.email
      : null;

  // Sender subtitle: agent description or human description (fallback to role)
  const senderDisplayName = readOnlyProjection
    ? readOnlySender?.displayName || message.senderName || formatMessage({ id: "message.messageItem.senderUserFallback" })
    : isExternal
      ? message.externalAuthor?.displayName || message.senderName || formatMessage({ id: "message.author.externalFallback" })
      : isAgent
        ? senderAgent?.displayName || senderAgentDmChannel?.peerDisplayName || senderAgent?.name || message.senderName || formatMessage({ id: "message.messageItem.senderAgentFallback" })
        : message.senderName || formatMessage({ id: "message.messageItem.senderUserFallback" });
  const senderSubtitle = readOnlyProjection
    ? readOnlySender?.description ?? null
    : isExternal
      ? message.externalAuthor?.provider ?? null
      : isAgent
        ? senderAgent?.description || message.senderDescription || null
        : senderMember?.description || message.senderDescription || formatMemberRole(senderMember?.role ?? "", formatMessage) || null;
  const senderMention = useMemo<MessageMention | null>(() => {
    if (isExternal) return null;
    const name = isAgent ? senderAgent?.name : senderMember?.name;
    if (!name || isDeactivatedAgent || humanDepartureLabel) return null;
    return {
      type: isAgent ? "agent" : "user",
      id: message.senderId,
      name,
    };
  }, [humanDepartureLabel, isAgent, isDeactivatedAgent, isExternal, message.senderId, senderAgent?.name, senderMember?.name]);
  const senderMentionChannelId = mentionComposerChannelId ?? message.channelId;
  const insertSenderMention = useCallback(() => {
    if (!senderMention) return;
    dispatchSenderMentionInsert({
      channelId: senderMentionChannelId,
      mention: senderMention,
    });
  }, [senderMention, senderMentionChannelId]);
  const handleSenderNameMention = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    insertSenderMention();
  }, [insertSenderMention]);
  const storeOpenThread = useThreadStore((s) => s.openThread);
  const openThread = useCallback((request: OpenThreadRequest) => {
    if (onOpenThread) {
      onOpenThread(request);
      return Promise.resolve();
    }
    return storeOpenThread(request);
  }, [onOpenThread, storeOpenThread]);
  const closeThread = useThreadStore((s) => s.closeThread);
  // Per-row answers, so a change to another thread does not re-render this row.
  const threadFollowedInStore = useThreadStore((s) => isThreadFollowed(s, message.id));
  const followedListThreadChannelId = useThreadStore((s) =>
    s.followedThreads.find((thread) => thread.parentMessageId === message.id)?.threadChannelId ?? null);
  const followThread = useThreadStore((s) => s.followThread);
  const unfollowThread = useThreadStore((s) => s.unfollowThread);
  // Subscribe to this row's own answer, not the raw ids: every rendered row
  // mounts this component, so selecting the ids re-rendered the whole list on
  // each thread open/close. A boolean only changes for the old and new parent.
  const isOpenThreadParent = useThreadStore((s) =>
    s.openParentMessageId === message.id && s.openParentChannelId === message.channelId);

  // Select mode (multi-select share). Subscribed early because handleMobileTap
  // below intercepts clicks when scoped here.
  //
  // Two scopes:
  //  - Channel mode (selection.threadRootId === null): top-level rows in
  //    `channelId` are selectable — that's `!parentMessageId` rows whose
  //    `message.channelId === selection.channelId`.
  //  - Thread mode (selection.threadRootId !== null): the parent message
  //    rendered inside ThreadPanel AND its thread replies (rendered with
  //    `parentMessageId === threadRootId`) are selectable. The parent may
  //    share an id with the channel timeline row, but that row must not show
  //    thread-local selection chrome.
  const selectionActive = useSelectionStore((s) => s.isActive);
  const selectionChannelId = useSelectionStore((s) => s.channelId);
  const selectionThreadRootId = useSelectionStore((s) => s.threadRootId);
  // Stryker disable all: thread/channel selection scope is pinned by the
  // selection behavior and source-contract tests; individual boolean rewrites
  // here create equivalent DOM states for the mutation oracle.
  const selectionScopedHere =
    selectionActive &&
    (selectionThreadRootId === null
      ? !parentMessageId && selectionChannelId === message.channelId
      : (hideThreadActions && message.id === selectionThreadRootId) ||
        parentMessageId === selectionThreadRootId);
  const isSelected = useSelectionStore((s) => s.selectedIds.has(message.id));
  const isPreviousGroupedMessageSelected = useSelectionStore((s) =>
    groupState?.previousMessageId
      ? s.selectedIds.has(groupState.previousMessageId)
      : false,
  );
  const toggleSelection = useSelectionStore((s) => s.toggle);
  const enterSelection = useSelectionStore((s) => s.enter);
  const enterThreadSelection = useSelectionStore((s) => s.enterThread);
  const isSelectedAsThreadParent =
    !parentMessageId &&
    !hideThreadActions &&
    !(selectionActive && selectionThreadRootId === message.id) &&
    isOpenThreadParent;
  const showSelectedGroupedHeader = shouldShowGroupedMessageHeader(
    groupState,
    selectionScopedHere,
    isSelected,
    isPreviousGroupedMessageSelected,
  );
  // Stryker restore all
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const canShowThreadFollowAction = !readOnlyProjection && (!hideThreadActions || !!showThreadFollowAction);
  const messageRef = useRef<HTMLDivElement | null>(null);
  const messageBodyRef = useRef<HTMLDivElement | null>(null);
  // Stryker disable all: React effect wiring delegates branch decisions to
  // behavior-tested helpers; source contracts pin the API endpoint and render
  // use sites while the focused mutation oracle avoids full MessageItem DOM.
  const imageFallbackKey = useMemo(() => buildImageInlineFallbackKey(message.attachments), [message.attachments]);
  // Stryker restore all

  const threadFollowed = canShowThreadFollowAction && threadFollowedInStore;
  const followedThreadChannelId = threadFollowed
    ? threadSummary?.threadChannelId ?? followedListThreadChannelId
    : null;
  const hasThreadConversation = !!threadSummary?.threadChannelId || (threadSummary?.replyCount ?? 0) > 0 || threadFollowed;
  const threadUnreadCount = threadSummary?.unreadCount ?? 0;
  const firstUnreadThreadMessageId = threadUnreadCount > 0 ? threadSummary?.firstUnreadMessageId ?? null : null;
  const threadDraftChannelId = !hideThreadActions
    ? threadSummary?.threadChannelId ?? followedThreadChannelId ?? null
    : null;
  const hasThreadDraft = useMessageStore((s) =>
    threadDraftChannelId ? !!s.drafts[threadDraftChannelId]?.trim() : false
  );
  // Stryker disable all: thread reply badge visibility is pre-existing; ThreadRepliesBadge owns the rendered states.
  const threadReplyCount = threadSummary?.replyCount ?? 0;

  // Inline reply previews are the default thread surface.
  //
  // PER-KEY selector, deliberately. `replyScopes` is replaced whenever ANY thread
  // takes a reply, but the reducer keeps every untouched scope reference-identical,
  // so this selector's RESULT is unchanged for other messages and zustand skips the
  // re-render. Subscribing to the map itself (or to threadStore wholesale, which is
  // what ChatPanel does with `summaries` — hence the separate map) would re-render
  // every message in the channel on every reply in any thread: the #4434 regression.
  const storedReplyScope = useThreadStore((s) => s.replyScopes[message.id]);
  const replyScope = readOnlyProjection ? readOnlyReplyScope : storedReplyScope;
  const hasThreadReplies = threadReplyCount > 0;
  const inlineReplySurfaceReplacesBadge =
    !!replyScope &&
    hasInlineThreadReplySurface(replyScope.replies, replyScope.replyCount);
  const shouldShowThreadRepliesBadge =
    (hasThreadReplies || hasThreadDraft) && !hideThreadActions && !inlineReplySurfaceReplacesBadge;
  const hasThreadFooterMetadata = shouldShowThreadRepliesBadge;
  // Stryker restore all

  // Stryker disable all: both thread opener payloads are source-contract pinned and
  // behavior-covered through the workspace host; dependency-array deletion is not
  // a meaningful one-shot click mutation.
  const handleReplyInThread = useCallback(() => {
    onBeforeOpenThread?.();
    // A thread action is an explicit navigation to the conversation surface.
    // If a profile is currently covering the channel, dismiss it first so the
    // reply opens in the normal Channel + Thread shell rather than leaving the
    // profile mounted as the newer right-panel surface.
    closeProfile();
    const chId = parentChannelId || message.channelId;
    // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
    openThread({
      parentChannelId: chId,
      parentMessageId: message.id,
      initialThreadChannelId: threadDraftChannelId,
    });
  }, [closeProfile, message.channelId, message.id, onBeforeOpenThread, openThread, parentChannelId, threadDraftChannelId]);

  const handleOpenThreadReplies = useCallback(() => {
    onBeforeOpenThread?.();
    // Keep the reply badge/inline preview path consistent with the explicit
    // "Reply in thread" action above when Profile is open over the Channel.
    closeProfile();
    const chId = parentChannelId || message.channelId;
    // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
    openThread({
      parentChannelId: chId,
      parentMessageId: message.id,
      focusedMessageId: firstUnreadThreadMessageId,
      initialThreadChannelId: threadDraftChannelId,
    });
  }, [closeProfile, firstUnreadThreadMessageId, message.channelId, message.id, onBeforeOpenThread, openThread, parentChannelId, threadDraftChannelId]);
  // Stryker restore all

  // Scoped attachment comment (cindyz 6/11): clicking the `re:` chip jumps to
  // the message the attachment lives on. Reuses the same source→nav shape the
  // Files tab uses, keyed off commentRef.hostSource (server enrichment). Tiered:
  // when the host is in the currently-open channel, a local transient focus
  // (scroll + highlight, no URL churn — the common "point at it" case); cross
  // channel/DM/thread goes through the message-level permalink route.
  const handleJumpToCommentHost = useCallback(() => {
    const ref = message.commentRef;
    if (!ref?.hostMessageId || !ref.hostSource) return; // unresolvable → no jump (never a wrong one)
    const { hostSource, hostMessageId } = ref;
    if (ref.anchorLabel) {
      const seekTime = parseTimestampLabel(ref.anchorLabel);
      if (seekTime !== null) {
        setPendingVideoSeek(ref.attachmentId, seekTime);
        const tryAutoOpen = (n: number) => {
          const el = document.getElementById(`message-${hostMessageId}`);
          const btn = el?.querySelector('[data-message-affordance="video-preview"]')?.closest("button");
          if (btn) { btn.click(); return; }
          if (n < 10) setTimeout(() => tryAutoOpen(n + 1), 200);
        };
        setTimeout(() => tryAutoOpen(0), 100);
      }
    }
    // Host top-level message is itself a thread root → open that thread expanded,
    // landing on the root message (cindyz #32), rather than locating it in the
    // closed-state channel. Takes precedence over the surface-local paths below.
    if (hostSource.rootThreadChannelId) {
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: hostSource.channelId,
        parentMessageId: hostMessageId,
        focusedMessageId: hostMessageId,
      });
      return;
    }
    // Same surface as this row → local focus, no URL churn. The local branch
    // must be surface-aware, not just channel-aware: parentMessageId tells
    // ChatPanel (absent → consumes requestTransientFocus) apart from a
    // ThreadPanel reply (present → consumes openThread focus), and each ignores
    // the other's signal (Dozy review, PR #2799).
    if (!parentMessageId && hostSource.type === "channel" && hostSource.channelId === parentChannelId) {
      requestTransientFocus(hostSource.channelId, hostMessageId);
      return;
    }
    // Stryker disable next-line ConditionalExpression: surface-aware same-thread guard is covered by navigation source contracts outside the DOM mutation corpus.
    if (parentMessageId && hostSource.type === "thread" && hostSource.parentMessageId === parentMessageId) {
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: hostSource.channelId,
        parentMessageId: hostSource.parentMessageId,
        focusedMessageId: hostMessageId,
      });
      return;
    }
    // Cross surface → message-level permalink route (Files tab source→nav shape).
    if (hostSource.type === "thread" && hostSource.parentMessageId) {
      nav.toThreadMessage(hostSource.channelId, hostSource.parentMessageId, hostMessageId, hostSource.routeKind);
    } else if (hostSource.routeKind === "dm") {
      nav.toDmMessage(hostSource.channelId, hostMessageId);
    } else {
      nav.toMessage(hostSource.channelId, hostMessageId);
    }
  }, [message.commentRef, parentChannelId, parentMessageId, requestTransientFocus, openThread, nav]);

  // On mobile (no hover), tapping a message opens its thread.
  // When select mode is active for this message's channel, single-click (any
  // device) toggles selection instead and we suppress the thread-open path.
  const handleMobileTap = useCallback((e: MouseEvent) => {
    if (selectionScopedHere) {
      const target = e.target as HTMLElement;
      // Allow links/buttons inside selected rows to still work
      if (target.closest("a, button")) return;
      e.preventDefault();
      toggleSelection(message.id);
      return;
    }
    if (hideThreadActions) return;
    // Don't open thread if long-press context menu just fired
    if (longPressFired.current) return;
    // Only on touch devices (no hover capability); jsdom suites without a
    // matchMedia stub are treated as touch (the target filter below still
    // exempts interactive elements, so the guard stays behavior-neutral).
    if (typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches) return;
    // Don't intercept clicks on interactive elements (links, buttons, code blocks, images)
    const target = e.target as HTMLElement;
    if (target.closest("a, button, pre, code, img")) return;
    handleReplyInThread();
  }, [hideThreadActions, handleReplyInThread, selectionScopedHere, toggleSelection, message.id]);

  const [resolvingThreadRefKey, setResolvingThreadRefKey] = useState<string | null>(null);

  // Transient ref-open failures surface through the standard RUI toast — the
  // same component MainLayout uses for the identical message — instead of a
  // hand-rolled inline box.
  const showThreadRefNotice = useCallback((notice: ThreadRefNoticeKey) => {
    toast.error(formatMessageRef.current({ id: notice }));
  }, []);

  const navigableChannels = useMemo(
    () => [...channels, ...dmChannels.filter((dm) => !channels.some((channel) => channel.id === dm.id))],
    [channels, dmChannels],
  );
  const taskSurfaceChannel = useMemo(
    () => navigableChannels.find((channel) => channel.id === (parentChannelId || message.channelId)),
    [message.channelId, navigableChannels, parentChannelId],
  );
  const supportsMessageTasks = taskSurfaceChannel !== undefined && taskSurfaceChannel.type !== "thread";

  const handleOpenThreadRef = useCallback(async (intent: ThreadRefIntent) => {
    const threadRefKey = `${intent.serverSlug}:${intent.parentChannelName.toLowerCase()}:${intent.shortId.toLowerCase()}`;

    if (threadRefAuthorityUnavailable) {
      showThreadRefNotice("message.messageItem.threadServerUnknown");
      return;
    }

    if (!serverSlug || intent.serverSlug !== serverSlug) {
      window.location.assign(buildThreadRefHandoffPath(intent));
      return;
    }

    const parentChannel = findThreadRefParentChannel(intent, serverSlug, navigableChannels);
    if (!parentChannel) {
      showThreadRefNotice("message.messageItem.threadUnavailable");
      return;
    }
    const isRequestAuthorityCurrent = captureThreadRouteAuthorityGuard(serverSlug, () => {
      const currentAuthority = useServerStore.getState();
      return {
        serverSlug: currentAuthority.current?.slug,
        serverEpoch: currentAuthority.serverEpoch,
      };
    });
    setResolvingThreadRefKey(threadRefKey);

    let threadTarget: ThreadRouteTarget | null = null;
    try {
      threadTarget = await resolveThreadTargetByShortId({
        serverSlug,
        parentChannelId: parentChannel.id,
        shortId: intent.shortId,
        summaries: useThreadStore.getState().summaries,
        followedThreads: useThreadStore.getState().followedThreads,
        loadContext: async (channelId, targetShortId) => {
          const { data } = await api.get<{
            targetMessageId?: string | null;
            canonicalTarget?: {
              kind?: string;
              channelId?: string;
              messageId?: string;
              threadParentMessageId?: string;
              threadChannelId?: string | null;
            } | null;
          }>(
            `/messages/context/${targetShortId}`,
            { params: { channelId } },
          );
          return data;
        },
      });
    } finally {
      setResolvingThreadRefKey((current) => current === threadRefKey ? null : current);
    }

    if (!isRequestAuthorityCurrent()) return;
    if (threadTarget) {
      if (parentChannel?.type === "dm") {
        nav.toDmMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      } else {
        nav.toMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      }
      if (!isRequestAuthorityCurrent()) return;
      void openThread({
        ...threadTarget,
        focusedMessageId: intent.focusedMessageId ?? threadTarget.focusedMessageId,
      });
      return;
    }
    showThreadRefNotice("message.messageItem.threadUnavailable");
  }, [nav, navigableChannels, openThread, serverSlug, showThreadRefNotice, threadRefAuthorityUnavailable]);

  // Stryker disable all: message-ref navigation dependency-array rewrites are
  // equivalent in the static mutation oracle; behavior coverage exercises the
  // thread and non-thread navigation branches directly.
  const handleOpenMessageRef = useCallback(async (targetChannel: Channel, messageId: string, threadParentShortId: string | null) => {
    if (threadParentShortId) {
      if (!serverSlug) return;
      await handleOpenThreadRef({
        serverSlug,
        parentChannelName: targetChannel.name,
        parentChannelType: targetChannel.type === "dm" ? "dm" : "channel",
        parentChannelId: targetChannel.id,
        shortId: threadParentShortId,
        focusedMessageId: messageId,
      });
      return;
    }
    if (targetChannel.type === "dm") {
      nav.toDmMessage(targetChannel.id, messageId);
    } else {
      nav.toMessage(targetChannel.id, messageId);
    }
  }, [handleOpenThreadRef, nav, serverSlug]);
  // Stryker restore all

  // Stryker disable all: forwarded-source navigation is covered by source-label
  // behavior tests; the mutation runner's mocked navigation/API setup leaves
  // several defensive unavailable-source branches observationally equivalent.
  const handleOpenForwardedSource = useCallback(async (item: ForwardedBundleItem) => {
    const sourceMessageId = item.sourceMessageId;
    const sourceTarget = item.sourceTargetSnapshot;
    if (!sourceMessageId || item.provenanceState === "original_unavailable") return;
    if (!sourceTarget || sourceTarget.type === "dm" || sourceTarget.labelVisibility !== "public") return;

    if (sourceTarget.type === "thread" && item.sourceThreadId && item.parentChannelId) {
      const parentChannel = navigableChannels.find((channel) => channel.id === item.parentChannelId);
      if (!parentChannel || parentChannel.type === "dm") return;
      try {
        const { data } = await api.get<{
          canonicalTarget?: {
            kind?: string;
            messageId?: string;
            threadParentMessageId?: string;
            threadChannelId?: string | null;
          };
        }>(`/messages/context/${sourceMessageId}`, { params: { channelId: item.parentChannelId } });
        const target = data.canonicalTarget;
        if (target?.kind === "thread" && target.threadParentMessageId) {
          nav.toMessage(item.parentChannelId, target.threadParentMessageId);
          void openThread({
            parentChannelId: item.parentChannelId,
            parentMessageId: target.threadParentMessageId,
            focusedMessageId: target.messageId ?? sourceMessageId,
            initialThreadChannelId: target.threadChannelId ?? item.sourceThreadId,
          });
          return;
        }
        if (!target) {
          nav.toMessage(item.parentChannelId, sourceMessageId);
          void openThread({
            parentChannelId: item.parentChannelId,
            parentMessageId: sourceMessageId,
            focusedMessageId: sourceMessageId,
            initialThreadChannelId: item.sourceThreadId,
          });
          return;
        }
      } catch {
        showThreadRefNotice("message.messageItem.sourceUnavailable");
        return;
      }
      showThreadRefNotice("message.messageItem.sourceUnavailable");
      return;
    }

    if (!item.sourceTargetId) return;
    const sourceChannel = navigableChannels.find((channel) => channel.id === item.sourceTargetId);
    if (!sourceChannel || sourceChannel.type === "dm") return;
    await handleOpenMessageRef(sourceChannel, sourceMessageId, null);
  }, [handleOpenMessageRef, nav, navigableChannels, openThread, showThreadRefNotice]);
  // Stryker restore all

  // Save / unsave message
  const isSaved = useSavedStore((s) => s.savedIds.has(message.id));

  const handleToggleSave = useCallback(() => {
    if (isSaved) {
      useSavedStore.getState().unsaveMessage(message.id);
    } else {
      useSavedStore.getState().saveMessage(message.id);
    }
  }, [isSaved, message.id]);

  const handleSavedIndicatorClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    handleToggleSave();
  }, [handleToggleSave]);

  // Context menu for "Convert to task"
  const [ctxMenu, setCtxMenu] = useState<{ anchorX: number; anchorY: number; x: number; y: number; source: "pointer" | "touch" } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  // iOS can emit a synthetic mousedown/click pair after long-press touchend.
  // Keep a short-lived portal shield mounted so neither event reaches the
  // outside-click overlay and closes the menu as soon as the finger lifts.
  const [ctxMenuClickShielded, setCtxMenuClickShielded] = useState(false);
  const ctxMenuShieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleManualTranslate = useCallback(() => {
    if (!showManualTranslationAction || manualTranslationPending || !translationTargetLanguage) return;
    setCtxMenu(null);
    void requestTranslations([message], {
      targetLanguage: translationTargetLanguage,
      viewerUserId,
      force: true,
    });
  }, [
    manualTranslationPending,
    message,
    requestTranslations,
    showManualTranslationAction,
    translationTargetLanguage,
    viewerUserId,
  ]);
  const convertMessage = useTaskStore((s) => s.convertMessage);
  const channelTasks = useTaskStore((s) => s.tasks);

  // Parked with TaskChipList: grouping the channel's tasks by message id is
  // what feeds the list, and it comes back when the list does.
  // const messageTasks = useMemo(
  //   () => channelTasks.filter((t) => t.messageId === message.id)
  //     .sort((a, b) => a.taskNumber - b.taskNumber),
  //   [channelTasks, message.id],
  // );

  // A task with no host message cannot use the thread-backed modal, so it
  // falls back to the legacy panel (@stdrc msg=1561f8fc). Everything reaching
  // this list has a host message by construction, but routing on the fact
  // rather than the assumption keeps the two paths honest.

  const serverTasks = useTaskStore((s) => s.serverTasks);
  const knownTaskNumbers = useMemo(() => {
    const nums = new Set<number>();
    for (const t of channelTasks) nums.add(t.taskNumber);
    for (const t of serverTasks) nums.add(t.taskNumber);
    return nums;
  }, [channelTasks, serverTasks]);
  // Task #662 research prototype: full task payloads for inline task refs,
  // from the same source as knownTaskNumbers. Channel tasks win over the
  // server cache for the same number.
  const taskByNumber = useMemo(() => {
    const map = new Map<number, Task>();
    for (const t of serverTasks) map.set(t.taskNumber, t);
    for (const t of channelTasks) map.set(t.taskNumber, t);
    // The message's own linked task is always the freshest source for a ref
    // in that message's body.
    if (linkedTask) map.set(linkedTask.taskNumber, linkedTask);
    return map;
  }, [channelTasks, serverTasks, linkedTask]);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const [converting, setConverting] = useState(false);
  const pendingReactionEmojisRef = useRef<Set<string>>(new Set());
  const reactionFailureFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reactionFailureEmoji, setReactionFailureEmoji] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<{ x: number; y: number } | null>(null);
  const reactionPickerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [senderCtxMenu, setSenderCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const senderHandleText = senderMention ? `@${senderMention.name}` : null;

  const handleSenderContextMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu(null);
    setReactionPicker(null);
    setSenderCtxMenu({
      x: e.clientX,
      y: e.clientY,
    });
  };
  const closeSenderCtxMenu = useCallback(() => setSenderCtxMenu(null), []);

  const handleOpenThreadFromContextMenu = useCallback(() => {
    setCtxMenu(null);
    handleReplyInThread();
  }, [handleReplyInThread]);
  const [reactionPopover, setReactionPopover] = useState<{
    emoji: string;
    visibleNames: string[];
    hiddenCount: number;
    x: number;
    y: number;
  } | null>(null);
  const documentPreviewLoadingId = useDocumentPreviewStore((state) => state.loadingId);
  const mediaPreviewLoadingId = useMediaPreviewStore((state) => state.loadingId);
  const htmlPreviewLoadingId = mediaPreviewLoadingId;
  const videoPreviewLoadingId = mediaPreviewLoadingId;

  const positionReactionPickerFromRect = useCallback((rect: DOMRect) => {
    if (reactionPickerCloseTimerRef.current) {
      clearTimeout(reactionPickerCloseTimerRef.current);
      reactionPickerCloseTimerRef.current = null;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minLeft = REACTION_PICKER_VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, viewportWidth - REACTION_PICKER_WIDTH - REACTION_PICKER_VIEWPORT_MARGIN);
    const desiredLeft = rect.right - REACTION_PICKER_WIDTH;
    const belowTop = rect.bottom + 4;
    const maxTop = Math.max(REACTION_PICKER_VIEWPORT_MARGIN, viewportHeight - REACTION_PICKER_HEIGHT - REACTION_PICKER_VIEWPORT_MARGIN);
    const desiredTop = belowTop > maxTop && rect.top > REACTION_PICKER_HEIGHT + REACTION_PICKER_VIEWPORT_MARGIN
      ? rect.top - REACTION_PICKER_HEIGHT - 4
      : belowTop;

    window.dispatchEvent(new CustomEvent(REACTION_PICKER_EVENT, { detail: { messageId: message.id } }));
    setReactionPicker({
      x: Math.min(Math.max(desiredLeft, minLeft), maxLeft),
      y: Math.min(Math.max(desiredTop, REACTION_PICKER_VIEWPORT_MARGIN), maxTop),
    });
  }, [message.id]);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (isSystem) return;
    // React portal events bubble through the component tree even though their
    // DOM target lives outside this message. A modal menu's backdrop owns that
    // interaction; treating it as a message right-click/long-press reopens this
    // context menu after the child overlay dismisses.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    // If the right-click landed on an external link, defer to the browser's
    // native context menu (Open in new tab / Copy link address) instead of our
    // message menu — the user is targeting the link, not the message. Scoped to
    // external links (`target="_blank"`, per the markdown / message-body link
    // renderers) so internal ref chips (@mention / #channel / task / thread /
    // permalink) keep the message menu. Do NOT preventDefault here so the native
    // menu can appear. (artin task #489)
    if (e.target instanceof Element && e.target.closest('a[target="_blank"]')) {
      return;
    }
    // Once select mode is active, a second right-click should not re-open the
    // context menu — the user is in a focused selection task and the menu's
    // "Share messages…" / "Copy link" entries either duplicate their current
    // state or would derail the flow. Still preventDefault so the browser's
    // native menu also stays out of the way.
    if (selectionActive) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setCtxMenu({
      anchorX: e.clientX,
      anchorY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      source: "pointer",
    });
    setReactionPicker(null);
  }, [isSystem, selectionActive]);

  // Long-press to open context menu on mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (isSystem) return;
    // A child overlay may portal its backdrop to document.body. React still
    // bubbles that touch through MessageItem, but DOM containment is the
    // ownership boundary: only touches physically inside the row may arm the
    // message long-press timer.
    if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
    const target = e.target;
    if (target.closest("[data-message-selectable='true']")) return;
    // Parity with handleContextMenu: once select mode is active, long-press
    // should not re-open the context menu either. Mobile users toggle
    // selection by tapping rows in select mode; the popup menu here would
    // only get in the way.
    if (selectionActive) return;
    longPressFired.current = false;
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setCtxMenu(placeTouchMessageContextMenu({ x, y }));
      setReactionPicker(null);
      setCtxMenuClickShielded(true);
      if (ctxMenuShieldTimerRef.current) clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = setTimeout(() => {
        setCtxMenuClickShielded(false);
        ctxMenuShieldTimerRef.current = null;
      }, 600);
    }, 500);
  }, [isSystem, selectionActive]);

  useEffect(() => () => {
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (longPressFired.current) {
      // Prevent synthetic click from closing the menu
      e.preventDefault();
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    // Cancel long press if finger moves (scrolling)
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Selection-quote v0 (#proj-chat task #32). Which composer the Quote lands
  // in — mirrors the "Share messages…" routing exactly so a thread reply
  // quotes into the thread composer, a thread parent rendered in ThreadPanel
  // quotes into that thread, and a channel-timeline row quotes into the
  // channel composer.
  const quoteComposerChannelId = useMemo(() => {
    if (parentMessageId) return message.channelId; // thread reply → thread channel
    if (hideThreadActions && message.threadId) return message.threadId; // parent in ThreadPanel
    return parentChannelId || message.channelId; // channel timeline
  }, [parentMessageId, hideThreadActions, message.threadId, parentChannelId, message.channelId]);

  const handleConvertToTask = useCallback(async () => {
    setCtxMenu(null);
    setConverting(true);
    try {
      await convertMessage(message.id);
    } catch (err) {
      console.error("Failed to convert message to task:", err);
    } finally {
      setConverting(false);
    }
  }, [convertMessage, message.id]);

  const openLinkedTask = useCallback(() => {
    if (!linkedTask) return;
    if (linkedTask.messageId) {
      // Declares intent rather than leaving the host to infer it: the thread icon
    // on this same message opens the replies in the side panel, and only the
    // badge means "open the task". Inferring from "is the parent a task" cannot
    // tell those apart — which is how the thread icon started opening a modal.
    void openThread({
      parentChannelId: linkedTask.channelId,
      parentMessageId: linkedTask.messageId,
      intent: "task",
    });
      return;
    }
    openLegacyTask(linkedTask);
  }, [linkedTask, openThread, openLegacyTask]);

  const handleToggleTaskDone = useCallback(async () => {
    if (!linkedTask) return;
    setCtxMenu(null);
    const nextStatus = linkedTask.status === "done" ? "todo" : "done";
    try {
      await updateTaskStatus(linkedTask.channelId, linkedTask.id, nextStatus);
    } catch (err) {
      console.error("Failed to update task status:", err);
    }
  }, [linkedTask, updateTaskStatus]);

  const handleFollowThread = useCallback(async () => {
    setCtxMenu(null);
    try {
      await followThread(message.id);
    } catch (err) {
      console.error("Failed to follow thread:", err);
    }
  }, [followThread, message.id]);

  const handleUnfollowThread = useCallback(async () => {
    if (!followedThreadChannelId) return;
    setCtxMenu(null);
    try {
      await unfollowThread(followedThreadChannelId);
    } catch (err) {
      console.error("Failed to unfollow thread:", err);
    }
  }, [followedThreadChannelId, unfollowThread]);

  const reactions = useMemo(() => message.reactions ?? [], [message.reactions]);
  const visibleReactions = useMemo(
    () => reactions.filter((reaction) => reaction.count > 0),
    [reactions],
  );
  const readReactionActors = useCallback((
    reaction: NonNullable<Message["reactions"]>[number],
  ): readonly ReactionActorRef[] => {
    if (isLegacyMessageReaction(reaction)) {
      return reaction.reactorIds.map((id, index) => ({
        id,
        displayName: reaction.reactorNames[index] ?? formatMessageRef.current({ id: "message.messageItem.reactorUnknown" }),
      }));
    }
    if (!serverId || !viewerUserId) return reaction.previewK;
    const discussion = messageReactionActorsDiscussion(
      canonicalMessageRef(serverId, message.id),
      reaction.emoji,
      reactionParentScopeKey ?? messageReactionParentScopeKey(serverId, message),
    );
    const cached = selectReactionActors(reactionActorCache, viewerUserId, discussion);
    return cached.status === "loaded" ? cached.entry.actors : reaction.previewK;
  }, [message, reactionActorCache, reactionParentScopeKey, serverId, viewerUserId]);

  const hasCurrentUserReaction = useCallback((emoji: string) => {
    if (!viewerUserId) return false;

    return reactions.some((reaction) => (
      reaction.emoji === emoji
      && isLegacyMessageReaction(reaction)
      && reaction.reactorIds.includes(viewerUserId)
    ));
  }, [
    reactions,
    viewerUserId,
  ]);

  const handleToggleReaction = useCallback(async (emoji: string) => {
    if (
      !viewerUserId
      || !serverId
      || isSystem
      || !canReact
      || pendingReactionEmojisRef.current.has(emoji)
    ) return;
    const alreadyReacted = hasCurrentUserReaction(emoji);
    const previousMessage = message;
    const getCurrentMessage = () => (
      useMessageStore.getState().channelMessages[message.channelId]?.find((cached) => cached.id === message.id)
      ?? message
    );
    const optimisticMessage = buildOptimisticReactionMessage(
      message,
      emoji,
      alreadyReacted,
      viewerUserId,
      viewerReactionName,
      formatMessage({ id: "message.author.unknown" }),
    );
    pendingReactionEmojisRef.current.add(emoji);

    useMessageStore.getState().updateMessage(optimisticMessage);
    try {
      const response = await setMessageReaction({
        serverId,
        messageId: message.id,
        emoji,
        active: !alreadyReacted,
      });
      pendingReactionEmojisRef.current.delete(emoji);
      const currentMessage = getCurrentMessage();
      const reconciledMessage = mergeReactionResponsePreservingPending(
        currentMessage,
        response,
        pendingReactionEmojisRef.current,
      );
      useMessageStore.getState().updateMessage(reconciledMessage);
    } catch (err) {
      console.error("Failed to toggle reaction:", err);
      pendingReactionEmojisRef.current.delete(emoji);
      const currentMessage = getCurrentMessage();
      useMessageStore.getState().updateMessage(replaceReactionForEmoji(currentMessage, previousMessage, emoji));

      setReactionFailureEmoji(emoji);
      if (reactionFailureFlashTimerRef.current) {
        clearTimeout(reactionFailureFlashTimerRef.current);
      }
      reactionFailureFlashTimerRef.current = setTimeout(() => {
        setReactionFailureEmoji(null);
        reactionFailureFlashTimerRef.current = null;
      }, 400);
    } finally {
      pendingReactionEmojisRef.current.delete(emoji);
    }
  }, [
    formatMessage,
    canReact,
    hasCurrentUserReaction,
    isSystem,
    message,
    serverId,
    viewerReactionName,
    viewerUserId,
  ]);

  useEffect(() => () => {
    if (reactionFailureFlashTimerRef.current) {
      clearTimeout(reactionFailureFlashTimerRef.current);
      reactionFailureFlashTimerRef.current = null;
    }
  }, []);

  const clearReactionPickerCloseTimer = useCallback(() => {
    if (reactionPickerCloseTimerRef.current) {
      clearTimeout(reactionPickerCloseTimerRef.current);
      reactionPickerCloseTimerRef.current = null;
    }
  }, []);

  const closeReactionPicker = useCallback(() => {
    clearReactionPickerCloseTimer();
    setReactionPicker(null);
  }, [clearReactionPickerCloseTimer]);

  const scheduleReactionPickerClose = useCallback(() => {
    clearReactionPickerCloseTimer();
    reactionPickerCloseTimerRef.current = setTimeout(() => {
      setReactionPicker(null);
      reactionPickerCloseTimerRef.current = null;
    }, 120);
  }, [clearReactionPickerCloseTimer]);

  const isReactionPickerBoundaryTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !!messageRef.current?.contains(target) || !!target.closest("[data-message-affordance='reaction-picker']");
  }, []);

  const openReactionPicker = useCallback((target: HTMLElement) => {
    positionReactionPickerFromRect(target.getBoundingClientRect());
  }, [positionReactionPickerFromRect]);

  const handleReactionClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCtxMenu(null);
    if (reactionPicker) {
      closeReactionPicker();
    } else {
      openReactionPicker(e.currentTarget as HTMLElement);
    }
  }, [reactionPicker, closeReactionPicker, openReactionPicker]);

  const handleQuickReactionClick = useCallback((emoji: string) => {
    closeReactionPicker();
    setCtxMenu(null);
    setCtxMenuClickShielded(false);
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
    void handleToggleReaction(emoji);
  }, [closeReactionPicker, handleToggleReaction]);

  useEffect(() => {
    const handlePeerPickerOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId !== message.id) closeReactionPicker();
    };
    window.addEventListener(REACTION_PICKER_EVENT, handlePeerPickerOpen);
    return () => window.removeEventListener(REACTION_PICKER_EVENT, handlePeerPickerOpen);
  }, [closeReactionPicker, message.id]);

  useEffect(() => {
    if (!reactionPicker) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-message-affordance='reaction'], [data-message-affordance='reaction-picker']")) return;
      closeReactionPicker();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReactionPicker();
    };
    const handleViewportChange = () => {
      closeReactionPicker();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    // keydown-global-exempt: capture-phase reaction-picker escape, runs before background so focus-on-open not needed
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [closeReactionPicker, reactionPicker]);

  useEffect(() => () => clearReactionPickerCloseTimer(), [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryEnter = useCallback(() => {
    clearReactionPickerCloseTimer();
  }, [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryLeave = useCallback((event: MouseEvent) => {
    if (!reactionPicker) return;
    if (isReactionPickerBoundaryTarget(event.relatedTarget)) return;
    scheduleReactionPickerClose();
  }, [isReactionPickerBoundaryTarget, reactionPicker, scheduleReactionPickerClose]);

  const showReactionPopover = useCallback((
    reaction: NonNullable<Message["reactions"]>[number],
    target: HTMLElement,
  ) => {
    const rect = target.getBoundingClientRect();
    const actors = readReactionActors(reaction);
    const currentViewerReacted = hasCurrentUserReaction(reaction.emoji);
    const reactorNames = currentViewerReacted && viewerUserId
      ? [
        formatMessageRef.current({ id: "message.messageItem.reactorYou" }),
        ...actors.filter((actor) => actor.id !== viewerUserId).map((actor) => actor.displayName),
      ]
      : actors.map((actor) => actor.displayName);
    const visibleNames = reactorNames.slice(0, 5);
    const hiddenCount = Math.max(0, reaction.count - visibleNames.length);

    setReactionPopover({
      emoji: reaction.emoji,
      visibleNames,
      hiddenCount,
      x: rect.left,
      y: rect.bottom + 4,
    });
  }, [hasCurrentUserReaction, readReactionActors, viewerUserId]);

  const hideReactionPopover = useCallback(() => {
    setReactionPopover(null);
  }, []);

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    const channelForLink = parentChannelId || message.channelId;
    const routeKind = navigableChannels.find((channel) => channel.id === channelForLink)?.type === "dm" ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, message.id, {
      routeKind,
      threadParentMessageId: parentMessageId ?? null,
    });
    navigator.clipboard.writeText(url).then(() => {
      setCtxMenu(null);
    });
  }, [serverSlug, parentChannelId, parentMessageId, message.channelId, message.id, navigableChannels]);

  const handleOpenPermalink = useCallback(async (href: string) => {
    let permalink = parseRaftPermalink(href, currentHostname);
    if (!permalink) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    if (serverSlug && permalink.serverSlug !== serverSlug && permalink.routeKind === "channel") {
      const { serverEpoch, current } = useServerStore.getState();
      try {
        const { data } = await api.get<{
          channelId: string;
          targetMessageId: string;
          canonicalTarget?: { kind: string; channelId: string; threadParentMessageId: string };
        }>(`/messages/context/${encodeURIComponent(permalink.messageId)}`, {
          params: { channelId: permalink.channelId },
          headers: { "X-Server-Id": current?.id },
        });
        if (useServerStore.getState().serverEpoch !== serverEpoch) return;
        // The context endpoint authorizes the local projection and returns its
        // canonical navigation target, including reply-to-thread projection.
        const target = data.canonicalTarget;
        permalink = {
          ...permalink,
          serverSlug,
          channelId: target?.kind === "thread" ? target.channelId : data.channelId,
          messageId: data.targetMessageId ?? permalink.messageId,
          threadParentMessageId: target?.kind === "thread" ? target.threadParentMessageId : permalink.threadParentMessageId,
        };
      } catch (error) {
        if (useServerStore.getState().serverEpoch !== serverEpoch) return;
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status !== 404) {
          toast.error(formatMessageRef.current({ id: "message.messageItem.linkResolutionUnavailable" }));
          return;
        }
        // No readable local projection exists. An unrelated workspace link
        // keeps its original destination, whose own access checks still apply.
      }
    }

    if (serverSlug && permalink.serverSlug === serverSlug) {
      if (permalink.threadParentMessageId) {
        nav.toThreadMessage(
          permalink.channelId,
          permalink.threadParentMessageId,
          permalink.messageId,
          permalink.routeKind,
        );
      } else if (permalink.routeKind === "dm") {
        nav.toDmMessage(permalink.channelId, permalink.messageId);
      } else {
        nav.toMessage(permalink.channelId, permalink.messageId);
      }
      return;
    }

    window.open(href, "_blank", "noopener,noreferrer");
  }, [currentHostname, nav, serverSlug]);

  const handleOpenQuotedPermalink = useCallback((permalink: ReturnType<typeof parseRaftPermalink>) => {
    if (!permalink) return;

    if (permalink.threadParentMessageId) {
      if (permalink.routeKind === "dm") {
        nav.toDm(permalink.channelId);
      } else {
        nav.toChannel(permalink.channelId);
      }
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      openThread({
        parentChannelId: permalink.channelId,
        parentMessageId: permalink.threadParentMessageId,
        focusedMessageId: permalink.messageId,
      });
      return;
    }

    requestTransientFocus(permalink.channelId, permalink.messageId);
    if (permalink.routeKind === "dm") {
      nav.toDm(permalink.channelId);
    } else {
      nav.toChannel(permalink.channelId);
    }
  }, [nav, openThread, requestTransientFocus]);

  const handleOpenTaskRef = useCallback(async (taskNumber: number) => {
    const taskContextChannelId = parentChannelId || message.channelId;
    try {
      const { data } = await api.get(`/tasks/channel/${taskContextChannelId}/number/${taskNumber}`);
      const task = (data as { task: Task }).task;
      closeProfile();
      if (task.isLegacy) {
        closeThread();
        nav.toChannel(task.channelId, { chatTab: "tasks" });
        openLegacyTask(task);
        return;
      }
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
    } catch (err) {
      console.error(`Failed to resolve task #${taskNumber}:`, err);
    }
  }, [closeProfile, closeThread, message.channelId, nav, openLegacyTask, openThread, parentChannelId]);

  const handleDownloadAttachment = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    try {
      const { data } = await api.get(`/attachments/${attachment.id}/url?disposition=attachment`);
      const link = document.createElement("a");
      link.href = data.url;
      link.download = attachment.filename;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      // noop: keep attachment card interactive for retry
    }
  }, []);

  const handleOpenHtmlPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("html", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
    });
  }, [message.id, message.channelId, message.senderId, message.senderType]);

  const handleOpenVideoPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("video", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
    });
  }, [message.id, message.channelId, message.senderId, message.senderType]);

  // Stryker disable all: audio open/loading/fallback behavior is covered by audioAttachmentPreview.behavior.test.tsx; remaining handler mutants are stale-concurrent/dependency glue.
  const handleOpenAudioPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("audio", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
      onFallbackDownload: handleDownloadAttachment,
    });
  }, [handleDownloadAttachment, message.id, message.channelId, message.senderId, message.senderType]);
  // Stryker restore all

  const handleOpenDocumentPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    // The shared opener owns fetching and the modal; MessageItem only supplies
    // the one thing it uniquely has — the host message for comments.
    await openDocumentPreview(attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
      onFallbackDownload: handleDownloadAttachment,
    });
  }, [handleDownloadAttachment, message.id, message.channelId, message.senderId, message.senderType]);

  // Single stable open handler for the "other attachments" cards — the
  // image/html/video/document branching used to live in per-item closures.
  const handleOpenAttachmentCard = useCallback((att: NonNullable<Message["attachments"]>[number]) => {
    const isOptimistic = isOptimisticAttachment(att);
    if (isPreviewableImageAttachment(att) && !isOptimistic) {
      const imageIndex = lightboxImages.findIndex((img) => img.id === att.id);
      // No comment contexts: image comments descoped (cindyz 6/11).
      useImageLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
      return;
    }
    if (isPreviewableHtmlAttachment(att) && !isOptimistic) {
      void handleOpenHtmlPreview(att);
      return;
    }
    if (isPreviewableVideoAttachment(att) && !isOptimistic) {
      void handleOpenVideoPreview(att);
      return;
    }
    if (isPreviewableDocumentAttachment(att) && !isOptimistic) {
      void handleOpenDocumentPreview(att);
    }
  }, [lightboxImages, handleOpenHtmlPreview, handleOpenVideoPreview, handleOpenDocumentPreview]);

  const handleOpenForwardedAttachment = useCallback((snapshot: ForwardedBundleAttachmentSnapshot) => {
    if (!snapshot.id) return;
    const attachment: NonNullable<Message["attachments"]>[number] = {
      id: snapshot.id,
      filename: snapshot.filename,
      mimeType: snapshot.mimeType || "application/octet-stream",
      sizeBytes: snapshot.sizeBytes ?? 0,
      width: snapshot.width ?? null,
      height: snapshot.height ?? null,
      thumbnailUrl: null,
    };
    if (isPreviewableImageAttachment(attachment)) {
      useImageLightboxStore.getState().open([attachment], 0);
    } else if (isPreviewableHtmlAttachment(attachment)) {
      void handleOpenHtmlPreview(attachment);
    } else if (isPreviewableVideoAttachment(attachment)) {
      void handleOpenVideoPreview(attachment);
    } else if (isPreviewableAudioAttachment(attachment)) {
      void handleOpenAudioPreview(attachment);
    } else if (isPreviewableDocumentAttachment(attachment)) {
      void handleOpenDocumentPreview(attachment);
    } else {
      void handleDownloadAttachment(attachment);
    }
  }, [handleDownloadAttachment, handleOpenAudioPreview, handleOpenDocumentPreview, handleOpenHtmlPreview, handleOpenVideoPreview]);

  // Close context menu on click outside
  const handleCloseCtx = useCallback(() => {
    setCtxMenu(null);
    closeReactionPicker();
    setCtxMenuClickShielded(false);
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
  }, [closeReactionPicker]);

  const reactionPickerPopupStyle = useMemo(() => reactionPicker
    ? { left: reactionPicker.x, top: reactionPicker.y }
    : undefined, [reactionPicker]);
  const reactionPopoverPopupStyle = useMemo(() => reactionPopover
    ? { left: reactionPopover.x, top: reactionPopover.y }
    : undefined, [reactionPopover]);
  const ctxMenuPopupStyle = useMemo(() => ctxMenu
    ? { left: ctxMenu.x, top: ctxMenu.y, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" as const }
    : undefined, [ctxMenu]);
  const senderCtxMenuPopupStyle = useMemo(() => senderCtxMenu
    ? { left: senderCtxMenu.x, top: senderCtxMenu.y }
    : undefined, [senderCtxMenu]);
  const handleSaveFromMenu = useCallback(() => {
    handleToggleSave();
    setCtxMenu(null);
  }, [handleToggleSave]);
  const handleCopySenderDisplayName = useCallback(() => {
    void navigator.clipboard.writeText(senderDisplayName);
    setSenderCtxMenu(null);
  }, [senderDisplayName]);
  const handleCopySenderHandle = useCallback(() => {
    if (!senderHandleText) return;
    void navigator.clipboard.writeText(senderHandleText);
    setSenderCtxMenu(null);
  }, [senderHandleText]);
  const handleCopyMarkdown = useCallback(() => {
    void navigator.clipboard.writeText(message.content).then(() => setCtxMenu(null));
  }, [message.content]);
  // "Select Message" (image-share) — the three entry modes (channel timeline,
  // thread reply row, thread parent in ThreadPanel) select only what is
  // mounted; the contract stays "what you see is what you share".
  const handleSelectShare = useCallback(() => {
    setCtxMenu(null);
    if (parentMessageId) {
      // Thread reply row → thread mode, clicked reply only.
      const threadCh = message.channelId; // replies live in the thread channel
      enterThreadSelection(
        threadCh,
        parentMessageId,
        parentChannelId || message.channelId,
        [message.id],
      );
      return;
    }
    if (hideThreadActions && message.threadId) {
      enterThreadSelection(message.threadId, message.id, message.channelId, [message.id]);
      return;
    }
    // Channel timeline: just this message. To share a thread the user opens
    // the panel and triggers select from there.
    enterSelection(message.channelId, [message.id]);
  }, [parentMessageId, parentChannelId, message.channelId, message.threadId, message.id, hideThreadActions, enterThreadSelection, enterSelection]);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleViewportChange = () => handleCloseCtx();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [ctxMenu, handleCloseCtx]);

  const updateCtxMenuPosition = useCallback((position: { x: number; y: number }) => {
    setCtxMenu((current) => {
      if (!current) return current;
      if (current.x === position.x && current.y === position.y) return current;
      return { ...current, x: position.x, y: position.y };
    });
  }, []);

  useFloatingOverlayPosition({
    open: Boolean(ctxMenu),
    anchor: ctxMenu ? { x: ctxMenu.anchorX, y: ctxMenu.anchorY } : null,
    floatingRef: ctxMenuRef,
    onPositionChange: updateCtxMenuPosition,
  });

  // System messages: centered, compact, no avatar.
  // Title content is summarized server-side; clamp to a single line as a
  // defense-in-depth so any unexpectedly long body still renders on one line.
  if (isSystem) {
    const systemContentParts = splitReminderReceiptFireAtTokens(message.content);
    const systemContentTitle = formatReminderReceiptContentTitle(message.content, timeFormatOptions);
    return (
      <SystemMessage id={`message-${message.id}`}>
        <SystemMessageTime>{time}</SystemMessageTime>
        <SystemMessageContent>
          <Tooltip content={systemContentTitle}>
          <span>
          {systemContentParts.map((part, index) => (
            part.type === "reminderFireAt" ? (
              <Tooltip key={`${part.value}-${index}`} content={formatReminderReceiptTooltip(part.value, timeFormatOptions)}>
              <span>
                {formatReminderReceiptTime(part.value, formatMessage, new Date(), timeFormatOptions)}
              </span>
              </Tooltip>
            ) : (
              part.value
            )
          ))}
          </span>
          </Tooltip>
        </SystemMessageContent>
      </SystemMessage>
    );
  }

  return (
    <>
    <MessageItem
      ref={messageRef}
      id={`message-${message.id}`}
      onClick={readOnlyProjection ? undefined : handleMobileTap}
      onContextMenu={readOnlyProjection ? undefined : handleContextMenu}
      onTouchStart={readOnlyProjection ? undefined : handleTouchStart}
      onTouchEnd={readOnlyProjection ? undefined : handleTouchEnd}
      onTouchMove={readOnlyProjection ? undefined : handleTouchMove}
      onMouseEnter={handleReactionPickerBoundaryEnter}
      onMouseLeave={handleReactionPickerBoundaryLeave}
      compact={!showSelectedGroupedHeader}
      data-popup-open={ctxMenu || reactionPicker ? "" : undefined}
      data-selected={isSelectedAsThreadParent || isSelected ? "true" : undefined}
      data-selection-active={selectionScopedHere ? "true" : undefined}
      data-highlighted={isHighlighted ? "true" : undefined}
      data-followed-by={followedBy}
      data-follows-system={followsSystem ? "true" : undefined}
      // The message you jumped to is the DS cyan-soft wash; an open menu or
      // picker needs nothing here: rui's data-popup-open state tints the row
      // the same way hover does (task #694).
      className={`${isHighlighted
 ? "bg-info-soft hover:bg-info-soft"
 : ""} ${messageBodyFontSize === "lg" ? "[--mi-avatar:2.125rem]" : ""} ${className ?? ""}`.trim()}
    >
      {selectionScopedHere && (
        <MessageMultiSelectCheckbox
          // v1.5 (huxijin 2026-05-01): was `self-center`, which dropped the
          // circle into the vertical middle of the row. On long messages
          // this sits far below the viewport's top edge and users lose
          // track of which message they're toggling. Pin to the top row
          // (`self-start`) at avatar height so the indicator is always
          // visible alongside the sender name.
          checked={isSelected}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none self-start mt-1.5"
          data-testid={`message-select-circle-${message.id}`}
        />
      )}
      {/* Hover action toolbar — the "骑线按钮组" pill. Extracted into its own
          component (stdrc). */}
      {!readOnlyProjection ? <MessageHoverToolbar
        isSaved={isSaved}
        reactionActive={!!reactionPicker}
        hideThreadActions={hideThreadActions}
        isSystem={isSystem}
        canReact={canReact}
        onReplyInThread={handleReplyInThread}
        onReactionClick={handleReactionClick}
        onToggleSave={handleToggleSave}
      /> : null}
      {showSelectedGroupedHeader ? (
        <MessageItemGutter>
          {/* flex + items-start: the slot is otherwise a block box whose lone
              inline-block avatar button baseline-aligns; the agent avatar's
              status-dot badge drops that baseline and sinks the agent avatar
              ~9px below the human one. Flex items are blockified, so both
              kinds sit at margin-top only. (rui#305 may later move this into
              the recipe; the override stays harmless.) */}
          <MessageItemAvatarSlot className="flex items-start">
            <MessageSenderAvatar
          showAgent={isAgent && (!!senderAgent || !!readOnlySender)}
          showExternal={isExternal}
          isDeactivatedAgent={isDeactivatedAgent}
          senderId={message.senderId}
          agentAvatarUrl={agentAvatarUrl}
          avatarUrl={humanAvatarUrl}
          gravatarHash={senderMember?.gravatarHash}
          email={senderEmailForAvatar}
          hoverAgent={readOnlyProjection ? undefined : senderAgent}
          hoverMember={readOnlyProjection ? undefined : senderMember}
          readOnlySender={readOnlyProjection ? readOnlySender : undefined}
          externalAvatarUrl={externalAvatarUrl}
          externalDisplayName={senderDisplayName}
          externalProvider={isExternal ? message.externalAuthor?.provider ?? null : null}
          externalWorkspaceName={isExternal ? message.externalAuthor?.workspaceName ?? null : null}
          externalActorKind={isExternal ? message.externalAuthor?.actorKind ?? null : null}
          testId={senderAvatarTestId}
          onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
          onNavigateAgentActivity={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgentActivity}
          onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
          onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternal}
          onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
          onLongPressMention={!readOnlyProjection && senderMention ? insertSenderMention : undefined}
            />
          </MessageItemAvatarSlot>
        </MessageItemGutter>
      ) : (
        // Continuation row (task #44): reserve the avatar column so the body
        // stays aligned with grouped rows above, and show this message's clock
        // (HH:MM) in that gutter — every message keeps a visible timestamp
        // (stdrc), aligned in a consistent left column instead of the header.
        <MessageItemGutter>
          <Tooltip content={gutterFullTimestamp}>
          <MessageItemContinuationTime
            // No transition — the time reveals instantly on hover, like the row
            // border (stdrc: 时间不要动画呈现，跟边框一样立即出现). The DS
            // treatment (Space Mono 12, ink-3 on row hover) is the recipe's.
          >
            {gutterClock}
          </MessageItemContinuationTime>
          </Tooltip>
        </MessageItemGutter>
      )}
      <MessageItemContent>
        {groupState?.showName === false && !showSelectedGroupedHeader ? null : (
          <MessageItemHeader>
          {/* The font-preference size classes carry no line-height and would
              displace the recipe's own leading in the merge, so each header
              text re-asserts its DS leading right after the size (name 20,
              role/model/time 16). */}
          {/* Left cluster: name · [model · badges · description]. Space is
              given up in this order: description, then model, then name
              (Artea, task #743). The name never shrinks while the tail has
              room; it only truncates at max-w-full when it alone is wider than
              the cluster. The tail is a nested flex box so the name gets NO
              share of the shrink — a weighted shrink (shrink vs shrink-[999])
              still shaves a sub-pixel off the name and shows "C…". The time
              and status stay OUTSIDE the cluster, so a narrow panel can never
              clip them. */}
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {senderMention ? (
            <Tooltip content={formatMessage({ id: "message.messageItem.mentionSender" }, { name: senderMention.name })}>
            <MessageItemSenderButton
              className={`max-w-full shrink-0 ${messageNameSizeClass} leading-5`}
              onClick={handleSenderNameMention}
              onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
              data-testid={`message-sender-mention-${message.id}`}
            >
              {senderDisplayName}
            </MessageItemSenderButton>
            </Tooltip>
          ) : (
            <MessageItemSender
              className={`max-w-full shrink-0 ${messageNameSizeClass} leading-5`}
              onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
            >
              {senderDisplayName}
            </MessageItemSender>
          )}
          <span data-testid={`message-sender-tail-${message.id}`} className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {agentModelLabelText && (
            <Tooltip content={agentModelLabelText}>
            <MessageItemMeta
              render={<span />}
              className={`min-w-0 max-w-full shrink-0 truncate ${messageMetaSizeClass} leading-4`}
              data-testid={`message-sender-model-${message.id}`}
            >
              {agentModelLabelText}
            </MessageItemMeta>
            </Tooltip>
          )}
          {isDeactivatedAgent && (
            <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-chip bg-fill-muted px-1.5 text-caption font-semibold text-foreground-muted">
              {formatMessage({ id: "message.messageItem.deletedBadge" })}
            </span>
          )}
          {humanDepartureLabel && (
            <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-chip bg-fill-muted px-1.5 text-caption font-semibold text-foreground-muted">
              {humanDepartureLabel}
            </span>
          )}
          {senderSubtitle && (
            <Tooltip content={senderSubtitle}>
            <MessageItemMeta
              render={<span />}
              className={`min-w-0 shrink truncate ${messageMetaSizeClass} leading-4`}
            >
              {senderSubtitle}
            </MessageItemMeta>
            </Tooltip>
          )}
          </span>
          </span>
          <MessageItemTime render={<span />} className={`shrink-0 whitespace-nowrap ${messageMetaSizeClass} leading-4`}>{time}</MessageItemTime>
          {converting && (
            <MessageItemInlineStatus render={<span />}>
              {formatMessage({ id: "message.messageItem.converting" })}
            </MessageItemInlineStatus>
          )}
          </MessageItemHeader>
        )}
        <AttachmentCommentRefChip
          commentRef={message.commentRef}
          commentsEnabled={commentsEnabled}
          onJumpToHost={handleJumpToCommentHost}
          bodyFontSizeClass={messageBodyFontSizeClass}
        />
        {isReplyQuote && quotedPermalink && !quotedPermalinkUnavailable ? (
          <div className="mb-2">
            <QuotedMessagePermalinkPreview
              compact
              permalink={quotedPermalink.parsed}
              onOpen={handleOpenQuotedPermalink}
              onUnavailable={handleQuotedPermalinkUnavailable}
            />
          </div>
        ) : null}
        <CollapsibleMessageContent
          key={message.id}
          messageId={message.id}
          measurementKey={message.randomId ?? message.id}
          measureBeforePaint={message.id.startsWith("optimistic-")}
          disabled={isActionCardMessage || !!forwardedBundleMetadata || !collapseLongMessages}
        >
        <MessageItemBody
          ref={messageBodyRef}
          data-message-selectable="true"
          data-message-id={message.id}
          data-quote-channel-id={quoteComposerChannelId}
          data-message-font-size={messageBodyFontSize}
          className={`${messageBodyFontSizeClass}${followedBy && !inlineReplySurfaceReplacesBadge ? " group-data-[followed-by]/message:mb-0 group-data-[followed-by]/message:[&>:last-child]:mb-0 group-data-[followed-by]/message:[&>:last-child>:last-child]:mb-0 group-data-[followed-by]/message:[&>:last-child>:last-child_li:last-child]:mb-0 group-data-[followed-by]/message:[&>:last-child>:last-child:has(pre)]:mb-px" : ""}`}
          style={messageBodyFontSizeStyle}
        >
          {(() => {
            // Operation card (B-mode): the message body IS the card. Skip
            // markdown rendering and inline the structured card from
            // `actionMetadata`.
            if (isActionCardMessage) {
              return (
                <ActionCard
                  messageId={message.id}
                  metadata={message.actionMetadata as ActionCardMetadata}
                  channelId={message.channelId}
                />
              );
            }
            if (isTranslationPending) {
              return (
                <Skeleton
                  variant="line"
                  className="inline-block w-44 max-w-full align-middle"
                  data-testid={`message-translation-placeholder-${message.id}`}
                />
              );
            }
            return (
              <MessageMarkdownBody
                readReceiptChannelId={message.channelId}
                readReceiptMessageSeq={message.seq}
                readReceiptEnabled={agentReadBadgesEnabled}
                content={forwardedBundleBodyContent}
                channels={navigableChannels}
                mentionMap={effectiveMentionMap}
                structuredMentionMap={effectiveStructuredMentionMap}
                channelParticipantAgentsById={channelParticipantAgentsById}
                channelParticipantMembersById={channelParticipantMembersById}
                channelParticipantExternalsById={channelParticipantExternalsById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={readOnlyProjection ? onReadOnlyNavigateChannel ?? ignoreReadOnlyProjectionNavigation : handleNavigateChannel}
                onNavigateDm={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateDm}
                onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
                onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
                onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternalMention}
                onNavigateComputer={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateComputer}
                onOpenThread={readOnlyProjection ? undefined : handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={readOnlyProjection ? undefined : handleOpenTaskRef}
                onOpenMessage={readOnlyProjection ? undefined : handleOpenMessageRef}
                onOpenPermalink={readOnlyProjection ? undefined : handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={readOnlyProjection || threadRefAuthorityUnavailable}
                knownTaskNumbers={knownTaskNumbers}
                taskByNumber={taskByNumber}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
                mentionsDisplayOnly={readOnlyProjection}
              />
            );
          })()}
        </MessageItemBody>
        {showBilingualOriginal ? (
          <MessageItemTranslationOriginal
            className="mt-1.5"
            data-testid={`message-translation-bilingual-original-${message.id}`}
          >
            <MessageItemTranslationOriginalLabel>
              {formatMessage({ id: "message.messageItem.bilingualOriginal" })}
            </MessageItemTranslationOriginalLabel>
            <div
              className={`${messageBodyFontSizeClass} break-words select-text [&_*]:select-text`}
              style={getMessageBodyFontSizeStyle(messageBodyFontSize)}
            >
              <MessageMarkdownBody
                readReceiptChannelId={message.channelId}
                readReceiptMessageSeq={message.seq}
                readReceiptEnabled={agentReadBadgesEnabled}
                content={bilingualOriginalContent}
                channels={navigableChannels}
                mentionMap={effectiveMentionMap}
                structuredMentionMap={effectiveStructuredMentionMap}
                channelParticipantAgentsById={channelParticipantAgentsById}
                channelParticipantMembersById={channelParticipantMembersById}
                channelParticipantExternalsById={channelParticipantExternalsById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={readOnlyProjection ? onReadOnlyNavigateChannel ?? ignoreReadOnlyProjectionNavigation : handleNavigateChannel}
                onNavigateDm={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateDm}
                onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
                onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
                onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternalMention}
                onNavigateComputer={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateComputer}
                onOpenThread={readOnlyProjection ? undefined : handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={readOnlyProjection ? undefined : handleOpenTaskRef}
                onOpenMessage={readOnlyProjection ? undefined : handleOpenMessageRef}
                onOpenPermalink={readOnlyProjection ? undefined : handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={readOnlyProjection || threadRefAuthorityUnavailable}
                knownTaskNumbers={knownTaskNumbers}
                taskByNumber={taskByNumber}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
                mentionsDisplayOnly={readOnlyProjection}
              />
            </div>
          </MessageItemTranslationOriginal>
        ) : null}
        {forwardedBundleMetadata ? (
          <div className="mt-1.5">
            <ForwardedBundleRouteCard
              messageId={message.id}
              metadata={forwardedBundleMetadata}
              onOpenSource={handleOpenForwardedSource}
              onOpenAttachment={handleOpenForwardedAttachment}
            />
          </div>
        ) : null}
        {!readOnlyProjection && !isReplyQuote && quotedPermalink && !quotedPermalinkUnavailable ? (
          <div className="mt-1.5">
            <QuotedMessagePermalinkPreview
              permalink={quotedPermalink.parsed}
              onOpen={handleOpenQuotedPermalink}
              onUnavailable={handleQuotedPermalinkUnavailable}
            />
          </div>
        ) : null}
        </CollapsibleMessageContent>
        {/* Attached files */}
        {readOnlyProjection && message.attachments && message.attachments.length > 0 ? (
          <ReadOnlyMessageAttachments attachments={message.attachments} />
        ) : null}
        {!readOnlyProjection && !forwardedBundleMetadata && message.attachments && message.attachments.length > 0 && (() => {
          return renderWithImageInlineFallback(imageFallbackKey, (imageFallbackUrls) => {
            // Stryker disable all: pre-existing attachment classification moved under the fallback seam.
            if (!message.attachments) return null;
            const renderedImages = imagePreviewAttachments.filter((att) => !!getImageGalleryPreviewSrc(att, imageFallbackUrls));
            const imageRows = buildMessageImageGalleryRows(renderedImages);
            const videoAttachments = message.attachments.filter((att) => isPreviewableVideoAttachment(att));
            const audioAttachments = message.attachments.filter((att) => isPreviewableAudioAttachment(att));
            const otherAttachments = message.attachments.filter((att) => {
              if (!isPreviewableImageAttachment(att)) return true;
              return shouldRenderImageAsAttachmentChip(att, imageFallbackUrls);
            }).filter((att) => !isPreviewableVideoAttachment(att) && !isPreviewableAudioAttachment(att));
            // Stryker restore all

          return (
            <div className="mt-1 space-y-2">
              {/* Josh's ending matrix: image-terminated rows sit 1px short of
                  the rhythm; same one-pixel knife as the reply card (#9444). */}
              {imageRows.length > 0 && (
                <MessageImageGallery className="group-data-[followed-by]/message:mb-px">
                  {imageRows.map((row, rowIndex) => (
                    <MessageImageGalleryRow
                      key={`${row.items.map((item) => renderedImages[item.index].id).join("-")}-${rowIndex}`}
                      row={row}
                    >
                      {row.items.map((item) => {
                        const att = renderedImages[item.index];
                        const previewSrc = getImageGalleryPreviewSrc(att, imageFallbackUrls);
                        if (!previewSrc) return null;
                        return (
                          <GalleryImageItem
                            key={att.id}
                            att={att}
                            previewSrc={previewSrc}
                            isOptimistic={isOptimisticAttachment(att)}
                            imageIndex={lightboxImages.findIndex((img) => img.id === att.id)}
                            lightboxImages={lightboxImages}
                            layout={item}
                            onDownload={handleDownloadAttachment}
                          />
                        );
                      })}
                    </MessageImageGalleryRow>
                  ))}
                </MessageImageGallery>
              )}
              {videoAttachments.length > 0 && (
                <div className="space-y-2 group-data-[followed-by]/message:mb-px">
                  {videoAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    return (
                      <InlineVideoAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onOpenPreview={handleOpenVideoPreview}
                        onDownload={handleDownloadAttachment}
                      />
                    );
                  })}
                </div>
              )}
              {audioAttachments.length > 0 && (
                <div className="space-y-2">
                  {audioAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    return (
                      <InlineAudioAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onDownload={handleDownloadAttachment}
                      />
                    );
                  })}
                </div>
              )}
              {otherAttachments.length > 0 && (
                <MessageAttachmentGroup className="max-w-[22.5rem] group-data-[followed-by]/message:mb-px">
                  {otherAttachments.map((att) => {
                    const isImage = isPreviewableImageAttachment(att);
                    const isHtml = isPreviewableHtmlAttachment(att);
                    const isVideo = isPreviewableVideoAttachment(att);
                    const isOptimistic = isOptimisticAttachment(att);
                    const isHtmlLoading = htmlPreviewLoadingId === att.id || videoPreviewLoadingId === att.id || documentPreviewLoadingId === att.id;
                    return (
                      <AttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        isHtml={isHtml}
                        isImage={isImage}
                        isVideo={isVideo}
                        isAudio={false}
                        isHtmlLoading={isHtmlLoading}
                        onClick={handleOpenAttachmentCard}
                        onDownload={handleDownloadAttachment}
                      />
                    );
                  })}
                </MessageAttachmentGroup>
              )}
	            </div>
	          );
	          });
	        })()}
        {activeTranslationEntry && shouldRenderTranslationIndicator(activeTranslationEntry) ? (
	          <div className="mt-0">
	            <TranslationIndicator
	              entry={activeTranslationEntry}
	              showOriginal={activeTranslationShowOriginal}
	              onToggleOriginal={handleToggleTranslationOriginal}
	              onRetry={handleRetryTranslation}
	              onUpgrade={handleUpgradePlan}
	            />
	          </div>
	        ) : null}
        {/* Footer metadata/actions — below translation status and the full message content block. */}
        {(
          // Stryker disable all: footer badge visibility/editability behavior is pre-existing; this PR only swaps Badge chrome to raft-ui.
          linkedTask ||
          isSaved ||
          visibleReactions.length > 0 ||
          hasThreadFooterMetadata
          // Stryker restore all
        ) ? (
          // The footer can end a message (saved marker, reactions) — same
          // one-pixel knife as the other short endings (Josh's matrix).
          <MessageItemFooter className="mt-1.5 flex flex-wrap items-center gap-1.5 group-data-[followed-by]/message:mb-px">
            {linkedTask && (() => {
              const fullLabel = linkedTask.claimedByName ? `task #${linkedTask.taskNumber} @${linkedTask.claimedByName}` : `task #${linkedTask.taskNumber}`;
              const assignee = linkedTask.claimedByName
                ? taskAssigneeHandle(linkedTask.claimedByName)
                : null;
              // Source of truth: rui's task-status appearance (the legacy
              // inline STATUS_BADGE_CONFIG was removed — the footer chip is rui's
              // `TaskChip`, coloured from the same `task-status-*` tokens as
              // every other surface).
              // Before this dedup, the below-content variant had its own
              // inline 4-entry config (no `closed`) and silently fell
              // through to todo styling for closed tasks — see
              // #proj-uiux:c697be7a (task #141). PR #1464 (task #145)
              // separately swapped closed from brutal-red to brutal-stone;
              // both fixes converge in STATUS_BADGE_CONFIG.
              //
              // Placement contract: task status is footer metadata, not sender
              // identity. Keep it below content alongside replies instead of
              // crowding the message header.
              // Stryker disable next-line all: editability behavior is pre-existing; this PR only swaps badge chrome.
              // The badge is a REFERENCE to the task, so it does the two things
              // a reference does: identify it and open it. It used to double as
              // an inline status dropdown, which made the same pixel mean
              // "change status" here and "open the task" everywhere else.
              // Status editing lives in the modal's Properties region; quick
              // completion stays on the message context menu. (@stdrc)
              return (
                <Tooltip content={fullLabel}>
                <button
                  type="button"
                  onClick={openLinkedTask}
                  className="inline-flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap"
                  aria-label={formatMessage({ id: "task.chip.openAria" }, { taskNumber: linkedTask.taskNumber, title: linkedTask.title })}
                  data-message-affordance="open-linked-task"
                >
                  <TaskChip
                    status={toRuiTaskStatus(linkedTask.status)}
                    data-testid="message-task-badge"
                    data-task-status={linkedTask.status}
                  >
                    <TaskStatusIcon status={toRuiTaskStatus(linkedTask.status)} />
                    <span className="shrink-0">{taskNumberSigil(linkedTask.taskNumber)}</span>
                    {assignee}
                  </TaskChip>
                </button>
                </Tooltip>
              );
            })()}
            {isSaved ? (
              <MessageItemSavedIndicator
                render={<button type="button" />}
                data-message-affordance="saved-badge"
                aria-label={formatMessage({ id: "message.messageItem.removeFromSaved" })}
                onClick={handleSavedIndicatorClick}
              >
                <Bookmark size={10} fill="currentColor" className="shrink-0" />
                <span className="shrink-0">{formatMessage({ id: "message.messageItem.saved" })}</span>
              </MessageItemSavedIndicator>
            ) : null}
            {shouldShowThreadRepliesBadge ? (
              <ThreadRepliesBadge
                replyCount={threadReplyCount}
                unreadCount={threadUnreadCount}
                hasDraft={hasThreadDraft}
                onClick={handleOpenThreadReplies}
              />
            ) : null}
            {visibleReactions.map((reaction) => {
              const currentViewerReacted = hasCurrentUserReaction(reaction.emoji);
              const showFailureFlash = reactionFailureEmoji === reaction.emoji;
              const summaryNames = readReactionActors(reaction).map((actor) => actor.displayName);
              const summaryHiddenCount = Math.max(0, reaction.count - summaryNames.length);
              const reactorSummary = summaryNames.length > 0
                ? `${summaryNames.join(", ")}${summaryHiddenCount > 0 ? ` ${formatMessage({ id: "message.messageItem.reactionHiddenMore" }, { count: summaryHiddenCount })}` : ""}`
                : formatMessage({ id: "message.messageItem.reactionCount" }, { count: reaction.count });
              const reactionContent = (
                <>
                  <span className="inline-flex items-center leading-none">
                    <ReactionGlyph emoji={reaction.emoji} size={16} className="block" />
                  </span>
                  <ReactionCount count={reaction.count} />
                </>
              );
              // DS reaction: a 24px chip on fill-muted; yours is pink-soft; a
              // failed toggle flashes the orange-soft problem wash.
              const reactionClassName = `inline-flex h-6 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-chip pl-1.5 pr-2 text-callout leading-none text-foreground ${
                showFailureFlash
                  ? "bg-warning-soft"
                  : currentViewerReacted
                    ? "bg-attention-soft"
                    : "bg-fill-muted"
              }`;
              return (
                <span key={reaction.emoji} className="inline-flex">
                  {canReact ? (
                    <button
                      type="button"
                      onClick={() => {
                        hideReactionPopover();
                        void handleToggleReaction(reaction.emoji);
                      }}
                      onMouseEnter={(event) => showReactionPopover(reaction, event.currentTarget)}
                      onMouseLeave={hideReactionPopover}
                      onFocus={(event) => showReactionPopover(reaction, event.currentTarget)}
                      onBlur={hideReactionPopover}
                      className={`${reactionClassName} outline-none hover:press-overlay active:press-overlay focus-visible:shadow-focus`}
                      aria-label={formatMessage({ id: "message.messageItem.reactionAria" }, { emoji: reaction.emoji, reactors: reactorSummary })}
                    >
                      {reactionContent}
                    </button>
                  ) : (
                    <span
                      className={reactionClassName}
                      aria-label={formatMessage({ id: "message.messageItem.reactionAria" }, { emoji: reaction.emoji, reactors: reactorSummary })}
                    >
                      {reactionContent}
                    </span>
                  )}
                </span>
              );
            })}
              {!isSystem && canReact && visibleReactions.length > 0 ? (
                <span className="inline-flex md:hidden">
                  <Tooltip content={formatMessage({ id: "message.messageItem.addReaction" })}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      hideReactionPopover();
                      setCtxMenu(null);
                      if (reactionPicker) {
                        closeReactionPicker();
                      } else {
                        openReactionPicker(event.currentTarget);
                      }
                    }}
                    className="inline-flex h-6 min-w-0 items-center justify-center rounded-chip bg-fill-muted px-1.5 text-foreground-muted outline-none hover:press-overlay active:press-overlay focus-visible:shadow-focus"
                    aria-label={formatMessage({ id: "message.messageItem.addReaction" })}
                    data-message-affordance="mobile-reaction-add"
                  >
                    <Plus size={16} strokeWidth={2} />
                  </button>
                  </Tooltip>
                </span>
              ) : null}
          </MessageItemFooter>
        ) : null}
        {/* Inside the Thread panel the replies ARE the surface — previewing them
            on the parent is redundant (artin, #proj-message:a18243dc). */}
        {replyScope && !hideThreadActions ? (
          <InlineThreadReplies
            replies={replyScope.replies}
            replyCount={replyScope.replyCount}
            unreadCount={threadUnreadCount}
            hasDraft={hasThreadDraft}
            onOpenThread={handleOpenThreadReplies}
            channelParticipantAgentsById={channelParticipantAgentsById}
            channelParticipantMembersById={channelParticipantMembersById}
          />
        ) : null}
        {showDmReadReceipt ? (
          // artin (option C): a status line under the DM's last message, below
          // everything the message owns (footer, inline thread replies), like
          // iMessage's "Read". Its own row, right-aligned.
          <div className="mt-1 flex h-5 justify-end" data-testid="dm-read-status">
            <Tooltip content={formatMessage({ id: "message.messageItem.read" })}>
            <span
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-foreground-hint"
              data-message-affordance="read-receipt"
              aria-label={formatMessage({ id: "message.messageItem.read" })}
            >
              <CheckCircle size={12} className="shrink-0" />
              <span>{formatMessage({ id: "message.messageItem.read" })}</span>
            </span>
            </Tooltip>
          </div>
        ) : null}
        {/* Parked, not dead. A message can hold exactly one task today
            (`uniqueIndex` on `tasks.message_id`) and its title is not editable
            yet, so a list of one row earns nothing over the status badge —
            @stdrc msg=9b8763dd / aa662414. Kept wired and ready because the
            endgame is many tasks per message, at which point this is the shape
            and the badge is not. Do not delete as cruft. */}
        {/* <TaskChipList tasks={messageTasks} onOpenTask={openTaskFromChip} /> */}
      </MessageItemContent>
    </MessageItem>
    {reactionPicker && typeof document !== "undefined" && createPortal(
      <PopoverPopup
        className="fixed z-[80] min-w-0 flex items-center gap-0.5 px-1.5 py-1"
        data-message-affordance="reaction-picker"
        {...dismissLayerProps}
        style={reactionPickerPopupStyle}
        onMouseEnter={handleReactionPickerBoundaryEnter}
        onMouseLeave={handleReactionPickerBoundaryLeave}
        onClick={stopClickPropagation}
      >
        {QUICK_REACTION_EMOJIS.map((emoji) => (
          <Tooltip key={emoji} content={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}>
          <button
            type="button"
            onClick={() => handleQuickReactionClick(emoji)}
            className="flex size-7 items-center justify-center rounded-control bg-transparent outline-none hover:bg-brand-soft active:bg-brand-soft focus-visible:shadow-focus"
          >
            <ReactionGlyph emoji={emoji} size={QUICK_REACTION_GLYPH_SIZE} className="block" />
          </button>
          </Tooltip>
        ))}
      </PopoverPopup>,
      document.body,
    )}
    {reactionPopover && typeof document !== "undefined" && createPortal(
        <PopoverPopup
        role="tooltip"
        data-message-affordance="reaction-reactors-popover"
        className="pointer-events-none fixed z-[80] min-w-0 max-w-[280px] px-2.5 py-1.5 text-footnote font-semibold text-foreground"
        style={reactionPopoverPopupStyle}
      >
        {reactionPopover.visibleNames.length > 0 ? (
          <div className="flex max-w-60 flex-wrap items-center gap-y-0.5">
            {reactionPopover.visibleNames.map((name, index) => (
              <span key={`${reactionPopover.emoji}-${index}-${name}`} className="inline-flex min-w-0 items-baseline leading-5">
                <span className="max-w-28 truncate">{name}</span>
                {index < reactionPopover.visibleNames.length - 1 || reactionPopover.hiddenCount > 0 ? (
                  <span className="shrink-0 text-foreground-hint">, </span>
                ) : null}
              </span>
            ))}
            {reactionPopover.hiddenCount > 0 && (
              <span className="leading-5 text-foreground-muted">{formatMessage({ id: "message.messageItem.reactionHiddenMore" }, { count: reactionPopover.hiddenCount })}</span>
            )}
          </div>
        ) : (
          <span className="block leading-5">{reactionPopover.emoji}</span>
        )}
      </PopoverPopup>,
      document.body,
    )}
    {ctxMenu && createPortal(
      <>
        <DismissBackdrop onDismiss={handleCloseCtx} trapContextMenu />
        {ctxMenuClickShielded && (
          // Above the dismiss backdrop (50) but below the menu (z-[60]) so
          // it absorbs the iOS phantom outside-tap without blocking menu rows.
          <DismissBackdrop onDismiss={handleCloseCtx} zIndex={55} stopPropagation />
        )}
        <ContextMenuPopup
          ref={ctxMenuRef}
          className="fixed z-[60] select-none"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.messageContextMenu" })}
          style={ctxMenuPopupStyle}
        >
          <>
          {/* Reaction quick row — shown on both desktop right-click ("pointer")
              and mobile long-press ("touch") per stdrc 2026-05-14
              #proj-mobile:a8293493 msg=2cebeb18: "无论是移动端还是桌面端，其右
              键菜单和长按菜单都应该补上这个 reaction，也就是说移动端和桌面端
              的菜单保持一致". Previously gated on `ctxMenu.source === "touch"`
              (mobile-only). Visual separator below is a standalone
              `<ContextMenuDivider />` matching the other in-menu section
              dividers (CLAUDE.md "Menu dividers" token) — the row itself
              no longer carries `border-b
              border-black/20` because that produced a thinner, lighter
              line than other section dividers in the same menu (stdrc
              msg=ed2eee8c "只要一样就行，说白了就分 section"). */}
          {!isSystem && canReact && (
            <>
              <div
                className="flex h-9 items-center gap-1 px-2"
                data-message-affordance="reaction-quick-row"
              >
                {QUICK_REACTION_EMOJIS.map((emoji) => (
                  <Tooltip key={emoji} content={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleQuickReactionClick(emoji);
                    }}
                    className="flex size-7 items-center justify-center rounded-control bg-transparent outline-none hover:bg-brand-soft active:bg-brand-soft focus-visible:shadow-focus"
                    aria-label={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}
                  >
                    <ReactionGlyph emoji={emoji} size={QUICK_REACTION_GLYPH_SIZE} className="block" />
                  </button>
                  </Tooltip>
                ))}
              </div>
              <ContextMenuDivider />
            </>
          )}
          <MenuItem
            icon={<Link size={14} />}
            onClick={handleCopyLink}
          >
            {formatMessage({ id: "message.messageItem.copyLink" })}
          </MenuItem>
          <MenuItem
            icon={<Copy size={14} />}
            onClick={handleCopyMarkdown}
          >
            {formatMessage({ id: "message.messageItem.copyMarkdown" })}
          </MenuItem>
          {showManualTranslationAction ? (
            <MenuItem
              icon={<Languages size={14} />}
              onClick={handleManualTranslate}
              disabled={manualTranslationPending}
              data-testid={`message-translate-menu-item-${message.id}`}
            >
              {formatMessage({
                id: manualTranslationPending
                  ? "message.messageItem.translating"
                  : "message.messageItem.translate",
              })}
            </MenuItem>
          ) : null}
          {(() => {
            // "Select Message" — last item in the outbound-content-propagation
            // section (Copy link → Copy markdown → Select Message), in
            // ascending "weight" of what gets propagated: pointer →
            // content → multi-message render+send. Was previously
            // a standalone section above Copy link; relocated to this
            // section per stdrc 2026-05-14 #proj-mobile:a8293493
            // msg=ad3320ce ("share messages 可能应该放到 copy markdown
            // 下面，并且跟 copy markdown 在同一个 section 里面").
            //
            // Three entry points for "Select Message":
            //  1. Channel timeline (top-level row, not in a panel) → channel
            //     mode with just this message pre-selected. Auto-including
            //     thread replies here would lie about what the PNG can
            //     render (replies aren't in the DOM until the thread panel
            //     is open), so we keep the contract honest: what you see is
            //     what you share. Thread auto-include is reserved for thread
            //     mode where ThreadPanel guarantees the replies are mounted.
            //  2. Thread reply row (parentMessageId is set) → thread mode,
            //     anchored at the reply's parent, with only the clicked row
            //     selected. ThreadPanel exposes a Select all button for the
            //     full parent + replies export.
            //  3. Thread parent rendered inside ThreadPanel
            //     (`hideThreadActions` plus a non-empty `threadId` on the
            //     parent) → thread mode, anchored at this message, with only
            //     the parent selected.
            // System messages cannot be selected. Guests also cannot enter
            // the image-share flow because it persists a public artifact;
            // their server-side role check remains the authoritative guard.
            if (isSystem || currentUserServerRole === "guest") return null;
            return (
              <MenuItem
                icon={<CheckCircle size={14} />}
                onClick={handleSelectShare}
              >
                {formatMessage({ id: "message.messageItem.selectMessage" })}
              </MenuItem>
            );
          })()}
          <ContextMenuDivider />
          {!hideThreadActions && (
            <MenuItem
              icon={<ThreadIcon width={14} height={14} />}
              onClick={handleOpenThreadFromContextMenu}
            >
              {formatMessage({ id: "message.messageItem.openThread" })}
            </MenuItem>
          )}
          <MenuItem
            icon={isSaved ? <BookmarkMinus size={14} /> : <Bookmark size={14} />}
            onClick={handleSaveFromMenu}
          >
            {isSaved ? formatMessage({ id: "message.messageItem.removeFromSaved" }) : formatMessage({ id: "message.messageItem.saveMessage" })}
          </MenuItem>
          {canShowThreadFollowAction && hasThreadConversation && (
            <MenuItem
              icon={threadFollowed ? <MessageCircleOff size={14} /> : <MessageCirclePlus size={14} />}
              onClick={threadFollowed ? handleUnfollowThread : handleFollowThread}
            >
              {threadFollowed ? formatMessage({ id: "message.messageItem.unfollowThread" }) : formatMessage({ id: "message.messageItem.followThread" })}
            </MenuItem>
          )}
          {canShowThreadFollowAction && hasThreadConversation && (
            <ContextMenuDivider />
          )}
          {!parentMessageId && supportsMessageTasks && (
            !isExternal ? (linkedTask ? (
              <>
                <MenuItem
                  icon={linkedTask.status === "done" ? <RotateCcw size={14} /> : <CheckCircle size={14} />}
                  onClick={handleToggleTaskDone}
                >
                  {linkedTask.status === "done" ? formatMessage({ id: "message.messageItem.reopenTask" }) : formatMessage({ id: "message.messageItem.markAsDone" })}
                </MenuItem>
              </>
            ) : (
              <MenuItem
                icon={<ClipboardCheck size={14} />}
                onClick={handleConvertToTask}
              >
                {formatMessage({ id: "message.messageItem.convertToTask" })}
              </MenuItem>
            )) : null
          )}
          </>
        </ContextMenuPopup>
      </>,
      document.body
    )}
    {senderCtxMenu && createPortal(
      <>
        <DismissBackdrop onDismiss={closeSenderCtxMenu} trapContextMenu />
        <ContextMenuPopup
          className="fixed z-[60] select-none"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.senderContextMenu" })}
          style={senderCtxMenuPopupStyle}
        >
          <MenuItem
            icon={<Copy size={14} />}
            onClick={handleCopySenderDisplayName}
          >
            {formatMessage({ id: "message.messageItem.copyName" })}
          </MenuItem>
          {senderHandleText ? (
            <MenuItem
              icon={<Copy size={14} />}
              onClick={handleCopySenderHandle}
            >
              {formatMessage({ id: "message.messageItem.copyHandle" })}
            </MenuItem>
          ) : null}
        </ContextMenuPopup>
      </>,
      document.body
    )}
    </>
  );
});

export default ConnectedMessageItem;
