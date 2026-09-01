import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CodexAppServerClient } from "./codex-app-server-client.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitOnStdinEnd = true, exitOnSignal } = {}) {
    super();
    this.stdout = new PassThrough();
    this.signals = [];
    this.exitOnSignal = exitOnSignal;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString("utf8").trim().split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === "initialize" && message.id !== undefined) {
            setImmediate(() => this.send({ id: message.id, result: {} }));
          }
        }
        callback();
      },
      final: (callback) => {
        if (exitOnStdinEnd) setImmediate(() => this.emit("exit", 0, null));
        callback();
      }
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    if (this.exitOnSignal === signal) {
      setImmediate(() => this.emit("exit", null, signal));
    }
    return true;
  }
}

test("turn lifecycle notifications are buffered and matched to the owned turn", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerClient("/fake/codex", async () => ({}), {
    spawnProcess: () => child,
    closeGraceMilliseconds: 10,
    forceKillGraceMilliseconds: 10
  });
  await client.start();

  child.send({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } }
  });
  assert.deepEqual(await client.waitForTurnStarted("thread-1", 10), {
    threadID: "thread-1",
    turnID: "turn-1"
  });

  child.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
  const terminal = await client.waitForTurnTerminal("thread-1", "turn-1", 10);
  assert.equal(terminal.threadID, "thread-1");
  assert.equal(terminal.turnID, "turn-1");
  assert.equal(terminal.message.method, "turn/completed");

  await client.close();
  assert.equal(client.exited, true);
  assert.deepEqual(child.signals, []);
});

test("close waits for exit and escalates a stuck app-server through SIGKILL", async () => {
  const child = new FakeChild({
    exitOnStdinEnd: false,
    exitOnSignal: "SIGKILL"
  });
  const client = new CodexAppServerClient("/fake/codex", async () => ({}), {
    spawnProcess: () => child,
    closeGraceMilliseconds: 2,
    forceKillGraceMilliseconds: 10
  });
  await client.start();
  await client.close();

  assert.equal(client.exited, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
