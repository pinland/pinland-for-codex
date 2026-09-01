import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexDesktopIPCClient,
  defaultCodexDesktopIPCSocketPath,
  desktopFollowerTurnStartParams,
  dispatchInstructionWithDesktopIPC
} from "./codex-desktop-ipc-client.mjs";

const command = {
  schema_version: 1,
  command_id: "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5",
  session_id: "01a03823-c96f-75d0-a69f-23936c6246f6",
  prompt: "Continue with the focused fix."
};

function encode(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decode(frame) {
  const length = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, length + 4).toString("utf8"));
}

class FakeRouterSocket extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.writable = true;
    this.destroyed = false;
    this.messages = [];
    queueMicrotask(() => this.emit("connect"));
  }

  write(frame, callback) {
    if (!this.writable) throw new Error("socket closed");
    const message = decode(frame);
    this.messages.push(message);
    callback?.();
    const response = this.handler(message, this);
    if (response) queueMicrotask(() => this.emit("data", encode(response)));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
  }
}

function successfulRouter(overrides = {}) {
  return new FakeRouterSocket((message) => {
    if (message.method === "initialize") {
      return {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { clientId: "pinland-client" }
      };
    }
    if (message.method === "thread-owner-discovery") {
      return overrides.discovery || {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        handledByClientId: "desktop-owner",
        result: { canHandle: true }
      };
    }
    if (message.method === "thread-follower-start-turn") {
      return overrides.start || {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        handledByClientId: "desktop-owner",
        result: { result: { turn: { id: "turn-accepted" } } }
      };
    }
    return undefined;
  });
}

function testClient(socket) {
  return new CodexDesktopIPCClient({
    socketPath: "/tmp/test-codex-ipc.sock",
    validateSocket: () => true,
    createConnection: () => socket,
    connectTimeoutMilliseconds: 100,
    requestTimeoutMilliseconds: 100
  });
}

function ledger() {
  let reserved = false;
  let result;
  return {
    beginDispatch() {
      if (result) return result;
      if (reserved) return { accepted: false, error_code: "delivery_uncertain" };
      reserved = true;
      return undefined;
    },
    releaseDispatch() {
      if (!reserved) return false;
      reserved = false;
      return true;
    },
    recordResult(_commandID, value) {
      reserved = false;
      result = value;
    },
    get result() { return result; },
    get reserved() { return reserved; }
  };
}

test("Desktop follower input preserves the command id and thread settings", () => {
  assert.equal(defaultCodexDesktopIPCSocketPath({
    CODEX_HOME: "/Users/test/.codex",
    HOME: "/ignored"
  }), "/Users/test/.codex/ipc/ipc.sock");
  assert.deepEqual(desktopFollowerTurnStartParams(command), {
    conversationId: command.session_id,
    turnStart: {
      request: {
        threadId: command.session_id,
        clientUserMessageId: command.command_id,
        input: [{ type: "text", text: command.prompt, text_elements: [] }],
        turnTrigger: "pinland"
      },
      context: { inheritThreadSettings: true }
    }
  });
});

test("a prompt is routed to the discovered Desktop task owner exactly once", async () => {
  const socket = successfulRouter();
  const receipt = ledger();
  const dispatch = await dispatchInstructionWithDesktopIPC(command, receipt, {
    createClient: () => testClient(socket)
  });

  assert.deepEqual(dispatch, { result: { accepted: true } });
  assert.deepEqual(receipt.result, { accepted: true });
  assert.deepEqual(socket.messages.map((message) => message.method), [
    "initialize",
    "thread-owner-discovery",
    "thread-follower-start-turn"
  ]);
  assert.equal(socket.messages[1].version, 1);
  assert.equal(socket.messages[2].version, 2);
  assert.equal(socket.messages[2].targetClientId, "desktop-owner");
  assert.deepEqual(socket.messages[2].params, desktopFollowerTurnStartParams(command));
});

test("missing Desktop ownership releases the receipt for one owner fallback", async () => {
  const socket = successfulRouter({
    discovery: {
      type: "response",
      requestId: "placeholder",
      resultType: "error",
      error: "no-client-found"
    }
  });
  // Response ids are assigned at write time; keep the error body deterministic.
  socket.handler = (message) => {
    if (message.method === "initialize") {
      return {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { clientId: "pinland-client" }
      };
    }
    return {
      type: "response",
      requestId: message.requestId,
      resultType: "error",
      error: "no-client-found"
    };
  };
  const receipt = ledger();
  const dispatch = await dispatchInstructionWithDesktopIPC(command, receipt, {
    createClient: () => testClient(socket)
  });

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "codex_unavailable" },
    fallbackToOwner: true
  });
  assert.equal(receipt.reserved, false);
  assert.equal(receipt.result, undefined);
  assert.equal(socket.messages.some(
    (message) => message.method === "thread-follower-start-turn"
  ), false);
});

test("a lost response after the prompt write is outcome-unknown and never falls back", async () => {
  const socket = successfulRouter();
  const originalHandler = socket.handler;
  socket.handler = (message, activeSocket) => {
    if (message.method !== "thread-follower-start-turn") {
      return originalHandler(message, activeSocket);
    }
    queueMicrotask(() => {
      activeSocket.writable = false;
      activeSocket.emit("close");
    });
    return undefined;
  };
  const receipt = ledger();
  const dispatch = await dispatchInstructionWithDesktopIPC(command, receipt, {
    createClient: () => testClient(socket)
  });

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "delivery_uncertain" }
  });
  assert.deepEqual(receipt.result, dispatch.result);
  assert.equal("fallbackToOwner" in dispatch, false);
});

test("an invalid success cannot invite a duplicate instruction", async () => {
  const socket = successfulRouter();
  const originalHandler = socket.handler;
  socket.handler = (message, activeSocket) => message.method === "thread-follower-start-turn"
    ? {
      type: "response",
      requestId: message.requestId,
      resultType: "success",
      handledByClientId: "desktop-owner",
      result: {}
    }
    : originalHandler(message, activeSocket);
  const receipt = ledger();
  const dispatch = await dispatchInstructionWithDesktopIPC(command, receipt, {
    createClient: () => testClient(socket)
  });

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "delivery_uncertain" }
  });
  assert.deepEqual(receipt.result, dispatch.result);
});

test("a completed receipt never reconnects to Desktop", async () => {
  const receipt = {
    beginDispatch() { return { accepted: true }; }
  };
  let clientCount = 0;
  const dispatch = await dispatchInstructionWithDesktopIPC(command, receipt, {
    createClient() {
      clientCount += 1;
      throw new Error("must not connect");
    }
  });

  assert.deepEqual(dispatch, { result: { accepted: true } });
  assert.equal(clientCount, 0);
});
