import assert from "node:assert/strict";
import { test } from "vitest";
import { sendMessage } from "./messages";

test("message operations preserve explicit reply phase and reject an unassociated completion", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = { messages: { sendV2: async (body: Record<string, unknown>) => {
    bodies.push(body);
    return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "reply", messageSeq: 2 } };
  } } };
  const replyTo = "12345678-1234-1234-1234-123456789012";
  for (const replyPhase of ["progress", "final"] as const) {
    await sendMessage(client as never, { target: "#room", content: "answer", replyTo, replyPhase });
    assert.equal(bodies.at(-1)?.replyPhase, replyPhase);
    assert.equal(bodies.at(-1)?.replyTo, replyTo);
  }
  await sendMessage(client as never, { target: "#room", content: "answer", replyPhase: "final" });
  assert.equal(bodies.length, 2);
});
