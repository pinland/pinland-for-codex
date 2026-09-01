import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchInstructionForAvailableHost,
  dispatchInstructionWithTemporaryOwner,
  InstructionOwnerCapacity
} from "./instruction-owner-lifecycle.mjs";

const command = {
  schema_version: 1,
  command_id: "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5",
  session_id: "01a03823-c96f-75d0-a69f-23936c6246f6",
  prompt: "Continue with the focused fix."
};

function ledger() {
  let reservation = false;
  let result;
  return {
    beginDispatch() {
      if (result) return result;
      if (reservation) {
        return { accepted: false, error_code: "delivery_uncertain" };
      }
      reservation = true;
      return undefined;
    },
    releaseDispatch() {
      if (!reservation) return false;
      reservation = false;
      return true;
    },
    recordResult(_commandID, value) {
      reservation = false;
      result = value;
    }
  };
}

test("an owned turn keeps its one-shot client until the matching terminal event", async () => {
  let releaseTerminal;
  const terminal = new Promise((resolve) => { releaseTerminal = resolve; });
  let closeCount = 0;
  const calls = [];
  const owner = {
    async request(method) {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { status: { type: "idle" } } };
      }
      return { turn: { id: "turn-owned" } };
    },
    async waitForTurnTerminal(threadID, turnID) {
      assert.equal(threadID, command.session_id);
      assert.equal(turnID, "turn-owned");
      await terminal;
    },
    async close() { closeCount += 1; }
  };

  const dispatch = await dispatchInstructionWithTemporaryOwner(
    async () => owner,
    command,
    ledger()
  );
  assert.deepEqual(dispatch.result, { accepted: true });
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
  assert.equal(dispatch.ownerClient, owner);
  assert.equal(closeCount, 0);

  releaseTerminal();
  await dispatch.releasePromise;
  assert.equal(closeCount, 1);
});

test("an active Desktop writer fails truthfully and the temporary owner closes", async () => {
  const calls = [];
  let closeCount = 0;
  const owner = {
    async request(method) {
      calls.push(method);
      if (method === "thread/resume") {
        const error = new Error("thread already has an active writer");
        error.code = -32_600;
        throw error;
      }
    },
    async close() { closeCount += 1; }
  };

  const dispatch = await dispatchInstructionWithTemporaryOwner(
    async () => owner,
    command,
    ledger()
  );
  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "thread_active" },
    fallbackToDesktop: true
  });
  assert.deepEqual(calls, ["thread/resume"]);
  assert.equal(closeCount, 1);
});

test("an uncertain turn/start keeps the owner through observed start and completion", async () => {
  const calls = [];
  let closeCount = 0;
  const owner = {
    async request(method) {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { status: { type: "idle" } } };
      }
      throw new Error("turn/start timed out");
    },
    async waitForTurnStarted(threadID) {
      assert.equal(threadID, command.session_id);
      return { threadID, turnID: "turn-observed" };
    },
    async waitForTurnTerminal(threadID, turnID) {
      assert.equal(threadID, command.session_id);
      assert.equal(turnID, "turn-observed");
    },
    async close() { closeCount += 1; }
  };

  const dispatch = await dispatchInstructionWithTemporaryOwner(
    async () => owner,
    command,
    ledger()
  );
  assert.deepEqual(dispatch.result, {
    accepted: false,
    error_code: "delivery_uncertain"
  });
  assert.equal(closeCount, 0);
  await dispatch.releasePromise;
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
  assert.equal(closeCount, 1);
});

test("a replayed command never creates an owner connection", async () => {
  let ownerCount = 0;
  const dispatch = await dispatchInstructionWithTemporaryOwner(
    async () => {
      ownerCount += 1;
      throw new Error("must not be called");
    },
    command,
    {
      beginDispatch() { return { accepted: true }; }
    }
  );

  assert.deepEqual(dispatch, { result: { accepted: true } });
  assert.equal(ownerCount, 0);
});

test("owner capacity hard-caps processes and releases the unsent reservation", async () => {
  const capacity = new InstructionOwnerCapacity(1);
  let releaseTerminal;
  const terminal = new Promise((resolve) => { releaseTerminal = resolve; });
  let ownerCount = 0;
  let beginDispatchCount = 0;
  const firstCommand = { ...command };
  const secondCommand = {
    ...command,
    command_id: "e3b0c442-98fc-4c14-9afb-f4c8996fb924"
  };
  const owner = {
    async request(method) {
      if (method === "thread/resume") {
        return { thread: { status: { type: "idle" } } };
      }
      return { turn: { id: "turn-capacity" } };
    },
    async waitForTurnTerminal() { await terminal; },
    async close() {}
  };
  const sharedLedger = {
    beginDispatch() {
      beginDispatchCount += 1;
      return undefined;
    },
    releaseDispatch() { return true; },
    recordResult() {}
  };

  const first = await dispatchInstructionWithTemporaryOwner(
    async () => {
      ownerCount += 1;
      return owner;
    },
    firstCommand,
    sharedLedger,
    { ownerCapacity: capacity }
  );
  assert.equal(capacity.activeCount, 1);

  const second = await dispatchInstructionWithTemporaryOwner(
    async () => {
      ownerCount += 1;
      throw new Error("capacity must reject before process creation");
    },
    secondCommand,
    sharedLedger,
    { ownerCapacity: capacity }
  );
  assert.deepEqual(second, {
    result: { accepted: false, error_code: "codex_unavailable" },
    fallbackToDesktop: true
  });
  assert.equal(ownerCount, 1);
  assert.equal(beginDispatchCount, 2);
  assert.equal(capacity.activeCount, 1);

  releaseTerminal();
  await first.releasePromise;
  assert.equal(capacity.activeCount, 0);
});

test("active-writer failures release owner capacity for the next command", async () => {
  const capacity = new InstructionOwnerCapacity(1);
  let ownerCount = 0;
  const makeOwner = async () => {
    ownerCount += 1;
    return {
      async request(method) {
        if (method === "thread/resume") {
          const error = new Error("thread already has an active writer");
          error.code = -32_600;
          throw error;
        }
      },
      async close() {}
    };
  };

  const first = await dispatchInstructionWithTemporaryOwner(
    makeOwner,
    command,
    ledger(),
    { ownerCapacity: capacity }
  );
  assert.deepEqual(first, {
    result: { accepted: false, error_code: "thread_active" },
    fallbackToDesktop: true
  });
  assert.equal(capacity.activeCount, 0);

  const second = await dispatchInstructionWithTemporaryOwner(
    makeOwner,
    {
      ...command,
      command_id: "e3b0c442-98fc-4c14-9afb-f4c8996fb924"
    },
    ledger(),
    { ownerCapacity: capacity }
  );
  assert.deepEqual(second, {
    result: { accepted: false, error_code: "thread_active" },
    fallbackToDesktop: true
  });
  assert.equal(ownerCount, 2);
  assert.equal(capacity.activeCount, 0);
});

test("owner startup failure releases capacity", async () => {
  const capacity = new InstructionOwnerCapacity(1);
  const result = await dispatchInstructionWithTemporaryOwner(
    async () => { throw new Error("spawn failed"); },
    command,
    ledger(),
    { ownerCapacity: capacity }
  );

  assert.deepEqual(result, {
    result: { accepted: false, error_code: "codex_unavailable" },
    fallbackToDesktop: true
  });
  assert.equal(capacity.activeCount, 0);
  assert.equal(typeof capacity.tryAcquire(), "function");
});

test("Desktop route is selected exactly once without starting a competing owner", async () => {
  let ownerDispatchCount = 0;
  let providerDispatchCount = 0;
  let desktopDispatchCount = 0;
  const dispatch = await dispatchInstructionForAvailableHost(
    async () => {
      desktopDispatchCount += 1;
      return { result: { accepted: true } };
    },
    async () => {
      providerDispatchCount += 1;
      return { result: { accepted: true } };
    },
    async () => {
      ownerDispatchCount += 1;
      return { result: { accepted: true } };
    }
  );

  assert.deepEqual(dispatch, { result: { accepted: true } });
  assert.equal(desktopDispatchCount, 1);
  assert.equal(providerDispatchCount, 0);
  assert.equal(ownerDispatchCount, 0);
});

test("an uncertain Desktop send never falls back and cannot duplicate", async () => {
  let ownerDispatchCount = 0;
  let providerDispatchCount = 0;
  const dispatch = await dispatchInstructionForAvailableHost(
    async () => ({
      result: { accepted: false, error_code: "delivery_uncertain" }
    }),
    async () => {
      providerDispatchCount += 1;
      return { result: { accepted: true } };
    },
    async () => {
      ownerDispatchCount += 1;
      return { result: { accepted: true } };
    }
  );

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "delivery_uncertain" }
  });
  assert.equal(providerDispatchCount, 0);
  assert.equal(ownerDispatchCount, 0);
});

test("cross-task provider handles an idle task whose Desktop owner is undiscoverable", async () => {
  let ownerDispatchCount = 0;
  const dispatch = await dispatchInstructionForAvailableHost(
    async () => ({
      result: { accepted: false, error_code: "codex_unavailable" },
      fallbackToOwner: true
    }),
    async () => ({ result: { accepted: true } }),
    async () => {
      ownerDispatchCount += 1;
      return { result: { accepted: true } };
    }
  );

  assert.deepEqual(dispatch, { result: { accepted: true } });
  assert.equal(ownerDispatchCount, 0);
});

test("an uncertain cross-task provider result never reaches a second writer", async () => {
  let ownerDispatchCount = 0;
  const dispatch = await dispatchInstructionForAvailableHost(
    async () => ({
      result: { accepted: false, error_code: "codex_unavailable" },
      fallbackToOwner: true
    }),
    async () => ({
      result: { accepted: false, error_code: "delivery_uncertain" }
    }),
    async () => {
      ownerDispatchCount += 1;
      return { result: { accepted: true } };
    }
  );

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "delivery_uncertain" }
  });
  assert.equal(ownerDispatchCount, 0);
});

test("temporary owner is used only when both Desktop routes are absent", async () => {
  const ownerClient = {};
  const releasePromise = Promise.resolve();
  const dispatch = await dispatchInstructionForAvailableHost(
    async () => ({
      result: { accepted: false, error_code: "codex_unavailable" },
      fallbackToOwner: true
    }),
    async () => ({
      result: { accepted: false, error_code: "codex_unavailable" },
      fallbackToOwner: true
    }),
    async () => ({
      result: { accepted: true },
      ownerClient,
      releasePromise
    })
  );

  assert.deepEqual(dispatch, {
    result: { accepted: true },
    ownerClient,
    releasePromise
  });
});

test("headless owner hints never leak into the public dispatch result", async () => {
  const dispatch = await dispatchInstructionForAvailableHost(
    undefined,
    undefined,
    async () => ({
      result: { accepted: false, error_code: "thread_active" },
      fallbackToDesktop: true
    })
  );

  assert.deepEqual(dispatch, {
    result: { accepted: false, error_code: "thread_active" }
  });
});
