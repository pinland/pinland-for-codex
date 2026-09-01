import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  fallbackServerRequestReply,
  scheduleApprovalServerRequestReply
} from "./outbound-instructions.mjs";

const DEFAULT_CLOSE_GRACE_MS = 750;
const DEFAULT_FORCE_KILL_GRACE_MS = 750;
const MAX_BUFFERED_TURN_EVENTS = 32;

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function turnEventIdentity(message) {
  const params = message?.params;
  const threadID = nonemptyString(params?.threadId);
  const turnID = nonemptyString(params?.turn?.id) || nonemptyString(params?.turnId);
  return threadID && turnID ? { threadID, turnID } : undefined;
}

function eventKey(threadID, turnID) {
  return `${threadID}\u0000${turnID}`;
}

export class CodexAppServerClient {
  constructor(executable, approvalRequestHandler, options = {}) {
    this.executable = executable;
    this.approvalRequestHandler = approvalRequestHandler;
    this.spawnProcess = typeof options.spawnProcess === "function"
      ? options.spawnProcess
      : spawn;
    this.closeGraceMilliseconds = Number.isFinite(options.closeGraceMilliseconds)
      ? Math.max(0, options.closeGraceMilliseconds)
      : DEFAULT_CLOSE_GRACE_MS;
    this.forceKillGraceMilliseconds = Number.isFinite(options.forceKillGraceMilliseconds)
      ? Math.max(0, options.forceKillGraceMilliseconds)
      : DEFAULT_FORCE_KILL_GRACE_MS;
    this.clientName = nonemptyString(options.clientName) || "pinland-native-pins-sync";
    this.child = undefined;
    this.output = undefined;
    this.nextRequestID = 1;
    this.pending = new Map();
    this.closed = false;
    this.exited = false;
    this.closePromise = undefined;
    this.exitPromise = undefined;
    this.resolveExit = undefined;
    this.pinnedSectionID = undefined;
    this.startedTurns = [];
    this.terminalTurns = new Map();
    this.turnWaiters = new Set();
  }

  async start() {
    this.child = this.spawnProcess(this.executable, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env
    });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.output = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity
    });
    this.output.on("line", (line) => this.handleLine(line));
    const closeForTransportError = (error) => {
      this.failTransport(error);
      void this.close(error);
    };
    this.child.once("error", closeForTransportError);
    this.child.stdin.on("error", closeForTransportError);
    this.child.stdout.on("error", closeForTransportError);
    this.child.once("exit", () => this.handleExit());
    await this.request("initialize", {
      clientInfo: { name: this.clientName, version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) {
      this.handleNotification(message);
      return;
    }
    if (typeof message.method === "string") {
      const scheduled = scheduleApprovalServerRequestReply(
        message,
        this.approvalRequestHandler,
        (reply) => this.writeServerRequestReply(reply)
      );
      if (!scheduled) {
        this.writeServerRequestReply(fallbackServerRequestReply(message));
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || "Codex app-server request failed");
      error.code = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  handleNotification(message) {
    const identity = turnEventIdentity(message);
    if (!identity) return;
    if (message.method === "turn/started") {
      this.startedTurns.push(identity);
      if (this.startedTurns.length > MAX_BUFFERED_TURN_EVENTS) {
        this.startedTurns.shift();
      }
      this.resolveTurnWaiters("started", identity, message);
      return;
    }
    if (message.method === "turn/completed" || message.method === "turn/failed") {
      this.terminalTurns.set(eventKey(identity.threadID, identity.turnID), message);
      while (this.terminalTurns.size > MAX_BUFFERED_TURN_EVENTS) {
        this.terminalTurns.delete(this.terminalTurns.keys().next().value);
      }
      this.resolveTurnWaiters("terminal", identity, message);
    }
  }

  resolveTurnWaiters(kind, identity, message) {
    for (const waiter of [...this.turnWaiters]) {
      if (waiter.kind !== kind
          || waiter.threadID !== identity.threadID
          || (waiter.turnID && waiter.turnID !== identity.turnID)) {
        continue;
      }
      this.turnWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ ...identity, message });
    }
  }

  waitForTurnStarted(threadID, timeoutMilliseconds) {
    const existingIndex = this.startedTurns.findIndex(
      (event) => event.threadID === threadID
    );
    if (existingIndex >= 0) {
      const [identity] = this.startedTurns.splice(existingIndex, 1);
      return Promise.resolve(identity);
    }
    return this.waitForTurnEvent("started", threadID, undefined, timeoutMilliseconds);
  }

  waitForTurnTerminal(threadID, turnID, timeoutMilliseconds) {
    const existing = this.terminalTurns.get(eventKey(threadID, turnID));
    if (existing) {
      this.terminalTurns.delete(eventKey(threadID, turnID));
      return Promise.resolve({ threadID, turnID, message: existing });
    }
    return this.waitForTurnEvent("terminal", threadID, turnID, timeoutMilliseconds);
  }

  waitForTurnEvent(kind, threadID, turnID, timeoutMilliseconds) {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const waiter = { kind, threadID, turnID, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.turnWaiters.delete(waiter);
        reject(new Error(`Codex ${kind} notification timed out`));
      }, timeoutMilliseconds);
      waiter.timer.unref?.();
      this.turnWaiters.add(waiter);
    });
  }

  writeServerRequestReply(reply) {
    if (!this.closed && this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(reply)}\n`);
    }
  }

  request(method, params, timeout = 4_000) {
    if (this.closed || !this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is unavailable"));
    }
    const id = this.nextRequestID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (!this.closed && this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  failTransport(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.turnWaiters.clear();
  }

  handleExit() {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.failTransport(new Error("Codex app-server exited"));
  }

  async waitForExit(milliseconds) {
    if (this.exited || !this.exitPromise) return true;
    await Promise.race([this.exitPromise, delay(milliseconds)]);
    return this.exited;
  }

  close(reason = new Error("Codex app-server closed")) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose(reason);
    return this.closePromise;
  }

  async performClose(reason) {
    this.failTransport(reason);
    this.output?.close();
    if (!this.child || this.exited) return;

    try {
      this.child.stdin?.end();
    } catch {
      // Continue to process termination below.
    }
    if (await this.waitForExit(this.closeGraceMilliseconds)) return;

    try {
      this.child.kill("SIGTERM");
    } catch {
      // Continue to the final forced termination below.
    }
    if (await this.waitForExit(this.closeGraceMilliseconds)) return;

    try {
      this.child.kill("SIGKILL");
    } catch {
      // The process may have exited between the last check and this signal.
    }
    await this.waitForExit(this.forceKillGraceMilliseconds);
  }
}
