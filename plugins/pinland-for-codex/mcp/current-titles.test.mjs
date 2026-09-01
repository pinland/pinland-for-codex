import assert from "node:assert/strict";
import test from "node:test";

import {
  attachCurrentTitles,
  CurrentTitleIndex,
  currentThreadTitle
} from "./current-titles.mjs";

test("currentThreadTitle reads the user-assigned name from thread/read", () => {
  assert.equal(currentThreadTitle({
    thread: {
      name: " codex引入 ",
      preview: "Old initial prompt"
    }
  }), "codex引入");
  assert.equal(currentThreadTitle({
    thread: { name: null, preview: "Never use preview as a current name" }
  }), "");
});

test("attachCurrentTitles replaces section-list preview with current task name", async () => {
  const cache = new Map();
  const calls = [];
  const sessions = [{
    session_id: "task",
    title: "Old initial prompt",
    updated_at_ms: 1_000
  }];

  const attached = await attachCurrentTitles(sessions, cache, async (sessionID) => {
    calls.push(sessionID);
    return { thread: { id: sessionID, name: "codex引入" } };
  }, { now: 10_000 });

  assert.deepEqual(calls, ["task"]);
  assert.equal(attached[0].title, "codex引入");
  assert.equal(attached[0].title_is_authoritative, true);
});

test("the bounded title index follows current names without per-task reads", async () => {
  const index = new CurrentTitleIndex({ refreshIntervalMs: 5_000, maxPages: 2 });
  const sessions = [
    { session_id: "task-one", title: "Folder one", updated_at_ms: 1_000 },
    { session_id: "task-two", title: "Folder two", updated_at_ms: 1_000 }
  ];
  let title = "codex引入";
  let pageCalls = 0;
  const fetchPage = async (cursor) => {
    pageCalls += 1;
    if (!cursor) {
      return {
        data: [{ id: "task-one", name: title }],
        nextCursor: "second-page"
      };
    }
    return {
      data: [{ id: "task-two", name: "审批测试" }],
      nextCursor: null
    };
  };

  const first = await index.titlesFor(sessions, fetchPage, { now: 10_000 });
  assert.equal(first.get("task-one"), "codex引入");
  assert.equal(first.get("task-two"), "审批测试");
  assert.equal(pageCalls, 2);

  await index.titlesFor(sessions, fetchPage, { now: 10_100 });
  assert.equal(pageCalls, 2);

  title = "重命名后的任务";
  const refreshed = await index.titlesFor(sessions, fetchPage, { now: 15_001 });
  assert.equal(refreshed.get("task-one"), "重命名后的任务");
  assert.equal(pageCalls, 4);
});

test("an indexed name prevents a transient fallback title snapshot", async () => {
  const cache = new Map();
  let readCalls = 0;
  const attached = await attachCurrentTitles(
    [{
      session_id: "task",
      title: "projects-pinland-p-i-n-l",
      title_is_authoritative: false,
      updated_at_ms: 1_000
    }],
    cache,
    async () => {
      readCalls += 1;
      return { thread: { name: null } };
    },
    {
      now: 10_000,
      currentNames: new Map([["task", "codex引入"]])
    }
  );

  assert.equal(readCalls, 0);
  assert.equal(attached[0].title, "codex引入");
  assert.equal(attached[0].title_is_authoritative, true);
});

test("an unresolved fallback is marked non-authoritative and retried", async () => {
  const cache = new Map();
  let title = null;
  let calls = 0;
  const fetchThread = async () => {
    calls += 1;
    return { thread: { name: title } };
  };
  const sessions = [{
    session_id: "task",
    title: "projects-pinland-p-i-n-l",
    title_is_authoritative: false,
    updated_at_ms: 1_000
  }];

  const unresolved = await attachCurrentTitles(
    sessions,
    cache,
    fetchThread,
    { now: 10_000 }
  );
  const backedOff = await attachCurrentTitles(
    sessions,
    cache,
    fetchThread,
    { now: 10_100 }
  );
  title = "codex引入";
  const resolved = await attachCurrentTitles(
    sessions,
    cache,
    fetchThread,
    { now: 15_001 }
  );

  assert.equal(calls, 2);
  assert.equal(unresolved[0].title_is_authoritative, false);
  assert.equal(backedOff[0].title_is_authoritative, false);
  assert.equal(resolved[0].title, "codex引入");
  assert.equal(resolved[0].title_is_authoritative, true);
});

test("title refresh is update-key driven and throttles a busy task", async () => {
  const cache = new Map();
  let title = "First name";
  let calls = 0;
  const fetchThread = async () => {
    calls += 1;
    return { thread: { name: title } };
  };

  const first = await attachCurrentTitles(
    [{ session_id: "task", title: "Prompt", updated_at_ms: 1_000 }],
    cache,
    fetchThread,
    { now: 10_000 }
  );
  title = "Renamed";
  const throttled = await attachCurrentTitles(
    [{ session_id: "task", title: "Prompt", updated_at_ms: 2_000 }],
    cache,
    fetchThread,
    { now: 10_100 }
  );
  const refreshed = await attachCurrentTitles(
    [{ session_id: "task", title: "Prompt", updated_at_ms: 2_000 }],
    cache,
    fetchThread,
    { now: 15_001 }
  );
  const unchanged = await attachCurrentTitles(
    [{ session_id: "task", title: "Prompt", updated_at_ms: 2_000 }],
    cache,
    fetchThread,
    { now: 20_100 }
  );

  assert.equal(calls, 2);
  assert.equal(first[0].title, "First name");
  assert.equal(throttled[0].title, "First name");
  assert.equal(refreshed[0].title, "Renamed");
  assert.equal(unchanged[0].title, "Renamed");
});

test("title read failure keeps the last good title and observes retry backoff", async () => {
  const cache = new Map([["task", {
    updateKey: "1000",
    checkedAtMs: 1_000,
    title: "Last good"
  }]]);
  let calls = 0;
  const fetchThread = async () => {
    calls += 1;
    throw new Error("unavailable");
  };
  const sessions = [{ session_id: "task", title: "Old prompt", updated_at_ms: 2_000 }];

  const first = await attachCurrentTitles(sessions, cache, fetchThread, { now: 10_000 });
  const backedOff = await attachCurrentTitles(sessions, cache, fetchThread, { now: 10_100 });
  const retried = await attachCurrentTitles(sessions, cache, fetchThread, { now: 15_001 });

  assert.equal(calls, 2);
  assert.equal(first[0].title, "Last good");
  assert.equal(backedOff[0].title, "Last good");
  assert.equal(retried[0].title, "Last good");
});

test("unpinned task titles are pruned from cache", async () => {
  const cache = new Map([
    ["kept", { updateKey: "1", checkedAtMs: 1, title: "Kept" }],
    ["removed", { updateKey: "1", checkedAtMs: 1, title: "Removed" }]
  ]);

  await attachCurrentTitles(
    [{ session_id: "kept", title: "Fallback", updated_at_ms: 1 }],
    cache,
    async () => ({ thread: { name: "Unused" } }),
    { now: 10 }
  );

  assert.equal(cache.has("kept"), true);
  assert.equal(cache.has("removed"), false);
});
