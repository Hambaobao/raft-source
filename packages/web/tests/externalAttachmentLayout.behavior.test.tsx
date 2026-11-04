import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { resetInlineAttachmentUrlCache } from "../src/components/message/inlineAttachmentUrlCache";

async function renderLayout(offsets: number[] | null, { quote = false, stale = false, thumbnails = true } = {}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const channelId = "22222222-2222-2222-2222-222222222222";
  const quotedId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const prefix = quote ? `https://remote.example/s/studio/dm/${channelId}?msg=${quotedId}\n\n` : "";
  const text = "Before\n\nAfter", content = prefix + text;
  const attachments = ["first", "last"].map((name) => ({ id: name, filename: `${name}.png`, mimeType: "image/png",
    sizeBytes: 10, width: 200, height: 100, thumbnailUrl: thumbnails ? `https://images.example/${name}.png` : null }));
  useAuthStore.setState({ user: { id: "user-1", name: "James" }, initialized: true, loading: false } as never);
  useServerStore.setState({ current: { id: "server-1", slug: "studio", name: "Studio" }, members: [] } as never);
  vi.spyOn(api, "get").mockResolvedValue({ data: { messages: [{ id: quotedId, channelId, senderType: "user", senderId: "user-1", senderName: "James",
    messageType: "chat", content: "Quoted original", createdAt: "2026-11-04T00:00:00.000Z" }] } });
  const actionMetadata = { kind: "external-dm", ...(quote ? { replyTo: quotedId } : {}), ...(offsets ? {
    externalAttachmentLayout: { content: stale ? "old content" : content,
      items: offsets.map((offset, i) => ({ attachmentId: attachments[i].id, offset: prefix.length + offset })) },
  } : {}) };
  return render(<MemoryRouter><TestIntlProvider><MessageItem
    message={{ id: "ordered", channelId, seq: 1, senderType: "user", senderId: "user-1", senderName: "James",
      messageType: "chat", content, attachments, actionMetadata, createdAt: "2026-11-04T00:01:00.000Z" } as never}
    mentionMap={new Map()} channels={[{ id: channelId, name: "tibo", type: "dm" } as never]}
  /></TestIntlProvider></MemoryRouter>);
}

afterEach(() => { cleanup(); resetInlineAttachmentUrlCache(); vi.restoreAllMocks(); });
const before = (a: Element, b: Element) => assert.ok(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test("external image/text/image renders in source order without duplicate attachments", async () => {
  const view = await renderLayout([0, 13]);
  const first = view.getByAltText("first.png"), last = view.getByAltText("last.png");
  before(first, view.getByText("Before")); before(view.getByText("After"), last);
  assert.equal(view.getAllByAltText("first.png").length, 1); assert.equal(view.getAllByAltText("last.png").length, 1);
});

test("interleaved images stay between the intended text blocks", async () => {
  const view = await renderLayout([8]);
  before(view.getByText("Before"), view.getByAltText("first.png"));
  before(view.getByAltText("first.png"), view.getByText("After"));
  before(view.getByText("After"), view.getByAltText("last.png"));
});

test("quoted external messages keep the quote above ordered images and text", async () => {
  const view = await renderLayout([0, 13], { quote: true });
  before(await view.findByTestId("quoted-message-card"), view.getByAltText("first.png"));
  before(view.getByAltText("first.png"), view.getByText("Before"));
});

for (const stale of [false, true]) test(`ordinary or edited messages retain their normal attachment placement (${stale})`, async () => {
  const view = await renderLayout(stale ? [0, 13] : null, { stale });
  before(view.getByText("After"), view.getByAltText("first.png"));
  assert.equal(view.getAllByAltText("first.png").length, 1);
});


test("interleaved local-storage images load authenticated URLs without duplicate requests", async () => {
  const requested: string[] = [];
  vi.spyOn(api, "post").mockImplementation(async (url, body: any) => {
    assert.equal(url, "/attachments/urls");
    requested.push(...body.attachmentIds);
    return { data: { urls: body.attachmentIds.map((id: string) => ({ id, url: `/api/attachments/${id}?token=test`, expiresAt: null })) } };
  });
  const view = await renderLayout([0, 13], { thumbnails: false });
  const first = await view.findByAltText("first.png"), last = await view.findByAltText("last.png");
  before(first, view.getByText("Before")); before(view.getByText("After"), last);
  assert.equal(first.getAttribute("src"), "/api/attachments/first?token=test");
  assert.deepEqual(requested.sort(), ["first", "last"]);
  assert.equal(vi.mocked(api.post).mock.calls.length, 1);
});
