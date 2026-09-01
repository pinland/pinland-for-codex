import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexAppToolsChannel,
  CodexAppToolsClient,
  codexAppToolsInstructionParams,
  codexAppToolsPipePath,
  dispatchInstructionViaCodexAppTools
} from "./codex-app-tools-client.mjs";

const command = {
  schema_version: 1,
  command_id: "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5",
  session_id: "01a03823-c96f-75d0-a69f-23936c6246f6",
  prompt: "Continue with the focused fix."
};

function successfulResult(threadID = command.session_id) {
  return {
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ threadId: threadID })
    }]
  };
}

test("the Codex host pipe and tool call are strictly scoped to the target task", () => {
  assert.equal(codexAppToolsPipePath({ CODEX_APP_TOOLS_PIPE_PATH: " /tmp/pipe " }), "/tmp/pipe");
  assert.equal(codexAppToolsPipePath({}), undefined);
  assert.deepEqual(codexAppToolsInstructionParams(command), {
    arguments: {
      threadId: command.session_id,
      prompt: command.prompt,
      hostId: "local"
    },
    callId: `pinland-command-${command.command_id}`,
    namespace: "codex_app",
    threadId: command.session_id,
    tool: "send_message_to_thread",
    turnId: `pinland-command-${command.command_id}`
  });
});

test("only a host-confirmed matching destination is accepted", async () => {
  const calls = [];
  const client = {
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      return successfulResult();
    }
  };
  assert.deepEqual(
    await dispatchInstructionViaCodexAppTools(client, command),
    { accepted: true }
  );
  assert.equal(calls[0].method, "tools/call");

  assert.deepEqual(await dispatchInstructionViaCodexAppTools({
    async request() { return successfulResult("different-task"); }
  }, command), {
    accepted: false,
    error_code: "delivery_uncertain"
  });

  assert.deepEqual(await dispatchInstructionViaCodexAppTools({
    async request() { return { success: false, contentItems: [] }; }
  }, command), {
    accepted: false,
    error_code: "request_failed"
  });
});

test("host transport failures never become false successful sends", async () => {
  const beforeWrite = new Error("pipe missing");
  beforeWrite.requestWasWritten = false;
  assert.deepEqual(await dispatchInstructionViaCodexAppTools({
    async request() { throw beforeWrite; }
  }, command), {
    accepted: false,
    error_code: "codex_unavailable"
  });

  const afterWrite = new Error("pipe closed");
  afterWrite.requestWasWritten = true;
  assert.deepEqual(await dispatchInstructionViaCodexAppTools({
    async request() { throw afterWrite; }
  }, command), {
    accepted: false,
    error_code: "delivery_uncertain"
  });

  const rejected = new Error("Thread not found");
  rejected.definiteResponse = true;
  rejected.code = -32_000;
  assert.deepEqual(await dispatchInstructionViaCodexAppTools({
    async request() { throw rejected; }
  }, command), {
    accepted: false,
    error_code: "thread_unavailable"
  });
});

test("native pipe framing matches the Codex host protocol", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-app-tools-"));
  const socketPath = path.join(directory, "host.sock");
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      const payload = Buffer.from(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result: successfulResult()
      }), "utf8");
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const client = new CodexAppToolsClient(socketPath);
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await client.request("tools/call", { hello: "world" }), successfulResult());
});

test("the daemon handshakes once and reuses one Desktop connection", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-app-tools-channel-"));
  const socketPath = path.join(directory, "host.sock");
  let connectionCount = 0;
  const methods = [];
  const server = net.createServer((socket) => {
    connectionCount += 1;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
        buffered = buffered.subarray(length + 4);
        methods.push(request.method);
        const result = request.method === "tools/list"
          ? { tools: [{ name: "send_message_to_thread" }] }
          : successfulResult();
        const payload = Buffer.from(JSON.stringify({
          id: request.id,
          jsonrpc: "2.0",
          result
        }), "utf8");
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length, 0);
        payload.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const channel = new CodexAppToolsChannel(socketPath);
  t.after(async () => {
    channel.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(await channel.warm(), true);
  assert.deepEqual(await channel.dispatch(command), { accepted: true });
  assert.deepEqual(await channel.dispatch({
    ...command,
    command_id: "9c56cc51-8e52-4557-b6dd-5b218c2bb9d3"
  }), { accepted: true });
  assert.equal(connectionCount, 1);
  assert.deepEqual(methods, ["tools/list", "tools/call", "tools/call"]);
});

test("a rejected read-only handshake is a definite Desktop outage", async () => {
  const missingSocketPath = path.join(
    os.tmpdir(),
    `pinland-missing-${process.pid}-${Date.now()}.sock`
  );
  const channel = new CodexAppToolsChannel(missingSocketPath, {
    handshakeTimeoutMilliseconds: 20
  });
  try {
    assert.deepEqual(await channel.dispatch(command), {
      accepted: false,
      error_code: "codex_unavailable"
    });
  } finally {
    channel.close();
  }
});
