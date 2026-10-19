import test from "node:test";
import assert from "node:assert/strict";
import { DesktopQuestionBridge, normalizeDesktopQuestion, desktopQuestionAnswer,
  patchQuestionRequests, hasQuestionReceipt } from "./desktop-question-bridge.mjs";

const request = (id = 7) => ({ id, method: "item/tool/requestUserInput", params: {
  threadId: "task", turnId: "turn", questions: [
    { id: "language", header: "Language", question: "Which language?", isOther: true,
      options: [{ label: "Swift", description: "Native" }, { label: "JS", description: "Web" }] },
    { id: "details", header: "Details", question: "Anything else?", options: null }
  ]
}});
const values = { language: "Swift", details: "中文和 English" };
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const pending = [], statuses = [], sent = [], follows = [];
  let callbacks, clock = 0;
  const client = { clientID: "pinland", start: async () => {}, close() {},
    findThreadOwner: async () => "owner", writeMessage: m => follows.push(m),
    sendRequest: async (...args) => { sent.push(args); return { handledByClientId: "owner", result: { ok: true } }; } };
  const bridge = new DesktopQuestionBridge({ now: () => clock,
    clientFactory: opts => { callbacks = opts; return client; },
    bridgeRequest: async (path, token, body) => {
      if (path.endsWith("/status")) { statuses.push(body); return { status: 204 }; }
      return new Promise(resolve => pending.push({ body, resolve }));
    }
  });
  const emit = (change, extra = {}) => callbacks.onBroadcast({ type: "broadcast",
    method: "thread-stream-state-changed", version: 11, sourceClientId: "owner",
    params: { hostId: "local", conversationId: "task", change }, ...extra });
  const snapshot = (requests, revision = 1) => emit({ type: "snapshot", revision, conversationState: { requests } });
  return { bridge, client, pending, statuses, sent, follows, emit, snapshot,
    advance: n => { clock += n; }, disconnect: () => callbacks.onDisconnect() };
}

test("normalizes only native questions; sensitive prompts and approvals stay native", () => {
  const q = normalizeDesktopQuestion(request(), "task");
  assert.equal(q.input.questions[1].isOther, true);
  assert.equal(desktopQuestionAnswer(q, values).answers.details.answers[0], values.details);
  for (const mutate of [r => r.method = "item/commandExecution/requestApproval",
    r => r.params.threadId = "other", r => r.params.questions[0].isSecret = true,
    r => r.params.questions[1].id = "language", r => r.params.questions[0].id = "__proto__",
    r => r.params.questions[0].question = "x".repeat(2001)]) {
    const r = request(); mutate(r); assert.equal(normalizeDesktopQuestion(r, "task"), null);
  }
  assert.equal(desktopQuestionAnswer(q, { ...values, extra: "unrequested" }), null);
  const r = request(); r.params.questions[0].isOther = false;
  assert.equal(desktopQuestionAnswer(normalizeDesktopQuestion(r, "task"), { ...values, language: "Rust" }), null);
});

test("request patches preserve indices and ignore transcript; reject unsafe paths", () => {
  const result = patchQuestionRequests([], [
    { op: "add", path: ["requests", 0], value: request() },
    { op: "replace", path: ["turnHistory"], value: [{ private: "not retained" }] }
  ]);
  assert.deepEqual(result, [request()]);
  assert.deepEqual(patchQuestionRequests(result, [{ op: "remove", path: ["requests", 0] }]), []);
  for (const path of [["requests", "__proto__", "bad"], ["requests", -1], []]) {
    assert.throws(() => patchQuestionRequests(result, [{ op: "add", path, value: {} }]));
  }
});

test("scoped question, one explicit answer, and matching receipt complete the relay", async () => {
  const h = harness(); await h.bridge.update(["task"], "token", "epoch");
  h.snapshot([request()]); assert.equal(h.pending.length, 1);
  h.pending[0].resolve({ status: 200, json: { answers: values } }); await flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], ["thread-follower-submit-user-input", {
    conversationId: "task", requestId: 7, response: { answers: {
      language: { answers: ["Swift"] }, details: { answers: [values.details] }
    }}
  }, { version: 1, targetClientID: "owner" }]);
  assert.equal(h.statuses.some(s => s.outcome === "confirmed"), false, "ok is not a receipt");
  h.emit({ type: "patches", baseRevision: 1, revision: 2, patches: [
    { op: "remove", path: ["requests", 0] },
    { op: "add", path: ["turnHistory", 0, "items", 1], value: {
      type: "userInputResponse", requestId: 7, turnId: "turn", completed: true,
      answers: { language: ["Swift"], details: [values.details] }
    }}
  ] });
  assert.equal(h.statuses.at(-1).outcome, "confirmed");
  h.snapshot([request()], 3); assert.equal(h.pending.length, 1, "no duplicate delivery"); h.bridge.close();
});

test("wrong owner, host, version, or thread cannot inject a question", async () => {
  const h = harness(); await h.bridge.update(["task"], "token", "epoch");
  const change = { type: "snapshot", revision: 1, conversationState: { requests: [request()] } };
  h.emit(change, { sourceClientId: "other" }); h.emit(change, { version: 10 });
  h.emit(change, { params: { hostId: "remote", conversationId: "task", change } });
  h.emit(change, { params: { hostId: "local", conversationId: "other", change } });
  assert.equal(h.pending.length, 0); h.bridge.close();
});

test("native resolution while editing invalidates the old answer", async () => {
  const h = harness(); await h.bridge.update(["task"], "token", "epoch"); h.snapshot([request()]);
  h.snapshot([], 2); h.pending[0].resolve({ status: 200, json: { answers: values } }); await flush();
  assert.equal(h.sent.length, 0); assert.equal(h.statuses.at(-1).outcome, "expired"); h.bridge.close();
});

test("revision gap, owner change, unpin, restart and disconnect invalidate pending input", async () => {
  for (const scenario of [
    async h => h.emit({ type: "patches", baseRevision: 9, revision: 10, patches: [] }),
    async h => { h.client.findThreadOwner = async () => "new-owner"; h.advance(16000); await h.bridge.update(["task"], "token", "epoch"); },
    async h => h.bridge.update([], "token", "epoch"),
    async h => h.bridge.update(["task"], "token", "new-epoch"),
    async h => h.disconnect()
  ]) {
    const h = harness(); await h.bridge.update(["task"], "token", "epoch"); h.snapshot([request()]);
    await scenario(h); h.pending[0].resolve({ status: 200, json: { answers: values } }); await flush();
    assert.equal(h.sent.length, 0); assert.ok(h.statuses.some(s => s.outcome === "expired")); h.bridge.close();
  }
});

test("ambiguous route failure is not retried", async () => {
  const h = harness(); await h.bridge.update(["task"], "token", "epoch"); h.snapshot([request()]);
  let attempts = 0; h.client.sendRequest = async () => { attempts++; throw Error("socket lost after write"); };
  h.pending[0].resolve({ status: 200, json: { answers: values } }); await flush();
  h.snapshot([request()], 2); assert.equal(attempts, 1); assert.equal(h.pending.length, 1);
  assert.equal(h.statuses.at(-1).outcome, "failed"); h.bridge.close();
});

test("receipt requires original request type, turn, complete flag, and exact answers", () => {
  const q = normalizeDesktopQuestion(request(), "task"), response = desktopQuestionAnswer(q, values);
  const receipt = { type: "userInputResponse", requestId: 7, turnId: "turn", completed: true,
    answers: { language: ["Swift"], details: [values.details] } };
  assert.ok(hasQuestionReceipt({ items: [receipt] }, q, response));
  for (const change of [{ requestId: "7" }, { turnId: "other" }, { completed: false }, { answers: { language: ["JS"] } }]) {
    assert.equal(hasQuestionReceipt({ ...receipt, ...change }, q, response), false);
  }
});
