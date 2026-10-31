import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { useAttachmentPreviewBridge } from "../src/components/message/attachmentPreviewBridge";

afterEach(cleanup);

test("relative HTML preview URLs retain the comment bridge and current browser origin", () => {
  const { result } = renderHook(() => useAttachmentPreviewBridge());
  const relative = "/api/attachments/test/html-preview?previewToken=scoped&serverId=server";
  for (const input of [relative, `https://api.example.test${relative}`]) {
    const url = new URL(result.current.buildSrc(input));
    assert.equal(url.origin, input.startsWith("/") ? window.location.origin : "https://api.example.test");
    assert.equal(url.searchParams.get("previewToken"), "scoped");
    assert.equal(url.searchParams.get("serverId"), "server");
    assert.ok(url.searchParams.get("acBridgeNonce"));
    assert.equal(url.searchParams.get("acBridgeParentOrigin"), window.location.origin);
  }
});

test("each iframe load receives a fresh parent-minted document epoch", () => {
  const messages: Array<Record<string, unknown>> = [];
  const { result } = renderHook(() => useAttachmentPreviewBridge());
  result.current.iframeRef.current = {
    contentWindow: {
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    },
  } as unknown as HTMLIFrameElement;

  act(() => result.current.activateDocument());
  act(() => result.current.activateDocument());

  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "activate-document");
  assert.equal(messages[1].type, "activate-document");
  assert.equal(messages[0].nonce, messages[1].nonce, "the preview instance nonce remains stable");
  assert.equal(typeof messages[0].documentEpoch, "string");
  assert.equal(typeof messages[1].documentEpoch, "string");
  assert.notEqual(
    messages[0].documentEpoch,
    messages[1].documentEpoch,
    "a preview-lifetime epoch would let delayed old-document reports cross a self-navigation",
  );
});
