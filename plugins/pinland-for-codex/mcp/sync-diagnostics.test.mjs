import assert from "node:assert/strict";
import test from "node:test";
import { SyncDiagnosticsReporter, syncFailureCode } from "./sync-diagnostics.mjs";

test("failure categories never expose raw exception details", () => {
  assert.equal(syncFailureCode({ code: -32601 }), "unsupported_api");
  assert.equal(syncFailureCode(new Error("Codex executable is unavailable")), "codex_unavailable");
  assert.equal(syncFailureCode(new Error("Codex Pinned section is unavailable")), "pinned_section_unavailable");
  assert.equal(syncFailureCode(new Error("thread/list timed out")), "read_timed_out");
  assert.equal(syncFailureCode(new Error("/private/user/session token=secret")), "read_failed");
});

test("healthy changes are throttled, failures and recovery report immediately", async () => {
  let now = 0;
  const sent = [];
  const reporter = new SyncDiagnosticsReporter(async (...args) => {
    sent.push(args); return { status: 204 };
  }, () => now);
  await reporter.report("token", "producer", { revision: 1 });
  now = 900;
  await reporter.report("token", "producer", { revision: 2 });
  assert.equal(sent.length, 1);
  await reporter.report("token", "producer", { failure: "read_failed" });
  await reporter.report("token", "producer", { failure: "read_failed" });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1][2], {
    schema_version: 1, source_id: "producer", state: "error", failure: "read_failed"
  });
  await reporter.report("token", "producer", { revision: 3 });
  assert.equal(sent.length, 3);
  now += 30_000;
  await reporter.report("token", "producer", { revision: 3 });
  assert.equal(sent.length, 4);
});

test("old app is supported and reporting failures never throw", async () => {
  let calls = 0;
  const old = new SyncDiagnosticsReporter(async () => { calls++; return { status: 404 }; });
  await old.report("token", "producer", { revision: 1 });
  await old.report("token", "producer", { failure: "read_failed" });
  assert.equal(calls, 1);
  const broken = new SyncDiagnosticsReporter(async () => { throw new Error("network"); });
  await assert.doesNotReject(broken.report("token", "producer", { revision: 1 }));
});

test("rejected confirmation can be retried immediately after snapshot replay", async () => {
  let calls = 0;
  const reporter = new SyncDiagnosticsReporter(async () => ({ status: ++calls === 1 ? 409 : 204 }));
  assert.equal(await reporter.report("token", "producer", { revision: 1 }), 409);
  assert.equal(await reporter.report("token", "producer", { revision: 2 }), 204);
});

test("upgrading or restarting Pinland re-enables status reporting", async () => {
  let calls = 0;
  const reporter = new SyncDiagnosticsReporter(async () => ({ status: ++calls === 1 ? 404 : 204 }));
  reporter.observeBridge("old-epoch");
  assert.equal(await reporter.report("token", "producer", { revision: 1 }), 404);
  reporter.observeBridge("old-epoch");
  assert.equal(await reporter.report("token", "producer", { revision: 2 }), undefined);
  reporter.observeBridge("new-epoch");
  assert.equal(await reporter.report("token", "producer", { revision: 2 }), 204);
});
