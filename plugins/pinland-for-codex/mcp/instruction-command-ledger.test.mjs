import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InstructionCommandLedger } from "./instruction-command-ledger.mjs";
import { dispatchInstructionOnce } from "./outbound-instructions.mjs";

const command = {
  schema_version: 1,
  command_id: "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5",
  session_id: "01a03823-c96f-75d0-a69f-23936c6246f6",
  prompt: "A private prompt that must never be persisted."
};
const secondCommandID = "e3b0c442-98fc-4c14-9afb-f4c8996fb924";

function temporaryLedgerDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-ledger-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function idleClient(calls) {
  return {
    async request(method) {
      calls.push(method);
      return method === "thread/resume"
        ? { thread: { status: { type: "idle" } } }
        : {};
    }
  };
}

test("a crash after dispatching reloads as uncertain and never redispatches", async (t) => {
  const directory = temporaryLedgerDirectory(t);
  const firstProcessLedger = new InstructionCommandLedger(directory);
  firstProcessLedger.beginDispatch(command.command_id);

  const persisted = fs.readFileSync(firstProcessLedger.filePath, "utf8");
  assert.equal(persisted.includes(command.prompt), false);
  assert.equal(persisted.includes(command.session_id), false);
  assert.equal(persisted.includes("raw error"), false);

  const restartedLedger = new InstructionCommandLedger(directory);
  const calls = [];
  assert.deepEqual(
    await dispatchInstructionOnce(idleClient(calls), command, restartedLedger),
    { accepted: false, error_code: "delivery_uncertain" }
  );
  assert.deepEqual(calls, []);
});

test("an accepted command is persisted and replayed without a second dispatch", async (t) => {
  const directory = temporaryLedgerDirectory(t);
  const calls = [];
  const firstResult = await dispatchInstructionOnce(
    idleClient(calls),
    command,
    new InstructionCommandLedger(directory)
  );
  assert.deepEqual(firstResult, { accepted: true });
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);

  const replayResult = await dispatchInstructionOnce(
    idleClient(calls),
    command,
    new InstructionCommandLedger(directory)
  );
  assert.deepEqual(replayResult, { accepted: true });
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
});

test("an accepted 204 ack survives restart and replays an old claim", async (t) => {
  const directory = temporaryLedgerDirectory(t);
  const calls = [];
  const firstLedger = new InstructionCommandLedger(directory);
  assert.deepEqual(
    await dispatchInstructionOnce(idleClient(calls), command, firstLedger),
    { accepted: true }
  );
  firstLedger.acknowledge(command.command_id);

  const persisted = JSON.parse(fs.readFileSync(firstLedger.filePath, "utf8"));
  assert.equal(persisted.entries[0].state, "accepted");
  assert.ok(Number.isSafeInteger(persisted.entries[0].acknowledged_at_ms));

  const restartedLedger = new InstructionCommandLedger(directory);
  assert.deepEqual(
    await dispatchInstructionOnce(idleClient(calls), command, restartedLedger),
    { accepted: true }
  );
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
});

test("a definite failure is persisted and replayed without a second dispatch", async (t) => {
  const directory = temporaryLedgerDirectory(t);
  let requestCount = 0;
  const client = {
    async request() {
      requestCount += 1;
      throw new Error("Thread not found");
    }
  };
  const firstResult = await dispatchInstructionOnce(
    client,
    command,
    new InstructionCommandLedger(directory)
  );
  assert.deepEqual(firstResult, {
    accepted: false,
    error_code: "thread_unavailable"
  });

  const replayResult = await dispatchInstructionOnce(
    client,
    command,
    new InstructionCommandLedger(directory)
  );
  assert.deepEqual(replayResult, firstResult);
  assert.equal(requestCount, 1);
});

test("an acknowledged definite failure is removed and remains safely retryable", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const ledger = new InstructionCommandLedger(directory, { maxEntries: 1 });
  ledger.recordResult(command.command_id, {
    accepted: false,
    error_code: "invalid_payload"
  });
  assert.throws(() => ledger.recordResult(
    "e3b0c442-98fc-4c14-9afb-f4c8996fb924",
    { accepted: true }
  ));

  ledger.acknowledge(command.command_id);
  ledger.recordResult(
    "e3b0c442-98fc-4c14-9afb-f4c8996fb924",
    { accepted: true }
  );
  assert.deepEqual(
    new InstructionCommandLedger(directory, { maxEntries: 1 }).resultFor(
      "e3b0c442-98fc-4c14-9afb-f4c8996fb924"
    ),
    { accepted: true }
  );
});

test("acknowledged accepted tombstones expire and are capacity bounded", (t) => {
  const directory = temporaryLedgerDirectory(t);
  let now = 1_000;
  const options = {
    maxEntries: 2,
    acceptedTombstoneTTLMilliseconds: 100,
    now: () => now
  };
  const ledger = new InstructionCommandLedger(directory, options);
  ledger.recordResult(command.command_id, { accepted: true });
  ledger.acknowledge(command.command_id);
  now = 1_050;
  ledger.recordResult(secondCommandID, { accepted: true });
  ledger.acknowledge(secondCommandID);

  const thirdCommandID = "a3b0c442-98fc-4c14-9afb-f4c8996fb925";
  ledger.beginDispatch(thirdCommandID);
  assert.equal(new InstructionCommandLedger(directory, options).resultFor(
    command.command_id
  ), undefined);
  assert.deepEqual(new InstructionCommandLedger(directory, options).resultFor(
    secondCommandID
  ), { accepted: true });

  now = 1_151;
  const reloaded = new InstructionCommandLedger(directory, options);
  assert.equal(reloaded.resultFor(secondCommandID), undefined);
  assert.deepEqual(reloaded.resultFor(thirdCommandID), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
});

test("acknowledging an uncertain result retains its no-redispatch tombstone", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const ledger = new InstructionCommandLedger(directory);
  ledger.beginDispatch(command.command_id);
  ledger.recordResult(command.command_id, {
    accepted: false,
    error_code: "delivery_uncertain"
  });
  ledger.acknowledge(command.command_id);

  assert.deepEqual(
    new InstructionCommandLedger(directory).resultFor(command.command_id),
    { accepted: false, error_code: "delivery_uncertain" }
  );
});

test("two stale ledger instances merge mutations under the cross-process lock", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const first = new InstructionCommandLedger(directory);
  const second = new InstructionCommandLedger(directory);

  first.beginDispatch(command.command_id);
  second.beginDispatch(secondCommandID);

  const reloaded = new InstructionCommandLedger(directory);
  assert.deepEqual(reloaded.resultFor(command.command_id), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
  assert.deepEqual(reloaded.resultFor(secondCommandID), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
});

test("a stale terminal ack cannot erase another leader's uncertain entry", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const oldLeader = new InstructionCommandLedger(directory);
  const newLeader = new InstructionCommandLedger(directory);
  oldLeader.recordResult(command.command_id, { accepted: true });
  newLeader.recordResult(secondCommandID, {
    accepted: false,
    error_code: "delivery_uncertain"
  });

  oldLeader.acknowledge(command.command_id);

  assert.deepEqual(
    new InstructionCommandLedger(directory).resultFor(secondCommandID),
    { accepted: false, error_code: "delivery_uncertain" }
  );
});

test("two stale leaders cannot begin the same command twice", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const first = new InstructionCommandLedger(directory);
  const second = new InstructionCommandLedger(directory);
  assert.equal(first.beginDispatch(command.command_id), undefined);
  assert.deepEqual(second.beginDispatch(command.command_id), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
});

test("a proven preflight failure releases its reservation for one fallback", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const first = new InstructionCommandLedger(directory);
  assert.equal(first.beginDispatch(command.command_id), undefined);
  assert.equal(first.releaseDispatch(command.command_id), true);
  assert.equal(first.releaseDispatch(command.command_id), false);

  const fallback = new InstructionCommandLedger(directory);
  assert.equal(fallback.beginDispatch(command.command_id), undefined);
  fallback.recordResult(command.command_id, { accepted: true });
  assert.deepEqual(
    new InstructionCommandLedger(directory).resultFor(command.command_id),
    { accepted: true }
  );
});

test("an old malformed lock left by a crash is repaired", (t) => {
  const directory = temporaryLedgerDirectory(t);
  const lockPath = path.join(directory, "instruction-command-ledger.lock");
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  const old = new Date(Date.now() - 2_000);
  fs.utimesSync(lockPath, old, old);

  const ledger = new InstructionCommandLedger(directory);
  assert.equal(ledger.beginDispatch(command.command_id), undefined);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(new InstructionCommandLedger(directory).resultFor(command.command_id), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
});

test("a malformed existing ledger fails closed instead of starting over", async (t) => {
  const directory = temporaryLedgerDirectory(t);
  const ledgerPath = path.join(directory, "instruction-command-ledger.json");
  fs.writeFileSync(ledgerPath, "not-json", { mode: 0o600 });

  const calls = [];
  const result = await dispatchInstructionOnce(
    idleClient(calls),
    command,
    new InstructionCommandLedger(directory)
  );
  assert.deepEqual(result, {
    accepted: false,
    error_code: "delivery_uncertain"
  });
  assert.deepEqual(calls, []);
});
