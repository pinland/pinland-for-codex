import { desktopFollowerTurnStartParams } from "./codex-desktop-ipc-client.mjs";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
const bounded = (s, limit) => typeof s === "string" && s.length <= limit;

export function parseAsyncQuestionReply(input) {
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== "text") return null;
  const text = input[0].text?.trim();
  if (!bounded(text, 24000) || !text.startsWith(OPEN) || !text.endsWith(CLOSE)) return null;
  try {
    const parsed = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    return replies.length > 0 && replies.length <= 3 && replies.every(r =>
      bounded(r?.questionItemId, 200) && bounded(r.question, 2000) && bounded(r.answer, 4000)) ? replies : null;
  } catch { return null; }
}

function itemProjection(item) {
  if (!item || typeof item !== "object") return {};
  const base = { id: item.id, type: item.type };
  if (item.type === "agentMessage" && item.delivery === "async") {
    if (JSON.stringify(item.questions ?? []).length > 24000) return base;
    return { ...base, delivery: "async", text: bounded(item.text, 2000) ? item.text : "",
      questions: structuredClone(item.questions) };
  }
  if (item.type === "userMessage" || item.type === "steeringUserMessage") {
    const input = item.type === "userMessage" ? item.content : item.input;
    if (parseAsyncQuestionReply(input)) return { ...base, status: item.status, clientId: item.clientId,
      clientUserMessageId: item.clientUserMessageId,
      [item.type === "userMessage" ? "content" : "input"]: structuredClone(input) };
  }
  return base;
}

function turnProjection(turn) {
  if (!turn || !Array.isArray(turn.items) || turn.items.length > 20000) return null;
  return { turnId: turn.turnId, status: turn.status, turnStartedAtMs: turn.turnStartedAtMs,
    items: turn.items.map(itemProjection) };
}

function prune(turns) {
  let bytes = 0;
  return Object.fromEntries(Object.entries(turns).filter(([, t]) => t)
    .sort((a, b) => (b[1].turnStartedAtMs ?? 0) - (a[1].turnStartedAtMs ?? 0)).slice(0, 8)
    .filter(([, turn]) => { bytes += Buffer.byteLength(JSON.stringify(turn)); return bytes <= 512000; }));
}

export function projectAsyncQuestionTurns(history) {
  if (history?.kind !== "canonical") return {};
  const entities = history.history?.entitiesByKey;
  if (!entities || typeof entities !== "object") return {};
  const latest = Object.entries(entities).sort((a, b) => (b[1]?.turnStartedAtMs ?? 0) - (a[1]?.turnStartedAtMs ?? 0)).slice(0, 8);
  return prune(Object.fromEntries(latest.map(([k, t]) => [k, turnProjection(t)])));
}

// The native transcript can contain arbitrary tool output. This projection
// keeps structural positions, question fields and structured answer receipts
// only; ordinary messages/commands/attachments are never retained here.
export function patchAsyncQuestionTurns(previous, patches) {
  let turns = structuredClone(previous);
  for (const patch of patches) {
    const p = patch.path;
    if (!Array.isArray(p) || p[0] !== "turnHistory") continue;
    if (p.length === 1) { turns = projectAsyncQuestionTurns(patch.value); continue; }
    if (p[1] !== "history") continue;
    if (p.length === 2) { turns = projectAsyncQuestionTurns({ kind: "canonical", history: patch.value }); continue; }
    if (p[2] !== "entitiesByKey") continue;
    if (p.length === 3) { turns = projectAsyncQuestionTurns({ kind: "canonical", history: { entitiesByKey: patch.value } }); continue; }
    const key = p[3];
    if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("unsafe turn");
    if (p.length === 4) {
      if (patch.op === "remove") delete turns[key];
      else turns[key] = turnProjection(patch.value);
      continue;
    }
    const turn = turns[key];
    if (!turn) continue;
    if (p.length === 5 && ["status", "turnId", "turnStartedAtMs"].includes(p[4])) { turn[p[4]] = patch.value; continue; }
    if (p[4] !== "items") continue;
    if (p.length === 5) { turn.items = turnProjection({ items: patch.value })?.items ?? []; continue; }
    const index = p[5];
    if (index === "length" && p.length === 6 && Number.isInteger(patch.value) && patch.value <= turn.items.length && patch.value >= 0) {
      turn.items.length = patch.value; continue;
    }
    if (!Number.isInteger(index) || index < 0 || index > turn.items.length || turn.items.length > 20000) throw Error("invalid item index");
    if (p.length === 6) {
      if (patch.op === "remove") turn.items.splice(index, 1);
      else if (patch.op === "add") turn.items.splice(index, 0, itemProjection(patch.value));
      else turn.items[index] = itemProjection(patch.value);
      continue;
    }
    const item = turn.items[index];
    if (!item) throw Error("missing item");
    const field = p[6];
    if (field === "delivery" && patch.value === "async" && item.delivery !== "async") throw Error("question needs snapshot");
    if (!(["status", "content", "input", "clientId", "clientUserMessageId"].includes(field)
        || (item.delivery === "async" && ["questions", "text"].includes(field)))) continue;
    // Native writes entire question/answer values and subsequently the steer
    // status. An unknown partial schema fails closed and requests a snapshot.
    if (p.length !== 7) {
      if (item.delivery === "async" || item.content || item.input) throw Error("partial question update");
      continue;
    }
    if (patch.op === "remove") delete item[field]; else item[field] = structuredClone(patch.value);
    turn.items[index] = itemProjection(item);
  }
  return prune(turns);
}

export function asyncAnswerReceipts(turns) {
  return Object.values(turns).flatMap(t => t.items.flatMap(item => {
    if (item.type === "steeringUserMessage" && item.status !== "accepted") return [];
    if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return [];
    return parseAsyncQuestionReply(item.type === "userMessage" ? item.content : item.input) ?? [];
  }));
}

export function pendingAsyncQuestions(turns) {
  const latest = Object.values(turns).sort((a, b) => (b.turnStartedAtMs ?? 0) - (a.turnStartedAtMs ?? 0))[0];
  if (!latest || !bounded(latest.turnId, 200)) return [];
  const answered = new Set(asyncAnswerReceipts(turns).map(r => r.questionItemId));
  return latest.items.flatMap(item => {
    if (item.delivery !== "async" || !bounded(item.id, 120)) return [];
    const qs = item.questions?.length ? item.questions : [{ title: item.text, options: [] }];
    if (!Array.isArray(qs) || qs.length > 3 || qs.some(q => !q || !Array.isArray(q.options ?? []))) return [];
    const questions = qs.map((q, i) => ({
      id: item.questions?.length ? JSON.stringify(["request_user_input_async", item.id, i]) : item.id,
      question: q.title, header: "", options: (q.options ?? []).map(label => ({ label, description: "" })),
      multiSelect: false, isOther: true, isSecret: false
    }));
    if (questions.some(q => !bounded(q.question, 2000) || !q.question.trim()
      || q.options.length > 8 || q.options.some(o => !bounded(o.label, 300) || !o.label.trim())
      || new Set(q.options.map(o => o.label)).size !== q.options.length)) return [];
    // A group may be partly answered in Desktop. Present only remaining IDs.
    const pending = questions.filter(q => !answered.has(q.id));
    if (!pending.length || Buffer.byteLength(JSON.stringify(pending)) > 24000) return [];
    return [{ transport: "async", requestID: `async:${item.id}`, turnID: latest.turnId, input: { questions: pending } }];
  });
}

export function asyncReplyText(question, response) {
  return `${OPEN}\n${JSON.stringify(question.input.questions.map(q => ({
    questionItemId: q.id, question: q.question, answer: response.answers[q.id].answers[0]
  })))}\n${CLOSE}`;
}

export function asyncQuestionRoute(sessionID, question, response, commandID, turns) {
  const text = asyncReplyText(question, response);
  const latest = Object.values(turns).sort((a, b) => (b.turnStartedAtMs ?? 0) - (a.turnStartedAtMs ?? 0))[0];
  if (latest?.status === "inProgress") return {
    method: "thread-follower-steer-turn", version: 1,
    params: { conversationId: sessionID, clientUserMessageId: commandID,
      input: [{ type: "text", text, text_elements: [] }],
      restoreMessage: { context: {}, text }, attachments: [] }
  };
  return { method: "thread-follower-start-turn", version: 2,
    params: desktopFollowerTurnStartParams({ session_id: sessionID, command_id: commandID, prompt: text }) };
}

export function hasAsyncQuestionReceipt(turns, question, response) {
  const receipts = asyncAnswerReceipts(turns);
  return question.input.questions.every(q => receipts.some(r => r.questionItemId === q.id
    && r.question === q.question && r.answer === response.answers[q.id].answers[0]));
}
