import assert from "node:assert/strict";
import test from "node:test";

import {
  boundExternalApproval,
  discoverRolloutPath,
  ExternalApprovalSnapshotTracker,
  extractExternalApprovalFromRolloutText
} from "./external-approval.mjs";

function rolloutLine(payload) {
  return JSON.stringify({ type: "response_item", payload });
}

function escalatedCall({
  callID = "call-1",
  turnID = "turn-1",
  command = "touch /private/sensitive-name"
} = {}) {
  return rolloutLine({
    type: "custom_tool_call",
    name: "exec",
    call_id: callID,
    input: `const r = await tools.exec_command({\n  cmd: ${JSON.stringify(command)},\n  sandbox_permissions: "require_escalated",\n  justification: "private reason"\n});`,
    internal_chat_message_metadata_passthrough: { turn_id: turnID }
  });
}

function permissionCall({
  callID = "permission-1",
  turnID = "turn-1"
} = {}) {
  return rolloutLine({
    type: "custom_tool_call",
    name: "exec",
    call_id: callID,
    input: `const result = await tools.request_permissions({
  permissions: { file_system: { write: ["/private/sensitive-name"] } },
  reason: "private reason"
});`,
    internal_chat_message_metadata_passthrough: { turn_id: turnID }
  });
}

test("detects a current unmatched escalated nested exec without exposing its input", () => {
  const approval = extractExternalApprovalFromRolloutText(
    `${escalatedCall()}\n`,
    { liveTurnID: "turn-1" }
  );

  assert.deepEqual(approval, {
    turn_id: "turn-1",
    kind: "command",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  });
  assert.equal(JSON.stringify(approval).includes("sensitive-name"), false);
  assert.equal(JSON.stringify(approval).includes("private reason"), false);
});

test("detects a current unmatched nested permission request without exposing its input", () => {
  const approval = extractExternalApprovalFromRolloutText(
    `${permissionCall()}\n`,
    { liveTurnID: "turn-1" }
  );

  assert.deepEqual(approval, {
    turn_id: "turn-1",
    kind: "permissions",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  });
  assert.equal(JSON.stringify(approval).includes("sensitive-name"), false);
  assert.equal(JSON.stringify(approval).includes("private reason"), false);
});

test("matching output clears the external approval", () => {
  const output = rolloutLine({
    type: "custom_tool_call_output",
    call_id: "call-1",
    output: "private output"
  });
  assert.equal(extractExternalApprovalFromRolloutText(
    `${escalatedCall()}\n${output}\n`,
    { liveTurnID: "turn-1" }
  ), undefined);
});

test("matching output clears a nested permission request", () => {
  const output = rolloutLine({
    type: "custom_tool_call_output",
    call_id: "permission-1",
    output: "private output"
  });
  assert.equal(extractExternalApprovalFromRolloutText(
    `${permissionCall()}\n${output}\n`,
    { liveTurnID: "turn-1" }
  ), undefined);
});

test("ignores ordinary exec, other turns, malformed lines, and lookalike text", () => {
  const ordinary = rolloutLine({
    type: "custom_tool_call",
    name: "exec",
    call_id: "ordinary",
    input: "await tools.exec_command({ cmd: \"pwd\" });",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
  });
  const lookalike = rolloutLine({
    type: "message",
    input: "tools.exec_command({ sandbox_permissions: 'require_escalated' })",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
  });
  const ordinaryQuestion = rolloutLine({
    type: "custom_tool_call",
    name: "exec",
    call_id: "question",
    input: "await tools.request_user_input({ question: 'continue?' });",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
  });
  const text = [
    "not json",
    ordinary,
    escalatedCall({ callID: "other", turnID: "turn-2" }),
    lookalike,
    ordinaryQuestion
  ].join("\n");
  assert.equal(extractExternalApprovalFromRolloutText(text, {
    liveTurnID: "turn-1"
  }), undefined);
});

test("ignores an ordinary command whose text mentions request_permissions", () => {
  const diagnostic = rolloutLine({
    type: "custom_tool_call",
    name: "exec",
    call_id: "diagnostic",
    input: `const result = await tools.exec_command({
  cmd: "rg 'tools.request_permissions({' ."
});`,
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
  });

  assert.equal(extractExternalApprovalFromRolloutText(
    `${diagnostic}\n`,
    { liveTurnID: "turn-1" }
  ), undefined);
});

test("drops a partial first JSONL fragment from a bounded tail", () => {
  const text = `${escalatedCall({ callID: "cut" })}\n${escalatedCall({ callID: "whole" })}\n`;
  const approval = extractExternalApprovalFromRolloutText(text, {
    liveTurnID: "turn-1",
    startedMidLine: true
  });
  assert.deepEqual(approval, {
    turn_id: "turn-1",
    kind: "command",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  });
});

test("bounds external approval metadata", () => {
  assert.deepEqual(boundExternalApproval({
    turn_id: " turn ",
    kind: "command",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  }), {
    turn_id: "turn",
    kind: "command",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  });
  assert.equal(boundExternalApproval({
    kind: "command",
    summary: ""
  }), undefined);
});

test("rollout discovery reads filenames only, matches the exact task suffix, and picks newest", async () => {
  const directory = (name) => ({
    name,
    isDirectory: () => true,
    isFile: () => false
  });
  const file = (name) => ({
    name,
    isDirectory: () => false,
    isFile: () => true
  });
  const tree = new Map([
    ["/sessions", [directory("old"), directory("new")]],
    ["/sessions/old", [file("rollout-old-task-1.jsonl")]],
    ["/sessions/new", [
      file("unrelated-task-1.jsonl"),
      file("rollout-lookalike-task-10.jsonl"),
      file("rollout-new-task-1.jsonl")
    ]]
  ]);
  const stats = new Map([
    ["/sessions/old/rollout-old-task-1.jsonl", { mtimeMs: 100 }],
    ["/sessions/new/rollout-new-task-1.jsonl", { mtimeMs: 200 }]
  ]);
  const touched = [];
  const result = await discoverRolloutPath("/sessions", "task-1", {
    fileSystem: {
      readdir: async (candidate) => tree.get(candidate) || [],
      stat: async (candidate) => {
        touched.push(candidate);
        return stats.get(candidate);
      }
    }
  });

  assert.equal(result, "/sessions/new/rollout-new-task-1.jsonl");
  assert.deepEqual(touched.sort(), [...stats.keys()].sort());
});

test("tracker inspects only active pinned tasks, caches unchanged tails, and clears terminal turns", async () => {
  let discoveryCalls = 0;
  let readCalls = 0;
  let tail = {
    text: `${escalatedCall()}\n`,
    startedMidLine: false,
    size: 100,
    modifiedAt: 200
  };
  const tracker = new ExternalApprovalSnapshotTracker({
    sessionsRoot: "/unused",
    discover: async (_root, sessionID) => {
      discoveryCalls += 1;
      return `/rollouts/${sessionID}.jsonl`;
    },
    stat: async () => ({ size: tail.size, mtimeMs: tail.modifiedAt }),
    readTail: async () => {
      readCalls += 1;
      return tail;
    }
  });
  const active = [{
    session_id: "task-1",
    live_turn: { turn_id: "turn-1", status: "interrupted", is_active: true }
  }];

  const first = await tracker.attach(active);
  const unchanged = await tracker.attach(active);
  const inactive = await tracker.attach([{
    session_id: "task-1",
    live_turn: { turn_id: "turn-1", status: "completed", is_active: false }
  }]);
  const noTurn = await tracker.attach([{ session_id: "task-2", live_turn: null }]);

  assert.equal(discoveryCalls, 1);
  assert.equal(readCalls, 1);
  assert.deepEqual(first[0].external_approval, {
    turn_id: "turn-1",
    kind: "command",
    tool_name: "Codex",
    summary: "Approval required in Codex"
  });
  assert.deepEqual(unchanged[0].external_approval, first[0].external_approval);
  assert.equal(inactive[0].external_approval, null);
  assert.equal(noTurn[0].external_approval, null);
});

test("tracker clears the alert after the matching output appears", async () => {
  let tail = {
    text: `${escalatedCall()}\n`,
    startedMidLine: false,
    size: 100,
    modifiedAt: 200
  };
  const tracker = new ExternalApprovalSnapshotTracker({
    sessionsRoot: "/unused",
    discover: async () => "/rollout.jsonl",
    stat: async () => ({ size: tail.size, mtimeMs: tail.modifiedAt }),
    readTail: async () => tail
  });
  const active = [{
    session_id: "task-1",
    live_turn: { turn_id: "turn-1", status: "interrupted", is_active: true }
  }];
  assert.notEqual((await tracker.attach(active))[0].external_approval, null);

  tail = {
    text: `${escalatedCall()}\n${rolloutLine({
      type: "custom_tool_call_output",
      call_id: "call-1"
    })}\n`,
    startedMidLine: false,
    size: 200,
    modifiedAt: 300
  };
  assert.equal((await tracker.attach(active))[0].external_approval, null);
});
