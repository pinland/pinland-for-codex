import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const INITIAL_CLIENT_ID = "initializing-client";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const OWNER_DISCOVERY_VERSION = 1;
const START_TURN_VERSION = 2;

const DEFINITELY_UNROUTED_ERRORS = new Set([
  "disabled",
  "no-client-found",
  "no-handler-for-request",
  "request-version-mismatch"
]);

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error("Codex Desktop IPC message is too large");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function socketOwnedByCurrentUser(socketPath) {
  try {
    const stat = fs.statSync(socketPath);
    const uid = process.getuid?.();
    return stat.isSocket()
      && (uid === undefined || stat.uid === uid)
      && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function defaultCodexDesktopIPCSocketPath(environment = process.env) {
  const codexHome = cleanString(environment.CODEX_HOME)
    || path.join(cleanString(environment.HOME) || os.homedir(), ".codex");
  return path.join(codexHome, "ipc", "ipc.sock");
}

export function desktopFollowerTurnStartParams(command) {
  return {
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
  };
}

function turnIDFromFollowerResponse(envelope) {
  const nested = cleanString(envelope?.result?.result?.turn?.id);
  if (nested) return nested;
  return cleanString(envelope?.result?.turn?.id);
}

function ipcError(message, options = {}) {
  const error = new Error(message);
  error.code = options.code;
  error.requestWasWritten = options.requestWasWritten === true;
  error.definiteResponse = options.definiteResponse === true;
  error.definitelyUnrouted = options.definitelyUnrouted === true;
  return error;
}

/**
 * A bounded client for Codex Desktop's same-user task-owner router. The router
 * forwards one request to the app-server process that already owns the task,
 * avoiding a competing app-server writer. This is distinct from the dynamic
 * app-tools pipe: the router supports multiple initialized local clients and
 * remains available for the Desktop process lifetime.
 */
export class CodexDesktopIPCClient {
  constructor(options = {}) {
    this.socketPath = cleanString(options.socketPath)
      || defaultCodexDesktopIPCSocketPath(options.environment);
    this.clientType = cleanString(options.clientType) || "pinland-for-codex";
    this.connectTimeoutMilliseconds = boundedTimeout(
      options.connectTimeoutMilliseconds,
      DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.requestTimeoutMilliseconds = boundedTimeout(
      options.requestTimeoutMilliseconds,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.createConnection = typeof options.createConnection === "function"
      ? options.createConnection
      : (socketPath) => net.createConnection(socketPath);
    this.validateSocket = typeof options.validateSocket === "function"
      ? options.validateSocket
      : socketOwnedByCurrentUser;
    this.socket = undefined;
    this.clientID = INITIAL_CLIENT_ID;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  async start() {
    if (this.socket?.writable && this.clientID !== INITIAL_CLIENT_ID) return;
    if (!this.validateSocket(this.socketPath)) {
      throw ipcError("Codex Desktop IPC is unavailable", {
        code: "CODEX_DESKTOP_IPC_UNAVAILABLE"
      });
    }

    const socket = this.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(socket, chunk));
    socket.on("error", (error) => this.handleDisconnect(socket, error));
    socket.on("close", () => this.handleDisconnect(
      socket,
      new Error("Codex Desktop IPC closed")
    ));

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        callback(value);
      };
      const onConnect = () => finish(resolve);
      const onError = (error) => finish(reject, error);
      const timer = setTimeout(
        () => finish(reject, ipcError("Codex Desktop IPC connect timed out", {
          code: "ETIMEDOUT"
        })),
        this.connectTimeoutMilliseconds
      );
      timer.unref?.();
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    const initialized = await this.sendRequest(
      "initialize",
      { clientType: this.clientType },
      { version: 0, timeoutMilliseconds: this.connectTimeoutMilliseconds }
    );
    const clientID = cleanString(initialized?.result?.clientId);
    if (!clientID) {
      throw ipcError("Codex Desktop IPC returned an invalid client id", {
        requestWasWritten: true,
        definiteResponse: true
      });
    }
    this.clientID = clientID;
  }

  async findThreadOwner(conversationID) {
    await this.start();
    const envelope = await this.sendRequest(
      "thread-owner-discovery",
      { hostId: "local", conversationId: conversationID },
      { version: OWNER_DISCOVERY_VERSION }
    );
    const ownerClientID = cleanString(envelope?.handledByClientId);
    if (!ownerClientID || ownerClientID === this.clientID) {
      throw ipcError("Codex Desktop task owner is unavailable", {
        code: "no-client-found",
        requestWasWritten: true,
        definiteResponse: true,
        definitelyUnrouted: true
      });
    }
    return ownerClientID;
  }

  async startFollowerTurn(command) {
    let ownerClientID;
    try {
      ownerClientID = await this.findThreadOwner(command.session_id);
    } catch (error) {
      // Initialization and discovery carry no user prompt, so any failure in
      // this phase is known to precede delivery even if its frame was written.
      error.beforeInstruction = true;
      throw error;
    }
    const envelope = await this.sendRequest(
      "thread-follower-start-turn",
      desktopFollowerTurnStartParams(command),
      {
        version: START_TURN_VERSION,
        targetClientID: ownerClientID
      }
    );
    if (envelope?.handledByClientId !== ownerClientID
        || !turnIDFromFollowerResponse(envelope)) {
      throw ipcError("Codex Desktop returned an invalid turn result", {
        requestWasWritten: true
      });
    }
    return { accepted: true };
  }

  sendRequest(method, params, options) {
    const socket = this.socket;
    if (!socket?.writable) {
      return Promise.reject(ipcError("Codex Desktop IPC is unavailable", {
        code: "CODEX_DESKTOP_IPC_UNAVAILABLE"
      }));
    }
    const requestID = randomUUID();
    const message = {
      type: "request",
      requestId: requestID,
      sourceClientId: this.clientID,
      version: options.version,
      method,
      params,
      timeoutMs: boundedTimeout(
        options.timeoutMilliseconds,
        this.requestTimeoutMilliseconds
      ),
      ...(cleanString(options.targetClientID)
        ? { targetClientId: options.targetClientID }
        : {})
    };
    let frame;
    try {
      frame = encodeFrame(message);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(ipcError(`${method} timed out`, {
          code: "ETIMEDOUT",
          requestWasWritten: true
        }));
      }, message.timeoutMs + 250);
      timer.unref?.();
      this.pending.set(requestID, { resolve, reject, timer, method });
      try {
        socket.write(frame, (error) => {
          if (error) this.handleDisconnect(socket, error);
        });
      } catch (error) {
        this.pending.delete(requestID);
        clearTimeout(timer);
        reject(ipcError(error?.message || `${method} write failed`, {
          requestWasWritten: true
        }));
      }
    });
  }

  handleData(socket, chunk) {
    if (this.socket !== socket || !chunk?.length) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (frameLength === 0 || frameLength > MAX_FRAME_BYTES) {
        this.handleDisconnect(socket, new Error("Invalid Codex Desktop IPC frame"));
        socket.destroy();
        return;
      }
      if (this.buffer.length < frameLength + 4) return;
      const payload = this.buffer.subarray(4, frameLength + 4);
      this.buffer = this.buffer.subarray(frameLength + 4);
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.handleDisconnect(socket, new Error("Invalid Codex Desktop IPC JSON"));
        socket.destroy();
        return;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message?.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "success") {
        pending.resolve(message);
        return;
      }
      const reason = cleanString(message.error) || "request-failed";
      const stableReason = reason.split(":", 1)[0].trim();
      pending.reject(ipcError(reason, {
        code: stableReason,
        requestWasWritten: true,
        definiteResponse: true,
        definitelyUnrouted: DEFINITELY_UNROUTED_ERRORS.has(stableReason)
      }));
      return;
    }

    if (message?.type === "client-discovery-request") {
      this.writeMessage({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }

    if (message?.type === "request") {
      this.writeMessage({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-handler-for-request"
      });
    }
  }

  writeMessage(message) {
    if (this.socket?.writable) this.socket.write(encodeFrame(message));
  }

  handleDisconnect(socket, reason) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clientID = INITIAL_CLIENT_ID;
    this.buffer = Buffer.alloc(0);
    const error = ipcError(reason?.message || "Codex Desktop IPC closed", {
      code: reason?.code,
      requestWasWritten: true
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.clientID = INITIAL_CLIENT_ID;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    const error = ipcError("Codex Desktop IPC client closed", {
      requestWasWritten: true
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function desktopIPCFailure(error) {
  if (error?.beforeInstruction || error?.definitelyUnrouted) {
    return {
      result: { accepted: false, error_code: "codex_unavailable" },
      fallbackToOwner: true
    };
  }
  if (error?.requestWasWritten) {
    return {
      result: { accepted: false, error_code: "delivery_uncertain" }
    };
  }
  return {
    result: { accepted: false, error_code: "codex_unavailable" },
    fallbackToOwner: true
  };
}

/**
 * Sends exactly once through the Desktop task owner. A missing router/owner is
 * proven before the prompt-bearing request and may fall back to a temporary
 * app-server. Once that request is written, any lost response is outcome-
 * unknown and is tombstoned so Pinland can never duplicate it.
 */
export async function dispatchInstructionWithDesktopIPC(
  command,
  ledger,
  options = {}
) {
  let replay;
  try {
    replay = ledger.beginDispatch(command.command_id);
  } catch {
    return { result: { accepted: false, error_code: "request_failed" } };
  }
  if (replay) return { result: replay };

  const createClient = typeof options.createClient === "function"
    ? options.createClient
    : () => new CodexDesktopIPCClient(options.clientOptions);
  let client;
  let dispatch;
  try {
    client = createClient();
    dispatch = { result: await client.startFollowerTurn(command) };
  } catch (error) {
    dispatch = desktopIPCFailure(error);
  } finally {
    client?.close?.();
  }

  if (dispatch.fallbackToOwner) {
    try {
      if (ledger.releaseDispatch(command.command_id)) return dispatch;
    } catch {
      // A lost reservation can no longer cross into a second writer safely.
    }
    return { result: { accepted: false, error_code: "delivery_uncertain" } };
  }

  try {
    ledger.recordResult(command.command_id, dispatch.result);
    return dispatch;
  } catch {
    return { result: { accepted: false, error_code: "delivery_uncertain" } };
  }
}
