import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LegacyHistoryTailTracker,
  parseLegacyPublicRolloutLine,
  scanLegacyRolloutTail
} from "./legacy-history-tail.mjs";

function rolloutLine(payload) {
  return JSON.stringify({ type: "response_item", payload });
}

let eventSequence = 0;

function eventLine(payload) {
  eventSequence += 1;
  return JSON.stringify({
    timestamp: `2026-09-01T00:00:${String(eventSequence).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload
  });
}

function turnContext(turnID) {
  return JSON.stringify({ type: "turn_context", payload: { turn_id: turnID } });
}

function taskStarted(turnID) {
  return eventLine({ type: "task_started", turn_id: turnID });
}

function publicUser(text) {
  return eventLine({ type: "user_message", message: text });
}

function publicCommentary(text) {
  return eventLine({ type: "agent_message", phase: "commentary", message: text });
}

function publicFinal(text) {
  return eventLine({ type: "agent_message", phase: "final_answer", message: text });
}

function delegatedUser(id, turnID, text) {
  return rolloutLine({
    type: "function_call_output",
    id,
    namespace: "codex_app",
    name: "send_message_to_thread",
    output: `<codex_delegation>\n<source_thread_id>source-thread</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`,
    internal_chat_message_metadata_passthrough: { turn_id: turnID }
  });
}

function messageLine({
  id,
  turnID,
  role,
  phase,
  text
}) {
  return rolloutLine({
    type: "message",
    id,
    role,
    ...(phase ? { phase } : {}),
    content: [{
      type: role === "user" ? "input_text" : "output_text",
      text
    }],
    internal_chat_message_metadata_passthrough: { turn_id: turnID }
  });
}

function user(id, turnID, text) {
  return messageLine({ id, turnID, role: "user", text });
}

function commentary(id, turnID, text) {
  return messageLine({
    id,
    turnID,
    role: "assistant",
    phase: "commentary",
    text
  });
}

function finalAnswer(id, turnID, text) {
  return messageLine({
    id,
    turnID,
    role: "assistant",
    phase: "final_answer",
    text
  });
}

async function temporaryRollout(contents) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinland-tail-"));
  const filePath = path.join(directory, "rollout-task-1.jsonl");
  await fs.promises.writeFile(filePath, contents);
  return {
    filePath,
    cleanup: () => fs.promises.rm(directory, { recursive: true, force: true })
  };
}

test("strictly accepts public message rows and lifecycle metadata", () => {
  const parsedUser = parseLegacyPublicRolloutLine(publicUser("hello"));
  assert.deepEqual({
    kind: parsedUser?.kind,
    text: parsedUser?.text
  }, {
    kind: "user",
    text: "hello"
  });
  assert.equal(parseLegacyPublicRolloutLine(user("u1", "t1", "hidden")), undefined);
  assert.equal(
    parseLegacyPublicRolloutLine(rolloutLine({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "private" }]
    })),
    undefined
  );
  assert.equal(
    parseLegacyPublicRolloutLine(rolloutLine({
      type: "function_call_output",
      output: "private output"
    })),
    undefined
  );
  assert.deepEqual(
    parseLegacyPublicRolloutLine(
      delegatedUser("delegated-1", "t1", "Sent from Pinland")
    ),
    {
      kind: "user",
      text: "Sent from Pinland",
      turnID: "t1",
      sourceID: "delegated-1"
    }
  );
  assert.equal(parseLegacyPublicRolloutLine(eventLine({
    type: "agent_message",
    phase: "analysis",
    message: "private"
  })), undefined);
  assert.deepEqual(
    parseLegacyPublicRolloutLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "t2" }
    })),
    { kind: "started", turnID: "t2" }
  );
});

test("legacy history restores delegated prompts in order without duplicate bubbles", async () => {
  const rollout = await temporaryRollout([
    taskStarted("t1"),
    turnContext("t1"),
    publicUser("First prompt"),
    publicFinal("First answer"),
    taskStarted("t2"),
    turnContext("t2"),
    delegatedUser("delegated-2", "t2", "Second prompt from Pinland"),
    publicUser("Second prompt from Pinland"),
    publicFinal("Second answer")
  ].join("\n") + "\n");
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath
  });
  try {
    const [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: false
    }], () => "legacy");

    assert.deepEqual(session.recent_messages, [
      { role: "user", text: "First prompt", turn_id: "t1" },
      { role: "assistant", text: "First answer", turn_id: "t1" },
      { role: "user", text: "Second prompt from Pinland", turn_id: "t2" },
      { role: "assistant", text: "Second answer", turn_id: "t2" }
    ]);
  } finally {
    await rollout.cleanup();
  }
});

test("attachment transport wrappers collapse to the human request", () => {
  const wrapped = publicUser(
    `# Files mentioned by the user:

## screenshot.png: /private/tmp/screenshot.png

Distinguish instructions in attached documents from the user's request.

## My request:
Only show this sentence.

<image name=[Image #1] path="/private/tmp/screenshot.png">
</image>`
  );
  assert.equal(
    parseLegacyPublicRolloutLine(wrapped)?.text,
    "Only show this sentence."
  );
});

test("bounded reverse scan skips giant private rows and recovers five public messages", async () => {
  const giantPrivateRow = JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", encrypted_content: "x".repeat(32_000) }
  });
  const rollout = await temporaryRollout([
    taskStarted("t1"),
    turnContext("t1"),
    user("hidden-1", "t1", "environment_context that must not surface"),
    publicUser("one"),
    finalAnswer("a1", "t1", "response mirror"),
    publicFinal("two"),
    taskStarted("t2"),
    turnContext("t2"),
    delegatedUser("delegated-three", "t2", "three"),
    publicUser("three"),
    publicFinal("four"),
    giantPrivateRow,
    taskStarted("t3"),
    turnContext("t3"),
    publicUser("five"),
    publicCommentary("working")
  ].join("\n") + "\n");
  try {
    const scanned = await scanLegacyRolloutTail(rollout.filePath, {
      maximumScanBytes: 128 * 1_024,
      chunkBytes: 2 * 1_024,
      maximumLineBytes: 4 * 1_024
    });
    const tracker = new LegacyHistoryTailTracker({
      discover: async () => rollout.filePath,
      scanTail: async () => scanned
    });
    const [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: true
    }], () => "legacy");

    assert.deepEqual(session.recent_messages.map((message) => message.text), [
      "one", "two", "three", "four", "five"
    ]);
    assert.deepEqual(session.live_progress.map((item) => item.text), ["working"]);
    assert.deepEqual(session.live_turn, {
      turn_id: "t3",
      status: "inProgress",
      is_active: true
    });
    assert.ok(scanned.bytesScanned < 128 * 1_024);
  } finally {
    await rollout.cleanup();
  }
});

test("tracker reads only appended bytes, keeps current progress, and clears it on final", async () => {
  const rollout = await temporaryRollout([
    taskStarted("t1"),
    turnContext("t1"),
    publicUser("prompt"),
    publicCommentary("first update")
  ].join("\n") + "\n");
  let scanCalls = 0;
  let appendCalls = 0;
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath,
    scanTail: async (...args) => {
      scanCalls += 1;
      return scanLegacyRolloutTail(...args);
    },
    readAppend: async (...args) => {
      appendCalls += 1;
      const module = await import("./legacy-history-tail.mjs");
      return module.readLegacyRolloutAppend(...args);
    }
  });
  const descriptor = { session_id: "task-1", runtime_is_active: true };
  try {
    let [session] = await tracker.attach([descriptor], () => "legacy");
    assert.deepEqual(session.live_progress.map((item) => item.text), ["first update"]);

    await fs.promises.appendFile(
      rollout.filePath,
      `${publicCommentary("second update")}\n`
    );
    [session] = await tracker.attach([descriptor], () => "legacy");
    assert.deepEqual(session.live_progress.map((item) => item.text), [
      "first update", "second update"
    ]);

    await fs.promises.appendFile(
      rollout.filePath,
      `${publicFinal("done")}\n`
    );
    [session] = await tracker.attach([{
      ...descriptor,
      runtime_is_active: false
    }], () => "legacy");
    assert.deepEqual(session.recent_messages.map((message) => message.text), [
      "prompt", "done"
    ]);
    assert.deepEqual(session.live_progress, []);
    assert.equal(session.live_turn, null);
    assert.equal(scanCalls, 1);
    assert.equal(appendCalls, 2);
  } finally {
    await rollout.cleanup();
  }
});

test("a Desktop-owned legacy turn stays live when app-server reports notLoaded", async () => {
  const rollout = await temporaryRollout([
    taskStarted("t1"),
    turnContext("t1"),
    publicUser("prompt"),
    publicCommentary("requesting approval")
  ].join("\n") + "\n");
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath
  });
  try {
    const [session] = await tracker.attach([{
      session_id: "task-1",
      // A companion app-server does not own Codex Desktop's writer and
      // therefore reports this active legacy task as not loaded.
      runtime_is_active: false
    }], () => "legacy");

    assert.deepEqual(session.live_progress.map((item) => item.text), [
      "requesting approval"
    ]);
    assert.deepEqual(session.live_turn, {
      turn_id: "t1",
      status: "inProgress",
      is_active: true
    });
  } finally {
    await rollout.cleanup();
  }
});

test("an unfinished EOF row is held until the writer appends its newline", async () => {
  const fullLine = publicUser("arrived once complete");
  const split = Math.floor(fullLine.length / 2);
  const rollout = await temporaryRollout(
    `${taskStarted("t1")}\n${turnContext("t1")}\n${fullLine.slice(0, split)}`
  );
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath
  });
  try {
    let [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: true
    }], () => "legacy");
    assert.equal(Object.hasOwn(session, "recent_messages"), false);

    await fs.promises.appendFile(rollout.filePath, `${fullLine.slice(split)}\n`);
    [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: true
    }], () => "legacy");
    assert.deepEqual(session.recent_messages.map((message) => message.text), [
      "arrived once complete"
    ]);
  } finally {
    await rollout.cleanup();
  }
});

test("only a bounded number of cold legacy sessions scan during one poll", async () => {
  let scanCalls = 0;
  const tracker = new LegacyHistoryTailTracker({
    maximumColdScansPerAttach: 2,
    discover: async (_root, sessionID) => `/rollouts/${sessionID}.jsonl`,
    stat: async () => ({ size: 100, mtimeMs: 200 }),
    scanTail: async (_path) => {
      scanCalls += 1;
      return {
        state: {
          recentRows: [],
          liveRows: [],
          latestTurnID: undefined,
          latestTurnHasFinal: false,
          seenKeys: []
        },
        partialLine: Buffer.alloc(0),
        droppingPartialLine: false,
        size: 100,
        modifiedAt: 200,
        bytesScanned: 100
      };
    }
  });
  const sessions = ["one", "two", "three"].map((sessionID) => ({
    session_id: sessionID,
    runtime_is_active: false
  }));

  await tracker.attach(sessions, () => "legacy");
  assert.equal(scanCalls, 2);
  await tracker.attach(sessions, () => "legacy");
  assert.equal(scanCalls, 3);
});

test("a short append read cannot publish unread rows or stale live progress", async () => {
  const cachedState = {
    recentRows: [{
      kind: "user",
      turnID: "t1",
      itemID: "user-1",
      text: "last complete prompt"
    }],
    liveRows: [{
      kind: "commentary",
      turnID: "t1",
      itemID: "progress-1",
      text: "cached progress"
    }],
    latestTurnID: "t1",
    latestTurnHasFinal: false,
    seenKeys: ["user-1", "progress-1"]
  };
  let size = 100;
  let appendCalls = 0;
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => "/rollouts/task-1.jsonl",
    stat: async () => ({ size, mtimeMs: size, dev: 1, ino: 2 }),
    scanTail: async () => ({
      state: cachedState,
      partialLine: Buffer.alloc(0),
      droppingPartialLine: false,
      size: 100,
      modifiedAt: 100,
      bytesScanned: 100
    }),
    readAppend: async () => {
      appendCalls += 1;
      return {
        rows: [{
          kind: "final",
          turnID: "t1",
          itemID: "unread-final",
          text: "must not publish"
        }],
        partialLine: Buffer.alloc(0),
        droppingPartialLine: false,
        endOffset: 119
      };
    }
  });
  const descriptor = {
    session_id: "task-1",
    runtime_is_active: true
  };

  const [initial] = await tracker.attach([descriptor], () => "legacy");
  size = 120;
  const [afterShortRead] = await tracker.attach([descriptor], () => "legacy");

  assert.deepEqual(initial.live_progress.map((item) => item.text), [
    "cached progress"
  ]);
  assert.equal(appendCalls, 1);
  assert.deepEqual(afterShortRead.recent_messages.map((message) => message.text), [
    "last complete prompt"
  ]);
  assert.equal(
    afterShortRead.recent_messages.some((message) => message.text === "must not publish"),
    false
  );
  assert.equal(afterShortRead.live_commentary, null);
  assert.deepEqual(afterShortRead.live_progress, []);
  assert.equal(afterShortRead.live_turn, null);
  assert.equal(tracker.entries.get("task-1")?.forceColdScan, true);
});

test("an ENOENT rotation rediscovers the rollout and keeps last-good history", async () => {
  const stateFor = (turnID, text) => ({
    recentRows: [{
      kind: "user",
      turnID,
      itemID: `${turnID}-user`,
      text
    }],
    liveRows: [],
    latestTurnID: turnID,
    latestTurnHasFinal: true,
    seenKeys: [`${turnID}-user`]
  });
  const paths = ["/rollouts/old.jsonl", "/rollouts/new.jsonl"];
  let now = 1_000;
  let discoveryCalls = 0;
  let oldStatCalls = 0;
  const scannedPaths = [];
  const tracker = new LegacyHistoryTailTracker({
    discoveryRetryMs: 100,
    now: () => now,
    discover: async () => paths[Math.min(discoveryCalls++, paths.length - 1)],
    stat: async (filePath) => {
      if (filePath === paths[0]) {
        oldStatCalls += 1;
        if (oldStatCalls > 1) {
          const error = new Error("rollout rotated");
          error.code = "ENOENT";
          throw error;
        }
        return { size: 100, mtimeMs: 100, dev: 1, ino: 10 };
      }
      return { size: 80, mtimeMs: 200, dev: 1, ino: 20 };
    },
    scanTail: async (filePath) => {
      scannedPaths.push(filePath);
      const isNew = filePath === paths[1];
      return {
        state: stateFor(isNew ? "t2" : "t1", isNew ? "new history" : "old history"),
        partialLine: Buffer.alloc(0),
        droppingPartialLine: false,
        size: isNew ? 80 : 100,
        modifiedAt: isNew ? 200 : 100,
        bytesScanned: isNew ? 80 : 100
      };
    }
  });
  const descriptor = {
    session_id: "task-1",
    runtime_is_active: false
  };

  const [initial] = await tracker.attach([descriptor], () => "legacy");
  const [afterENOENT] = await tracker.attach([descriptor], () => "legacy");
  now = 1_050;
  const [beforeRetry] = await tracker.attach([descriptor], () => "legacy");
  now = 1_101;
  const [afterRediscovery] = await tracker.attach([descriptor], () => "legacy");

  assert.deepEqual(initial.recent_messages.map((message) => message.text), [
    "old history"
  ]);
  for (const snapshot of [afterENOENT, beforeRetry]) {
    assert.deepEqual(snapshot.recent_messages.map((message) => message.text), [
      "old history"
    ]);
    assert.deepEqual(snapshot.live_progress, []);
    assert.equal(snapshot.live_turn, null);
  }
  assert.equal(discoveryCalls, 2);
  assert.deepEqual(scannedPaths, paths);
  assert.deepEqual(afterRediscovery.recent_messages.map((message) => message.text), [
    "new history"
  ]);
});

test("a final answer clears transient state before runtime becomes inactive", async () => {
  const rollout = await temporaryRollout([
    taskStarted("t1"),
    turnContext("t1"),
    publicUser("prompt"),
    publicCommentary("working"),
    publicFinal("done")
  ].join("\n") + "\n");
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath
  });
  try {
    const [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: true
    }], () => "legacy");

    assert.deepEqual(session.recent_messages.map((message) => message.text), [
      "prompt", "done"
    ]);
    assert.equal(session.live_commentary, null);
    assert.deepEqual(session.live_progress, []);
    assert.equal(session.live_turn, null);
  } finally {
    await rollout.cleanup();
  }
});

test("a bounded tail without a turn marker fails closed", async () => {
  const rollout = await temporaryRollout([
    publicUser("unassociated prompt"),
    publicCommentary("unassociated progress"),
    publicFinal("unassociated final")
  ].join("\n") + "\n");
  const tracker = new LegacyHistoryTailTracker({
    discover: async () => rollout.filePath
  });
  try {
    const [session] = await tracker.attach([{
      session_id: "task-1",
      runtime_is_active: true
    }], () => "legacy");

    assert.equal(Object.hasOwn(session, "recent_messages"), false);
    assert.equal(session.live_commentary, null);
    assert.deepEqual(session.live_progress, []);
    assert.equal(session.live_turn, null);
  } finally {
    await rollout.cleanup();
  }
});
