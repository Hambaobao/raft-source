import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { agentMessageBodyReads } from "../db/schema";

import { dbTest } from "../test/integration/dbTest";
import { applyAgentModelSeen } from "./agentModelSeen";
import { createAgent } from "./agentService";
import { addAgent, getAgentLegacyReadCursor, markAgentLegacyRead } from "./channelService";
import { createMessage } from "./messageService";
import { READ_POSITION_SETTLE_MS } from "./readPositionSettle";

// Rows created by the test are seconds old at most; read as if they settled.
const settledNow = { now: () => Date.now() + READ_POSITION_SETTLE_MS + 60_000 };

dbTest("agent:model-seen moves the read position over the shown run and stops at the first unshown message", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, "seen-agent", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await addAgent(channel.id, agent.id);

  const before = await createMessage(channel.id, "user", owner.id, "already read");
  await markAgentLegacyRead(agent.id, channel.id, before.seq);
  const shown1 = await createMessage(channel.id, "user", owner.id, "shown at startup 1");
  const own = await createMessage(channel.id, "agent", agent.id, "the agent's own reply");
  const shown2 = await createMessage(channel.id, "user", owner.id, "shown at startup 2");
  const notShown = await createMessage(channel.id, "user", owner.id, "arrived later, not shown");
  const shownAfterGap = await createMessage(channel.id, "user", owner.id, "a mention shown after the gap");

  const result = await applyAgentModelSeen({
    agentId: agent.id,
    serverId: server.id,
    channelId: channel.id,
    seqs: [shown1.seq, shown2.seq, shownAfterGap.seq],
  }, settledNow);

  assert.deepEqual(result, { outcome: "advanced", fromSeq: before.seq, toSeq: shown2.seq }, "the agent's own message is not a gap; the unshown one is");
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), shown2.seq);
  assert.ok(notShown.seq > shown2.seq && own.seq < shown2.seq);

  const again = await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: channel.id, seqs: [shownAfterGap.seq] }, settledNow);
  assert.deepEqual(again, { outcome: "unchanged", reason: "gap" }, "a sparse report never moves the position past an unshown message");
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), shown2.seq);
});

dbTest("agent:model-seen does nothing for a conversation the agent cannot access", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const agent = await createAgent(server.id, "outsider-agent", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const message = await createMessage(channel.id, "user", owner.id, "private");

  const result = await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: channel.id, seqs: [message.seq] }, settledNow);
  assert.deepEqual(result, { outcome: "unchanged", reason: "no_access" });
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), 0);
});

dbTest("agent:model-seen does not move the read position over rows newer than the settle window", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, "fresh-agent", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await addAgent(channel.id, agent.id);
  const fresh = await createMessage(channel.id, "user", owner.id, "just committed");

  const result = await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: channel.id, seqs: [fresh.seq] });
  assert.deepEqual(result, { outcome: "unchanged", reason: "gap" }, "a lower seq could still be committing behind a fresh row");
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), 0);
});

dbTest("agent:model-seen ignores a conversation on another server, even a public one", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const otherServer = await seed.server({ owner });
  const foreign = await seed.channel({ server: otherServer, members: [owner] });
  const agent = await createAgent(server.id, "cross-server-agent", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const message = await createMessage(foreign.id, "user", owner.id, "public, but on another server");

  const result = await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: foreign.id, seqs: [message.seq] }, settledNow);
  assert.deepEqual(result, { outcome: "unchanged", reason: "no_access" });
  assert.equal(await getAgentLegacyReadCursor(agent.id, foreign.id), 0);
});

dbTest("sparse body consumption is durable even when a gap or settle window blocks the read cursor", async ({ seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, "sparse-reader", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await addAgent(channel.id, agent.id);
  const unseen = await createMessage(channel.id, "user", owner.id, "not shown");
  const shown = await createMessage(channel.id, "user", owner.id, "local check body");
  await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: channel.id, seqs: [shown.seq], launchId: "launch-current" });
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), 0);
  const facts = await db.select().from(agentMessageBodyReads).where(eq(agentMessageBodyReads.agentId, agent.id));
  assert.deepEqual(facts.map(f => [f.messageId, f.launchId]), [[shown.id, "launch-current"]]);
  await applyAgentModelSeen({ agentId: agent.id, serverId: server.id, channelId: channel.id, seqs: [shown.seq, shown.seq, -1, NaN] });
  assert.equal((await db.select().from(agentMessageBodyReads)).length, 1);
  assert.ok(unseen.seq < shown.seq);
});
