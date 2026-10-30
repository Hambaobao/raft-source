import assert from "node:assert/strict";
import { test } from "vitest";
import { sendMessage, replyToRequestSchema } from "./messages";

test("quote and completion are independent in shared message operations", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = { messages: { sendV2: async (body: Record<string, unknown>) => {
    bodies.push(body);
    return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "reply", messageSeq: 2 } };
  } } };
  const a = "12345678-1234-1234-1234-123456789012", b = "87654321-1234-1234-1234-123456789012";
  assert.equal(replyToRequestSchema.safeParse({message:{target:"#room"},content:"answer",completedInputMessageIds:[a,b]}).success,true);
  await sendMessage(client as never, { target: "#room", content: "answer", completedInputMessageIds: [a,b] });
  assert.equal(bodies[0]?.replyTo, undefined);
  assert.deepEqual(bodies[0]?.completedInputMessageIds, [a,b]);
  await sendMessage(client as never, { target: "#room", content: "quoted answer", replyTo: a, completedInputMessageIds: [b] });
  assert.equal(bodies[1]?.replyTo, a);
  assert.deepEqual(bodies[1]?.completedInputMessageIds, [b]);
  await sendMessage(client as never, { target: "#room", content: "quote only", replyTo: a });
  assert.equal(bodies[2]?.completedInputMessageIds, undefined);
  await sendMessage(client as never, { target: "#room", content: "invalid", completedInputMessageIds: ["bad"] });
  assert.equal(bodies.length, 3);
});
