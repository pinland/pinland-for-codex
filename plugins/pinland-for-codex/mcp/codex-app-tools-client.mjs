import net from "node:net";

import { instructionFailureCode } from "./outbound-instructions.mjs";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const PIPE_PATH_ENVIRONMENT_KEY = "CODEX_APP_TOOLS_PIPE_PATH";

function transportError(message, { requestWasWritten = false, definiteResponse = false } = {}) {
  const error = new Error(message);
  error.requestWasWritten = requestWasWritten;
  error.definiteResponse = definiteResponse;
  return error;
}

function encodeFrame(message) {
  const payload = Buffer.from(message, "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw transportError("Codex app tools request was too large");
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function returnedThreadID(result) {
  if (!Array.isArray(result?.contentItems)) return undefined;
  for (const item of result.contentItems) {
    if (item?.type !== "inputText" || typeof item.text !== "string") continue;
    try {
      const payload = JSON.parse(item.text);
      if (typeof payload?.threadId === "string" && payload.threadId.trim()) {
        return payload.threadId.trim();
      }
    } catch {
      // A successful host reply must still identify the destination task.
    }
  }
  return undefined;
}

export function codexAppToolsPipePath(environment = process.env) {
  const value = environment?.[PIPE_PATH_ENVIRONMENT_KEY];
  if (typeof value !== "string") return undefined;
  const pipePath = value.trim();
  return pipePath && pipePath.length <= 4_096 ? pipePath : undefined;
}

export function codexAppToolsInstructionParams(command) {
  return {
    arguments: {
      threadId: command.session_id,
      prompt: command.prompt,
      hostId: "local"
    },
    callId: `pinland-command-${command.command_id}`,
    namespace: "codex_app",
    // The host records a cross-task message on this source task. Using the
    // destination as the source keeps the interaction self-contained while
    // still going through Codex's supported task messaging path.
    threadId: command.session_id,
    tool: "send_message_to_thread",
    turnId: `pinland-command-${command.command_id}`
  };
}

export class CodexAppToolsClient {
  constructor(pipePath, options = {}) {
    if (typeof pipePath !== "string" || !pipePath.trim()) {
      throw new TypeError("pipePath must be a non-empty string");
    }
    this.pipePath = pipePath.trim();
    this.createConnection = typeof options.createConnection === "function"
      ? options.createConnection
      : (path) => net.createConnection(path);
    this.socket = undefined;
    this.connecting = undefined;
    this.pendingData = Buffer.alloc(0);
    this.pending = new Map();
    this.nextID = 1;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = this.createConnection(this.pipePath);
      const failConnection = (error) => {
        socket.destroy();
        reject(transportError(error?.message || "Codex app tools are unavailable"));
      };
      socket.once("error", failConnection);
      socket.once("connect", () => {
        socket.off("error", failConnection);
        this.socket = socket;
        this.connecting = undefined;
        socket.on("data", (chunk) => this.handleData(socket, chunk));
        socket.on("error", (error) => this.handleDisconnect(socket, error));
        socket.on("close", () => this.handleDisconnect(
          socket,
          new Error("Codex app tools pipe closed")
        ));
        resolve(socket);
      });
    }).catch((error) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  async request(method, params, timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS) {
    const socket = await this.connect();
    const id = this.nextID++;
    let frame;
    try {
      frame = encodeFrame(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
    } catch (error) {
      error.requestWasWritten = false;
      throw error;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(transportError(`${method} timed out`, { requestWasWritten: true }));
      }, Math.max(1, timeoutMilliseconds));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(frame, (error) => {
          if (error) this.handleDisconnect(socket, error);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(transportError(
          error?.message || "Codex app tools write failed",
          { requestWasWritten: true }
        ));
      }
    });
  }

  handleData(socket, chunk) {
    if (this.socket !== socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const frameLength = this.pendingData.readUInt32LE(0);
      if (frameLength > MAX_FRAME_BYTES) {
        socket.destroy();
        this.handleDisconnect(socket, new Error("Codex app tools response was too large"));
        return;
      }
      if (this.pendingData.length < frameLength + 4) return;
      const payload = this.pendingData.subarray(4, frameLength + 4);
      this.pendingData = this.pendingData.subarray(frameLength + 4);

      let response;
      try {
        response = JSON.parse(payload.toString("utf8"));
      } catch {
        socket.destroy();
        this.handleDisconnect(socket, new Error("Codex app tools returned invalid JSON"));
        return;
      }
      const responseID = Number(response?.id);
      const pending = this.pending.get(responseID);
      if (!pending) continue;
      this.pending.delete(responseID);
      clearTimeout(pending.timer);
      if (response?.jsonrpc !== "2.0") {
        pending.reject(transportError(
          "Codex app tools returned an invalid response",
          { requestWasWritten: true }
        ));
      } else if (response.error) {
        const error = transportError(
          typeof response.error.message === "string"
            ? response.error.message
            : "Codex app tool request failed",
          { requestWasWritten: true, definiteResponse: true }
        );
        error.code = response.error.code;
        pending.reject(error);
      } else if (Object.prototype.hasOwnProperty.call(response, "result")) {
        pending.resolve(response.result);
      } else {
        pending.reject(transportError(
          "Codex app tools returned an invalid response",
          { requestWasWritten: true }
        ));
      }
    }
  }

  handleDisconnect(socket, reason) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.pendingData = Buffer.alloc(0);
    const error = transportError(
      reason?.message || "Codex app tools pipe closed",
      { requestWasWritten: true }
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.pendingData = Buffer.alloc(0);
    socket?.destroy();
    const error = transportError("Codex app tools client closed", {
      requestWasWritten: true
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Keeps one verified Desktop tools connection for the daemon lifetime.
 *
 * The native host channel is designed like the bundled Codex app-tools MCP:
 * connect once, perform a read-only tools/list handshake, and reuse that
 * socket. Creating and closing a fresh native connection for every composer
 * click eventually leaves the host unable to confirm delivery. A failed
 * handshake is side-effect free, so callers may safely use the standalone
 * owner fallback without risking a duplicate instruction.
 */
export class CodexAppToolsChannel {
  constructor(pipePath, options = {}) {
    if (typeof pipePath !== "string" || !pipePath.trim()) {
      throw new TypeError("pipePath must be a non-empty string");
    }
    this.pipePath = pipePath.trim();
    this.clientOptions = options.clientOptions ?? {};
    this.handshakeTimeoutMilliseconds = Number.isFinite(
      options.handshakeTimeoutMilliseconds
    )
      ? Math.max(1, options.handshakeTimeoutMilliseconds)
      : DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.client = undefined;
    this.connecting = undefined;
  }

  async verifiedClient() {
    if (this.client?.socket && !this.client.socket.destroyed) {
      return this.client;
    }
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const candidate = new CodexAppToolsClient(
        this.pipePath,
        this.clientOptions
      );
      try {
        const result = await candidate.request(
          "tools/list",
          { threadStartKind: "all" },
          this.handshakeTimeoutMilliseconds
        );
        if (!Array.isArray(result?.tools)
            || !result.tools.some((tool) => tool?.name === "send_message_to_thread")) {
          throw transportError("Codex task messaging is unavailable");
        }
        this.client = candidate;
        return candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async warm() {
    try {
      await this.verifiedClient();
      return true;
    } catch {
      return false;
    }
  }

  async dispatch(command) {
    let client;
    try {
      client = await this.verifiedClient();
    } catch {
      return { accepted: false, error_code: "codex_unavailable" };
    }

    const result = await dispatchInstructionViaCodexAppTools(client, command);
    if (result.error_code === "delivery_uncertain"
        || !client.socket
        || client.socket.destroyed) {
      if (this.client === client) this.client = undefined;
      client.close();
    }
    return result;
  }

  close() {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
}

export async function dispatchInstructionViaCodexAppTools(client, command) {
  let result;
  try {
    result = await client.request(
      "tools/call",
      codexAppToolsInstructionParams(command),
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  } catch (error) {
    if (error?.definiteResponse) {
      return { accepted: false, error_code: instructionFailureCode(error) };
    }
    return {
      accepted: false,
      error_code: error?.requestWasWritten
        ? "delivery_uncertain"
        : "codex_unavailable"
    };
  }

  if (result?.success !== true) {
    return { accepted: false, error_code: "request_failed" };
  }
  if (returnedThreadID(result) !== command.session_id) {
    // The host said it succeeded but did not prove which task received the
    // prompt. Treat this as outcome-unknown rather than inviting a duplicate.
    return { accepted: false, error_code: "delivery_uncertain" };
  }
  return { accepted: true };
}
