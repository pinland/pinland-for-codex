import { randomUUID } from "node:crypto";
import { CodexDesktopIPCClient } from "./codex-desktop-ipc-client.mjs";
import { projectAsyncQuestionTurns, patchAsyncQuestionTurns, pendingAsyncQuestions,
  hasAsyncQuestionReceipt, asyncQuestionRoute } from "./desktop-async-questions.mjs";

const METHOD = "item/tool/requestUserInput";
const safeText = (v, n) => typeof v === "string" && v.trim().length > 0 && v.length <= n;
const sameID = (a, b) => typeof a === typeof b && a === b;
const validID = (id) => safeText(id, 200) || Number.isSafeInteger(id);
const badKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Only ordinary, non-secret questions. Tool permissions and connector
 * authorization remain on their original approval transports. */
export function normalizeDesktopQuestion(request, sessionID) {
  const p = request?.params;
  if (request?.method !== METHOD || !validID(request.id)
      || p?.threadId !== sessionID || !safeText(p?.turnId, 200)
      || !Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 3) return null;
  const questions = [];
  for (const q of p.questions) {
    if (!safeText(q?.id, 200) || badKeys.has(q.id) || !safeText(q.question, 2000)
        || typeof q.header !== "string" || q.header.length > 100 || q.isSecret === true
        || (q.isSecret !== undefined && typeof q.isSecret !== "boolean")
        || (q.isOther !== undefined && typeof q.isOther !== "boolean")) return null;
    const options = q.options ?? [];
    if (!Array.isArray(options) || options.length > 8
        || options.some(o => !safeText(o?.label, 300) || typeof o.description !== "string" || o.description.length > 2000)
        || new Set(options.map(o => o.label)).size !== options.length) return null;
    // No-option questions are free text. Otherwise honor the native Other flag.
    const isOther = options.length === 0 || q.isOther === true;
    questions.push({ id: q.id, question: q.question, header: q.header,
      options: options.map(({ label, description }) => ({ label, description })),
      multiSelect: false, isOther, isSecret: false });
  }
  if (new Set(questions.map(q => q.id)).size !== questions.length
      || Buffer.byteLength(JSON.stringify(questions)) > 24000) return null;
  return { requestID: request.id, turnID: p.turnId, input: { questions } };
}

export function desktopQuestionAnswer(question, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)
      || Object.keys(values).length !== question.input.questions.length) return null;
  const pairs = [];
  for (const q of question.input.questions) {
    if (!Object.hasOwn(values, q.id) || !safeText(values[q.id], 4000)
        || (!q.isOther && !q.options.some(o => o.label === values[q.id]))) return null;
    pairs.push([q.id, { answers: [values[q.id]] }]);
  }
  return { answers: Object.fromEntries(pairs) };
}

// Retain only requests, never the conversation transcript. Unrelated requests
// retain their position but not their potentially sensitive parameters.
function projectRequests(requests) {
  if (!Array.isArray(requests) || requests.length > 128
      || Buffer.byteLength(JSON.stringify(requests)) > 256000) throw Error("invalid requests");
  return requests.map(r => r?.method === METHOD ? structuredClone(r) : { id: r?.id, method: r?.method });
}

/** Apply only the requests subtree of an authenticated, revision-matched
 * Immer patch. Unknown shapes cause a fresh snapshot, never stale submission. */
export function patchQuestionRequests(requests, patches) {
  let result = structuredClone(requests);
  if (!Array.isArray(patches) || patches.length > 10000) throw Error("invalid patches");
  for (const patch of patches) {
    const path = patch.path;
    if (!Array.isArray(path) || path.length === 0) throw Error("root replacement");
    if (path[0] !== "requests") continue;
    if (!["add", "replace", "remove"].includes(patch.op)
        || path.some(k => badKeys.has(String(k))) || path.length > 12) throw Error("invalid patch");
    if (path.length === 1) {
      if (patch.op === "remove") result = [];
      else result = projectRequests(patch.value);
      continue;
    }
    let parent = result;
    for (const key of path.slice(1, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw Error("missing patch parent");
      parent = parent[key];
    }
    const key = path.at(-1);
    if (!parent || typeof parent !== "object") throw Error("invalid patch parent");
    if (Array.isArray(parent)) {
      if (key === "length" && patch.op === "replace" && Number.isInteger(patch.value)
          && patch.value >= 0 && patch.value <= parent.length) parent.length = patch.value;
      else {
        if (!Number.isInteger(key) || key < 0 || key > parent.length
            || (patch.op !== "add" && key === parent.length)) throw Error("invalid index");
        if (patch.op === "remove") parent.splice(key, 1);
        else if (patch.op === "add") parent.splice(key, 0, structuredClone(patch.value));
        else parent[key] = structuredClone(patch.value);
      }
    } else if (patch.op === "remove") delete parent[key];
    else parent[key] = structuredClone(patch.value);
  }
  return projectRequests(result);
}

export function hasQuestionReceipt(value, question, response) {
  const stack = [value];
  let visited = 0;
  while (stack.length && visited++ < 40000) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (item.type === "userInputResponse" && item.completed === true
        && sameID(item.requestId, question.requestID) && item.turnId === question.turnID
        && item.answers && Object.keys(item.answers).length === question.input.questions.length
        && question.input.questions.every(q => Array.isArray(item.answers[q.id])
          && item.answers[q.id].length === 1 && item.answers[q.id][0] === response.answers[q.id].answers[0])) return true;
    for (const child of Object.values(item)) if (child && typeof child === "object") stack.push(child);
  }
  return false;
}

/** A single elected companion observes pinned native tasks. No new executor,
 * permission approval, terminal automation, or background answer generation. */
export class DesktopQuestionBridge {
  constructor({ bridgeRequest, clientFactory = opts => new CodexDesktopIPCClient(opts), now = Date.now }) {
    this.bridgeRequest = bridgeRequest;
    this.clientFactory = clientFactory;
    this.now = now;
    this.states = new Map();
    this.retryAt = 0;
    this.busy = false;
  }

  async update(sessionIDs, token, epoch) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.token !== token || this.epoch !== epoch) this.close();
      this.token = token; this.epoch = epoch;
      if (!epoch || !token || this.now() < this.retryAt) return;
      const wanted = new Set(sessionIDs.filter(id => safeText(id, 200)).slice(0, 64));
      for (const [id, state] of this.states) if (!wanted.has(id)) this.remove(state);
      if (!wanted.size) { this.client?.close(); this.client = null; return; }
      if (!this.client) {
        this.client = this.clientFactory({ onBroadcast: m => this.receive(m), onDisconnect: () => {
          this.close(); this.retryAt = this.now() + 10000;
        }});
        await this.client.start();
      }
      const client = this.client;
      // Discovery is infrequent; no per-task timers or transcript polling.
      await Promise.all([...wanted].map(async id => {
        let state = this.states.get(id);
        if (state?.active && this.now() - (state.lastLease ?? 0) >= 5000) {
          state.lastLease = this.now();
          void this.status(state.active, "lease");
        }
        if (state && this.now() - state.checkedAt < 15000) return;
        try {
          const owner = await client.findThreadOwner(id);
          if (this.client !== client) return;
          if (state?.owner === owner && state.revision !== null) { state.checkedAt = this.now(); return; }
          if (state) this.remove(state);
          state = { id, owner, checkedAt: this.now(), revision: null, requests: [], asyncTurns: {}, seen: new Set(), active: null };
          this.states.set(id, state);
          this.follow(state, true);
        } catch {
          if (state) this.remove(state);
          // Failed discovery is retried at the same slow interval.
          if (this.client === client) this.states.set(id, { id, checkedAt: this.now(), revision: null, requests: [], seen: new Set() });
        }
      }));
    } catch { this.close(); this.retryAt = this.now() + 10000; }
    finally { this.busy = false; }
  }

  follow(state, following) {
    if (!state.owner) return;
    this.client?.writeMessage({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: this.client.clientID, targetClientIds: [state.owner],
      params: { conversationId: state.id, hostId: "local", following } });
  }

  receive(message) {
    if (message.method !== "thread-stream-state-changed" || message.version !== 11
        || message.params?.hostId !== "local") return;
    const state = this.states.get(message.params.conversationId);
    if (!state?.owner || state.owner !== message.sourceClientId) return;
    const change = message.params.change;
    try {
      if (!Number.isSafeInteger(change?.revision)) throw Error("invalid revision");
      if (state.revision !== null && change.revision <= state.revision) return;
      if (change.type === "snapshot") {
        state.requests = projectRequests(change.conversationState?.requests);
        state.asyncTurns = projectAsyncQuestionTurns(change.conversationState?.turnHistory);
      } else if (change.type === "patches" && state.revision !== null && change.baseRevision === state.revision) {
        state.requests = patchQuestionRequests(state.requests, change.patches);
        state.asyncTurns = patchAsyncQuestionTurns(state.asyncTurns ?? {}, change.patches);
      } else throw Error("revision gap");
      state.revision = change.revision;
      if (state.failed && !this.current(state, state.failed)) {
        void this.status(state.failed, "expired");
        state.failed = null;
      }
      const active = state.active;
      if (active?.response && (active.question.transport === "async"
          ? hasAsyncQuestionReceipt(state.asyncTurns, active.question, active.response)
          : hasQuestionReceipt(change, active.question, active.response))) {
        this.finish(state, "confirmed");
      } else if (active && !active.response && !this.current(state, active)) {
        this.finish(state, "expired");
      }
      this.present(state);
    } catch {
      this.finish(state, "expired");
      state.requests = []; state.revision = null;
      // Back off re-discovery instead of requesting a snapshot on every bad patch.
      this.follow(state, false);
      state.checkedAt = this.now() - 10000;
    }
  }

  current(state, active) {
    if (active.question.transport === "async") return pendingAsyncQuestions(state.asyncTurns ?? {})
      .some(q => JSON.stringify(q) === active.key);
    return state.requests.some(r => {
      const q = normalizeDesktopQuestion(r, state.id);
      return q && JSON.stringify(q) === active.key;
    });
  }

  present(state) {
    if (state.active || state.failed || state.seen.size >= 128) return;
    const question = [...state.requests.map(r => normalizeDesktopQuestion(r, state.id)), ...pendingAsyncQuestions(state.asyncTurns ?? {})]
      .find(q => q && !state.seen.has(JSON.stringify(q)));
    if (!question) return;
    const active = { id: randomUUID(), question, key: JSON.stringify(question), token: this.token };
    state.seen.add(active.key); state.active = active;
    void this.answer(state, active);
  }

  async answer(state, active) {
    try {
      const result = await this.bridgeRequest("/v1/questions", active.token,
        { id: active.id, sessionID: state.id, turnID: active.question.turnID, input: active.question.input }, 590000);
      if (this.states.get(state.id) !== state || state.active !== active) return;
      if (result.status !== 200) { this.finish(state, "expired"); return; }
      const response = desktopQuestionAnswer(active.question, result.json?.answers);
      if (!response || !this.current(state, active)) { this.finish(state, "expired"); return; }
      const client = this.client;
      const owner = await client.findThreadOwner(state.id);
      if (this.states.get(state.id) !== state || state.active !== active || owner !== state.owner
          || !this.current(state, active)) { this.finish(state, "expired"); return; }
      active.response = response;
      active.timer = setTimeout(() => { if (state.active === active) this.finish(state, "failed"); }, 15000);
      active.timer.unref?.();
      // Exactly once. {ok:true} is only route acknowledgement; it also occurs
      // for missing requests. Wait for the matching native response item.
      const route = active.question.transport === "async"
        ? asyncQuestionRoute(state.id, active.question, response, active.id, state.asyncTurns)
        : { method: "thread-follower-submit-user-input", version: 1,
          params: { conversationId: state.id, requestId: active.question.requestID, response } };
      const envelope = await client.sendRequest(route.method, route.params,
        { version: route.version, targetClientID: state.owner });
      if (state.active === active && (envelope.handledByClientId !== state.owner
          || (active.question.transport !== "async" && envelope.result?.ok !== true)))
        this.finish(state, "failed");
    } catch { if (state.active === active) this.finish(state, "failed"); }
  }

  async status(active, outcome) {
    try { await this.bridgeRequest("/v1/questions/status", active.token, { id: active.id, outcome }, 1500); } catch {}
  }

  finish(state, outcome) {
    const active = state.active;
    if (!active) return;
    state.active = null;
    if (outcome === "failed") state.failed = active;
    clearTimeout(active.timer);
    void this.status(active, outcome);
  }

  remove(state) {
    this.follow(state, false);
    this.finish(state, "expired");
    if (state.failed) void this.status(state.failed, "expired");
    this.states.delete(state.id);
  }

  close() {
    for (const state of [...this.states.values()]) this.remove(state);
    this.client?.close();
    this.client = null;
  }
}
