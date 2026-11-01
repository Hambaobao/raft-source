import { parseRaftPermalink, visitOutsideMarkdownCode } from "@botiverse/raft-shared";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageAttachment } from "../../store/messageStore";

type FormatMessage = IntlShape["formatMessage"];

const CJK_URL_BOUNDARY_PUNCTUATION = "，。、；：！？）》」』】》〉”’（《「『【〈“‘";
const URL_PATTERN = new RegExp(`https?:\\/\\/[^\\s<>"'${CJK_URL_BOUNDARY_PUNCTUATION}]+`, "g");
const TRAILING_PUNCTUATION = /[),.!?;:，。！？；：]+$/;

export interface ExtractedQuotedMessagePermalink {
  rawUrl: string;
  parsed: ParsedRaftPermalink;
}

// An external reply's first permalink is server-generated and bound to this
// channel. Use the browser origin so SSH forwarding and HTTPS share one quote.
export function localizeExternalReplyPermalink(content: string, metadata: unknown, channelId: string,
  serverSlug: string | undefined, origin: string | undefined): string {
  if (!metadata || typeof metadata !== "object" || !origin || !serverSlug) return content;
  const relation = metadata as { kind?: string; replyTo?: string };
  if (!["external-dm", "external-topic"].includes(relation.kind ?? "") || !relation.replyTo) return content;
  const firstLine = content.split("\n", 1)[0];
  try {
    const url = new URL(firstLine);
    if (url.protocol !== "http:" && url.protocol !== "https:") return content;
    const parsed = parseRaftPermalink(firstLine, url.hostname);
    if (!parsed || parsed.messageId !== relation.replyTo || parsed.channelId !== channelId
      || parsed.serverSlug !== serverSlug || parsed.threadParentMessageId
      || parsed.routeKind !== (relation.kind === "external-dm" ? "dm" : "channel")) return content;
    return `${origin}${url.pathname}${url.search}${content.slice(firstLine.length)}`;
  } catch { return content; }
}

export function matchesUnavailableQuotedPermalink(
  renderedHref: string,
  unavailableRawUrl: string | null | undefined,
  currentHostname: string | undefined,
): boolean {
  if (!unavailableRawUrl) return false;
  // Markdown preserves escaped query separators in the href prop, while the
  // plain-text extractor retains the original URL. Parse both forms and compare
  // the permalink identity instead of their renderer-specific serialization.
  const rendered = parseRaftPermalink(renderedHref.replaceAll("&amp;", "&"), currentHostname);
  const unavailable = parseRaftPermalink(unavailableRawUrl, currentHostname);
  return Boolean(
    rendered
      && unavailable
      && rendered.serverSlug === unavailable.serverSlug
      && rendered.routeKind === unavailable.routeKind
      && rendered.channelId === unavailable.channelId
      && rendered.threadParentMessageId === unavailable.threadParentMessageId
      && rendered.messageId === unavailable.messageId,
  );
}

export function extractFirstQuotedMessagePermalink(
  content: string,
  currentHostname: string | undefined,
  currentServerSlug: string | undefined,
): ExtractedQuotedMessagePermalink | null {
  if (!content?.includes("http") || !currentServerSlug) return null;

  // Code is decided by the markdown parser (task #762), not by fence regexes.
  let found: ExtractedQuotedMessagePermalink | null = null;
  visitOutsideMarkdownCode(content, (chunk) => {
    if (found) return;
    for (const match of chunk.matchAll(URL_PATTERN)) {
      const raw = match[0];
      const start = match.index ?? -1;
      if (start < 0) continue;

      // Skip markdown links like [text](https://...)
      if (start > 0 && chunk[start - 1] === "(") continue;

      const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
      const parsed = parseRaftPermalink(candidate, currentHostname);
      if (!parsed || parsed.serverSlug !== currentServerSlug) continue;

      found = { rawUrl: candidate, parsed };
      return;
    }
  });
  if (found) return found;

  return null;
}

export function buildQuotedMessageAttachmentLabel(
  attachments: MessageAttachment[] | undefined,
  formatMessage: FormatMessage,
): string | null {
  if (!attachments || attachments.length === 0) return null;

  const imageCount = attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).length;
  if (attachments.length === 1) {
    return imageCount === 1
      ? formatMessage({ id: "message.quote.oneImage" })
      : formatMessage({ id: "message.quote.oneFile" });
  }
  if (imageCount === attachments.length) {
    return formatMessage({ id: "message.quote.nImages" }, { count: imageCount });
  }
  return formatMessage({ id: "message.quote.nAttachments" }, { count: attachments.length });
}
