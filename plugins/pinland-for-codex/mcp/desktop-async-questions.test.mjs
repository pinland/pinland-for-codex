import test from "node:test";
import assert from "node:assert/strict";
import { DesktopQuestionBridge, desktopQuestionAnswer } from "./desktop-question-bridge.mjs";
import { projectAsyncQuestionTurns, patchAsyncQuestionTurns, pendingAsyncQuestions,
  asyncQuestionRoute, asyncReplyText, hasAsyncQuestionReceipt, parseAsyncQuestionReply } from "./desktop-async-questions.mjs";

const history = (status = "inProgress") => ({ kind: "canonical", history: { entitiesByKey: {
  key: { turnId: "turn", turnStartedAtMs: 20, status, items: [
    { id: "private", type: "userMessage", content: [{ type: "text", text: "PRIVATE content not retained" }] },
    { id: "call-question", type: "agentMessage", delivery: "async", text: "",
      questions: [{ title: "Does this work?", options: ["Yes", "No"] }] }
  ] }
}}});
const basePath = ["turnHistory", "history", "entitiesByKey", "key", "items"];
const flush = () => new Promise(r => setImmediate(r));

test("reads native canonical async questions without retaining unrelated transcript", () => {
  const turns = projectAsyncQuestionTurns(history()), [q] = pendingAsyncQuestions(turns);
  assert.equal(q.input.questions[0].id, '["request_user_input_async","call-question",0]');
  assert.deepEqual(q.input.questions[0].options.map(o => o.label), ["Yes", "No"]);
  assert.equal(JSON.stringify(turns).includes("PRIVATE"), false);
  const response = desktopQuestionAnswer(q, { [q.input.questions[0].id]: "Custom answer" });
  const route = asyncQuestionRoute("task", q, response, "command", turns);
  assert.equal(route.method, "thread-follower-steer-turn");
  assert.equal(route.params.restoreMessage.context.constructor, Object);
  const idle = projectAsyncQuestionTurns(history("completed"));
  assert.equal(asyncQuestionRoute("task", q, response, "command", idle).method, "thread-follower-start-turn");
});

test("native accepted steer receipt, not pending or route acknowledgment, confirms answer", () => {
  let turns = projectAsyncQuestionTurns(history()), [q] = pendingAsyncQuestions(turns);
  const response = desktopQuestionAnswer(q, { [q.input.questions[0].id]: "Yes" });
  const input = [{ type: "text", text: asyncReplyText(q, response) }];
  turns = patchAsyncQuestionTurns(turns, [{ op: "add", path: [...basePath, 2], value: {
    id: "steer", type: "steeringUserMessage", status: "pending", input
  }}]);
  assert.equal(hasAsyncQuestionReceipt(turns, q, response), false);
  assert.equal(pendingAsyncQuestions(turns).length, 1);
  turns = patchAsyncQuestionTurns(turns, [{ op: "replace", path: [...basePath, 2, "status"], value: "accepted" }]);
  assert.equal(hasAsyncQuestionReceipt(turns, q, response), true);
  assert.equal(pendingAsyncQuestions(turns).length, 0);
  assert.equal(parseAsyncQuestionReply([{ type: "text", text: "hello" }]), null);
});

test("native answered question disappears, question removal cannot accept a stale answer", () => {
  let turns = projectAsyncQuestionTurns(history()), [q] = pendingAsyncQuestions(turns);
  turns = patchAsyncQuestionTurns(turns, [{ op: "remove", path: [...basePath, 1] }]);
  assert.equal(pendingAsyncQuestions(turns).length, 0);
  assert.equal(hasAsyncQuestionReceipt(turns, q, desktopQuestionAnswer(q, { [q.input.questions[0].id]: "Yes" })), false);
});

test("async cards use the same authenticated bridge and exact native question IDs", async () => {
  const statuses = [], sent = []; let options, answer;
  const client = { clientID: "pinland", start: async () => {}, close() {},
    findThreadOwner: async () => "owner", writeMessage() {},
    sendRequest: async (...args) => { sent.push(args); return { handledByClientId: "owner", result: { result: { turnId: "turn" } } }; }
  };
  const bridge = new DesktopQuestionBridge({ clientFactory: opts => { options = opts; return client; },
    bridgeRequest: async (path, token, body) => {
      if (path.endsWith("/status")) { statuses.push(body); return { status: 204 }; }
      return new Promise(resolve => { answer = { body, resolve }; });
    }
  });
  const emit = change => options.onBroadcast({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
    sourceClientId: "owner", params: { hostId: "local", conversationId: "task", change } });
  await bridge.update(["task"], "token", "epoch");
  emit({ type: "snapshot", revision: 1, conversationState: { requests: [], turnHistory: history() } });
  assert.ok(answer);
  answer.resolve({ status: 200, json: { answers: { [answer.body.input.questions[0].id]: "Yes" } } });
  await flush(); assert.equal(sent.length, 1); assert.equal(sent[0][0], "thread-follower-steer-turn");
  assert.equal(statuses.some(s => s.outcome === "confirmed"), false);
  emit({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "add", path: [...basePath, 2], value: {
    id: "steer", type: "steeringUserMessage", status: "accepted", input: sent[0][1].input
  }}] });
  assert.equal(statuses.at(-1).outcome, "confirmed"); bridge.close();
});
