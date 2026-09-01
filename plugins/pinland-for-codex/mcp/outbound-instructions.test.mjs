import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalServerRequestReply,
  dispatchInstruction,
  extractInstructionCommandID,
  fallbackServerRequestReply,
  instructionFailureCode,
  instructionTurnStartParams,
  isActiveWriterConflict,
  normalizeApprovalDecision,
  normalizeApprovalRequest,
  normalizeInstructionCommand,
  resumedThreadFailureCode,
  scheduleApprovalServerRequestReply,
  turnStartFailureCode
} from "./outbound-instructions.mjs";

const command = {
  schema_version: 1,
  command_id: "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5",
  session_id: "01a03823-c96f-75d0-a69f-23936c6246f6",
  prompt: "Continue with the focused fix."
};

function computerUseApprovalRequest(overrides = {}) {
  const base = {
    id: 76,
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "node_repl",
      threadId: "thread-computer-use",
      turnId: "turn-computer-use",
      mode: "form",
      message: "Allow Computer Use to use \"Pages\"?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "computer-use",
        connector_name: "Computer Use",
        persist: ["session", "always"],
        tool_name: "get_app_state",
        tool_params: { app: "com.apple.iWork.Pages" },
        tool_params_display: [{
          name: "app",
          display_name: "App",
          value: "Pages"
        }]
      }
    }
  };
  return {
    ...base,
    ...overrides,
    params: { ...base.params, ...overrides.params }
  };
}

test("a claimed instruction is strictly validated and trimmed", () => {
  assert.deepEqual(normalizeInstructionCommand({
    ...command,
    prompt: `  ${command.prompt}  `
  }), command);
  assert.equal(normalizeInstructionCommand({ ...command, prompt: " " }), undefined);
  assert.equal(normalizeInstructionCommand({ ...command, command_id: "not-a-uuid" }), undefined);
  assert.equal(normalizeInstructionCommand({ ...command, session_id: "../bad task" }), undefined);
  assert.equal(normalizeInstructionCommand({
    ...command,
    prompt: "x".repeat(4_001)
  }), undefined);
  assert.equal(extractInstructionCommandID({
    command_id: `  ${command.command_id}  `
  }), command.command_id);
  assert.equal(extractInstructionCommandID({ command_id: "not-a-uuid" }), undefined);
});

test("turn/start uses a stable idempotency id and plain text input", () => {
  assert.deepEqual(instructionTurnStartParams(command), {
    threadId: command.session_id,
    clientUserMessageId: command.command_id,
    input: [{ type: "text", text: command.prompt, text_elements: [] }],
    turnTrigger: "pinland"
  });
});

test("dispatch resumes the pinned thread before starting its next turn", async () => {
  const calls = [];
  const client = {
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      return method === "thread/resume"
        ? { thread: { status: { type: "idle" } } }
        : {};
    }
  };

  assert.deepEqual(await dispatchInstruction(client, command), { accepted: true });
  assert.deepEqual(calls, [
    {
      method: "thread/resume",
      params: { threadId: command.session_id, excludeTurns: true },
      timeout: 12_000
    },
    {
      method: "turn/start",
      params: instructionTurnStartParams(command),
      timeout: 12_000
    }
  ]);
});

test("dispatch reports a bounded failure code and never returns raw errors", async () => {
  const result = await dispatchInstruction({
    async request() {
      throw new Error("Thread not found at /private/sensitive/path");
    }
  }, command);

  assert.deepEqual(result, { accepted: false, error_code: "thread_unavailable" });
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(instructionFailureCode(new Error("turn/start timed out")), "codex_unavailable");
  assert.equal(
    instructionFailureCode(new Error("no rollout found for thread id task-1")),
    "thread_unavailable"
  );
  assert.equal(instructionFailureCode(new Error("unexpected")), "request_failed");
  assert.equal(
    instructionFailureCode(new Error("thread-store conflict: already has an active writer")),
    "thread_active"
  );
  assert.equal(
    isActiveWriterConflict(new Error("Thread already has an active writer")),
    true
  );
  assert.equal(turnStartFailureCode(new Error("turn/start timed out")), "delivery_uncertain");
  assert.equal(turnStartFailureCode(new Error("Codex app-server closed")), "delivery_uncertain");
  const destroyedStream = new Error("Cannot call write after a stream was destroyed");
  destroyedStream.code = "ERR_STREAM_DESTROYED";
  assert.equal(turnStartFailureCode(destroyedStream), "delivery_uncertain");
  const rejected = new Error("Thread not found");
  rejected.code = -32_000;
  assert.equal(turnStartFailureCode(rejected), "thread_unavailable");
});

test("the app-server fallback never mistakes an internal queue write for delivery", async () => {
  const calls = [];
  const client = {
    async request(method) {
      calls.push(method);
      const error = new Error(
        `thread-store conflict: thread ${command.session_id} already has an active writer`
      );
      error.code = -32_600;
      throw error;
    }
  };

  assert.deepEqual(await dispatchInstruction(client, command), {
    accepted: false,
    error_code: "thread_active"
  });
  assert.deepEqual(calls, ["thread/resume"]);
});

test("turn/start transport uncertainty is not returned as a retryable failure", async () => {
  const calls = [];
  const result = await dispatchInstruction({
    async request(method) {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { status: { type: "idle" } } };
      }
      throw new Error("turn/start timed out");
    }
  }, command);

  assert.deepEqual(result, {
    accepted: false,
    error_code: "delivery_uncertain"
  });
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
});

test("an active resumed thread is never given a second turn/start", async () => {
  const calls = [];
  const result = await dispatchInstruction({
    async request(method) {
      calls.push(method);
      return {
        thread: { status: { type: "active", activeFlags: [] } }
      };
    }
  }, command);

  assert.deepEqual(result, { accepted: false, error_code: "thread_active" });
  assert.deepEqual(calls, ["thread/resume"]);
  assert.equal(resumedThreadFailureCode({
    thread: { status: { type: "idle" } }
  }), undefined);
  assert.equal(resumedThreadFailureCode({
    thread: { status: { type: "notLoaded" } }
  }), "thread_unavailable");
});

test("v2 approval requests normalize to a bounded bridge protocol", () => {
  assert.deepEqual(normalizeApprovalRequest({
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      reason: "Needs network access",
      command: "curl https://example.com"
    }
  }), {
    schema_version: 1,
    session_id: "thread-1",
    turn_id: "turn-1",
    kind: "command",
    tool_name: "Bash",
    summary: "Needs network access"
  });

  assert.deepEqual(normalizeApprovalRequest({
    id: 72,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      grantRoot: "/Users/example/projects/Pinland"
    }
  }), {
    schema_version: 1,
    session_id: "thread-2",
    turn_id: "turn-2",
    kind: "file_change",
    tool_name: "apply_patch",
    summary: "Allow file changes under /Users/example/projects/Pinland"
  });

  assert.deepEqual(normalizeApprovalRequest({
    id: 73,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-3",
      turnId: "turn-3",
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/tmp"] }
      }
    }
  }), {
    schema_version: 1,
    session_id: "thread-3",
    turn_id: "turn-3",
    kind: "permissions",
    tool_name: "request_permissions",
    summary: "Grant network and file access"
  });

  const longReason = "\ud83d\udd12".repeat(4_100);
  const bounded = normalizeApprovalRequest({
    id: 74,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-4", reason: longReason }
  });
  assert.equal(Array.from(bounded.summary).length, 4_000);

  assert.equal(normalizeApprovalRequest({
    id: 75,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-5",
      reason: "  ",
      networkApprovalContext: { host: "example.com" }
    }
  }).summary, "Connect to example.com");
});

test("Computer Use app access elicitations normalize only as conversation approvals", () => {
  assert.deepEqual(normalizeApprovalRequest(computerUseApprovalRequest()), {
    schema_version: 1,
    session_id: "thread-computer-use",
    turn_id: "turn-computer-use",
    kind: "computer_use",
    tool_name: "Computer Use",
    summary: "Allow Computer Use to use \"Pages\"?"
  });
  assert.equal(
    normalizeApprovalRequest(computerUseApprovalRequest({
      params: { mode: "openai/form" }
    }))?.kind,
    "computer_use"
  );
});

test("legacy approval requests normalize without inventing a turn id", () => {
  assert.deepEqual(normalizeApprovalRequest({
    id: 81,
    method: "execCommandApproval",
    params: {
      conversationId: "legacy-thread-1",
      command: ["git", "status", "--short"]
    }
  }), {
    schema_version: 1,
    session_id: "legacy-thread-1",
    kind: "command",
    tool_name: "Bash",
    summary: "git status --short"
  });

  assert.deepEqual(normalizeApprovalRequest({
    id: 82,
    method: "applyPatchApproval",
    params: {
      conversationId: "legacy-thread-2",
      fileChanges: {
        "/tmp/one": { type: "add" },
        "/tmp/two": { type: "delete" }
      }
    }
  }), {
    schema_version: 1,
    session_id: "legacy-thread-2",
    kind: "file_change",
    tool_name: "apply_patch",
    summary: "Apply changes to 2 files"
  });
});

test("malformed and unrelated server requests do not enter the approval bridge", () => {
  assert.equal(normalizeApprovalRequest({
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { threadId: " " }
  }), undefined);
  assert.equal(normalizeApprovalRequest({
    id: 92,
    method: "item/permissions/requestApproval",
    params: { threadId: "thread-1", permissions: [] }
  }), undefined);
  assert.equal(normalizeApprovalRequest({
    id: 93,
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1", turnId: "turn-1" }
  }), undefined);
  assert.equal(normalizeApprovalRequest({
    id: 94,
    method: "execCommandApproval",
    params: {}
  }), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: { _meta: { connector_id: "computer-use" } }
  })), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: { requestedSchema: {
      type: "object",
      properties: { answer: { type: "string" } }
    } }
  })), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: { mode: "url" }
  })), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: { serverName: "untrusted-server" }
  })), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: { requestedSchema: { type: "object" } }
  })), undefined);
  assert.equal(normalizeApprovalRequest(computerUseApprovalRequest({
    params: {
      _meta: {
        ...computerUseApprovalRequest().params._meta,
        connector_name: "Not Computer Use"
      }
    }
  })), undefined);
});

test("only a versioned 200 bridge allow or deny is accepted", () => {
  assert.equal(normalizeApprovalDecision({
    status: 200,
    json: { schema_version: 1, decision: "allow" }
  }), "allow");
  assert.equal(normalizeApprovalDecision({
    status: 200,
    json: { schema_version: 1, decision: "deny" }
  }), "deny");
  assert.equal(normalizeApprovalDecision({ status: 204 }), undefined);
  assert.equal(normalizeApprovalDecision({
    status: 200,
    json: { schema_version: 2, decision: "allow" }
  }), undefined);
  assert.equal(normalizeApprovalDecision({
    status: 200,
    json: { schema_version: 1, decision: "accept" }
  }), undefined);
});

test("bridge decisions map back to each app-server approval schema", () => {
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ]) {
    assert.deepEqual(approvalServerRequestReply({ id: 101, method }, "allow"), {
      id: 101,
      result: { decision: "accept" }
    });
    assert.deepEqual(approvalServerRequestReply({ id: 102, method }, "deny"), {
      id: 102,
      result: { decision: "decline" }
    });
  }

  const permissions = {
    network: { enabled: true },
    fileSystem: { write: ["/tmp"] }
  };
  const permissionRequest = {
    id: 103,
    method: "item/permissions/requestApproval",
    params: { permissions }
  };
  assert.deepEqual(approvalServerRequestReply(permissionRequest, "allow"), {
    id: 103,
    result: { permissions, scope: "turn" }
  });
  assert.deepEqual(approvalServerRequestReply(permissionRequest, "deny"), {
    id: 103,
    result: { permissions: {}, scope: "turn" }
  });
  assert.equal(approvalServerRequestReply({
    id: 103,
    method: "item/permissions/requestApproval",
    params: { permissions: [] }
  }, "allow"), undefined);

  const computerUseRequest = computerUseApprovalRequest({ id: 108 });
  assert.deepEqual(approvalServerRequestReply(computerUseRequest, "allow"), {
    id: 108,
    result: {
      action: "accept",
      content: {},
      _meta: { persist: "session" }
    }
  });
  assert.deepEqual(approvalServerRequestReply(computerUseRequest, "deny"), {
    id: 108,
    result: { action: "decline", content: null, _meta: null }
  });
  assert.equal(approvalServerRequestReply({
    id: 109,
    method: "mcpServer/elicitation/request",
    params: {}
  }, "allow"), undefined);

  for (const method of ["execCommandApproval", "applyPatchApproval"]) {
    assert.deepEqual(approvalServerRequestReply({ id: 104, method }, "allow"), {
      id: 104,
      result: { decision: "approved" }
    });
    assert.deepEqual(approvalServerRequestReply({ id: 105, method }, "deny"), {
      id: 105,
      result: {
        decision: { denied: { rejection: "Denied in Pinland." } }
      }
    });
  }

  assert.equal(approvalServerRequestReply({ id: 106, method: "unknown" }, "allow"), undefined);
  assert.equal(approvalServerRequestReply({ id: 107, method: "execCommandApproval" }, "later"), undefined);
});

test("approval forwarding is scheduled without blocking the app-server reader", async () => {
  let release;
  const pendingBridgeResponse = new Promise((resolve) => { release = resolve; });
  const approvals = [];
  const replies = [];
  const request = {
    id: 111,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-111",
      turnId: "turn-111",
      reason: "Run the requested command"
    }
  };

  const scheduled = scheduleApprovalServerRequestReply(
    request,
    (approval) => {
      approvals.push(approval);
      return pendingBridgeResponse;
    },
    (reply) => replies.push(reply)
  );

  assert.equal(scheduled, true);
  assert.deepEqual(approvals, []);
  assert.deepEqual(replies, []);
  await Promise.resolve();
  assert.equal(approvals.length, 1);
  assert.deepEqual(replies, []);

  release({
    status: 200,
    json: { schema_version: 1, decision: "allow" }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, [{ id: 111, result: { decision: "accept" } }]);
});

test("Computer Use approval forwarding preserves session-only scope", async () => {
  const replies = [];
  const request = computerUseApprovalRequest({ id: 112 });
  assert.equal(scheduleApprovalServerRequestReply(
    request,
    async () => ({
      status: 200,
      json: { schema_version: 1, decision: "allow" }
    }),
    (reply) => replies.push(reply)
  ), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, [{
    id: 112,
    result: {
      action: "accept",
      content: {},
      _meta: { persist: "session" }
    }
  }]);
});

test("approval bridge failure and 204 responses fail closed asynchronously", async () => {
  const request = {
    id: 121,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-121", turnId: "turn-121" }
  };
  for (const handler of [
    async () => ({ status: 204 }),
    async () => { throw new Error("bridge unavailable"); }
  ]) {
    const replies = [];
    assert.equal(scheduleApprovalServerRequestReply(
      request,
      handler,
      (reply) => replies.push(reply)
    ), true);
    assert.deepEqual(replies, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{ id: 121, result: { decision: "decline" } }]);
  }

  let called = false;
  assert.equal(scheduleApprovalServerRequestReply(
    { id: 122, method: "item/tool/requestUserInput", params: {} },
    async () => { called = true; },
    () => {}
  ), false);
  await Promise.resolve();
  assert.equal(called, false);

  for (const handler of [
    async () => ({ status: 204 }),
    async () => { throw new Error("bridge unavailable"); }
  ]) {
    const replies = [];
    assert.equal(scheduleApprovalServerRequestReply(
      computerUseApprovalRequest({ id: 123 }),
      handler,
      (reply) => replies.push(reply)
    ), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{
      id: 123,
      result: { action: "decline", content: null, _meta: null }
    }]);
  }
});

test("unexpected interactive requests fail closed instead of hanging the turn", () => {
  assert.deepEqual(fallbackServerRequestReply({
    id: 41,
    method: "item/commandExecution/requestApproval"
  }), { id: 41, result: { decision: "decline" } });
  assert.deepEqual(fallbackServerRequestReply({
    id: 42,
    method: "item/permissions/requestApproval"
  }), {
    id: 42,
    result: { permissions: {}, scope: "turn" }
  });
  assert.deepEqual(fallbackServerRequestReply({
    id: 43,
    method: "mcpServer/elicitation/request"
  }), {
    id: 43,
    result: { action: "decline", content: null, _meta: null }
  });
  assert.deepEqual(fallbackServerRequestReply({
    id: 44,
    method: "unknown/request"
  }), {
    id: 44,
    error: {
      code: -32_601,
      message: "Open Codex to complete this interactive request."
    }
  });

  const before = Math.floor(Date.now() / 1_000);
  const currentTimeReply = fallbackServerRequestReply({
    id: 45,
    method: "currentTime/read"
  });
  const after = Math.floor(Date.now() / 1_000);
  assert.equal(currentTimeReply.id, 45);
  assert.ok(currentTimeReply.result.currentTimeAt >= before);
  assert.ok(currentTimeReply.result.currentTimeAt <= after);
});
