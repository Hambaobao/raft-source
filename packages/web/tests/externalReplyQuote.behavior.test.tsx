import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";

const channelId = "22222222-2222-2222-2222-222222222222";
const originalId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const path = `/s/studio/dm/${channelId}?msg=${originalId}`;
const body = "Please **review** this.\n\nKeep `details` intact.";

async function renderReply({ external = true, available = true } = {}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useMessageStore } = await import("../src/store/messageStore");
  useAuthStore.setState({ user: { id: "user-1", name: "James" }, initialized: true, loading: false } as never);
  useServerStore.setState({ current: { id: "server-1", slug: "studio", name: "Studio" }, members: [] } as never);
  useAgentStore.setState({ agents: [{ id: "agent-1", name: "tibo", displayName: "Tibo", description: "Long role description" }], agentActivities: {} } as never);
  useMessageStore.setState({ transientFocusRequest: null });
  vi.spyOn(api, "get").mockResolvedValue({ data: { messages: available ? [{
    id: originalId, channelId, senderType: "agent", senderId: "agent-1", senderName: "Tibo",
    messageType: "chat", content: "The **original** message", createdAt: "2026-11-01T00:00:00.000Z",
  }] : [] } });
  const content = `${external ? "https://remote.example:8443" : window.location.origin}${path}\n\n${body}`;
  const message = {
    id: "reply-1", channelId, seq: 5, senderType: "user", senderId: "user-1", senderName: "James",
    messageType: "chat", content, createdAt: "2026-11-01T00:01:00.000Z",
    ...(external ? { actionMetadata: { kind: "external-dm", replyTo: originalId } } : {}),
  };
  const view = render(<MemoryRouter><TestIntlProvider><MessageItem
    message={message as never} mentionMap={new Map()}
    channels={[{ id: channelId, name: "tibo", type: "dm" } as never]}
  /></TestIntlProvider></MemoryRouter>);
  return { ...view, message, content, useMessageStore };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("external reply keeps its stored reference but shows one compact quote before the intact reply", async () => {
  const view = await renderReply();
  const quote = await view.findByTestId("quoted-message-card");
  const reply = view.getByText("review", { selector: "strong" });
  assert.ok(quote.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(quote.tagName, "BUTTON");
  assert.ok(quote.textContent?.includes("Tibo"));
  assert.ok(quote.textContent?.includes("The original message"));
  assert.ok(!quote.textContent?.includes("Long role description"));
  assert.ok(view.getByText("details", { selector: "code" }));
  assert.equal(view.container.querySelector(`a[href*="msg=${originalId}"]`), null);
  assert.equal(view.message.content, view.content, "display must not remove the Agent's stored reference");
  fireEvent.click(quote);
  assert.equal(view.useMessageStore.getState().transientFocusRequest?.messageId, originalId);
  assert.equal(view.useMessageStore.getState().transientFocusRequest?.channelId, channelId);
});

test("an authored permalink keeps its inline entry and ordinary preview below the reply", async () => {
  const view = await renderReply({ external: false });
  const quote = await view.findByTestId("quoted-message-card");
  const reply = view.getByText("review", { selector: "strong" });
  assert.ok(reply.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(view.container.querySelector(`a[href*="msg=${originalId}"]`));
  assert.equal(view.message.content, view.content);
});

test("an unavailable original preserves the reply and restores an identifiable reference", async () => {
  const view = await renderReply({ available: false });
  await waitFor(() => assert.ok(view.getByText("Unavailable linked message")));
  assert.equal(view.queryByTestId("quoted-message-card"), null);
  assert.ok(view.getByText("review", { selector: "strong" }));
  assert.ok(view.getByText("details", { selector: "code" }));
  assert.equal(view.message.content, view.content);
});
