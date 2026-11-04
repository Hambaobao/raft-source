import type { MessageAttachment } from "../../store/messageStore";

type LayoutPart = { type: "text"; text: string } | { type: "attachments"; attachments: MessageAttachment[] };

/** Only a server-authored external layout for the unchanged message can reorder
 * its own attachments. Edited/translated or malformed data uses normal layout. */
export function externalAttachmentLayout(content: string, displayedContent: string,
  metadata: unknown, attachments: MessageAttachment[] = []): LayoutPart[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const meta = metadata as Record<string, unknown>;
  if (meta.kind !== "external-dm" && meta.kind !== "external-topic") return null;
  const layout = meta.externalAttachmentLayout as { content?: unknown; items?: unknown } | undefined;
  if (!layout || layout.content !== content || !Array.isArray(layout.items) || !layout.items.length
    || layout.items.length > 16 || !content.endsWith(displayedContent)) return null;
  const prefixLength = content.length - displayedContent.length;
  const parts: LayoutPart[] = [], seen = new Set<string>();
  let cursor = 0;
  for (const item of layout.items) {
    if (!item || typeof item !== "object") return null;
    const { attachmentId, offset } = item as { attachmentId?: unknown; offset?: unknown };
    if (typeof attachmentId !== "string" || typeof offset !== "number" || !Number.isInteger(offset)) return null;
    const position = offset - prefixLength;
    const attachment = attachments.find(a => a.id === attachmentId);
    if (!attachment || !attachment.mimeType.startsWith("image/") || seen.has(attachmentId)
      || position < cursor || position > displayedContent.length) return null;
    if (position > cursor) parts.push({ type: "text", text: displayedContent.slice(cursor, position) });
    const previous = parts.at(-1);
    if (previous?.type === "attachments") previous.attachments.push(attachment);
    else parts.push({ type: "attachments", attachments: [attachment] });
    seen.add(attachmentId); cursor = position;
  }
  if (cursor < displayedContent.length) parts.push({ type: "text", text: displayedContent.slice(cursor) });
  return parts;
}
