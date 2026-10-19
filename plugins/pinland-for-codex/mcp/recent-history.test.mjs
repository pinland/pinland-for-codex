import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRecentMessages,
  boundLiveCommentary,
  boundLiveProgress,
  boundLiveTurn,
  boundRecentMessages,
  extractLiveCommentary,
  extractLiveProgress,
  extractLiveProgressFromItemRows,
  extractLiveTurn,
  extractRecentMessages,
  extractRecentMessagesFromItemRows,
  latestTurnListParams,
  recentItemsListParams,
  recentTurnsListParams,
  textFromCodexDelegation,
  truncateUTF8
} from "./recent-history.mjs";

test("native asynchronous answers display only the human answer", () => {
  const result = extractRecentMessages({ data: [{ id: "turn", items: [{ type: "userMessage", content: [{ type: "text",
    text: '<send_user_message_question_reply>\n[{"questionItemId":"q","question":"Language?","answer":"中文回答"}]\n</send_user_message_question_reply>'
  }] }] }] });
  assert.equal(result[0].text, "中文回答");
});

test("recent turns request asks Codex for five summarized newest turns", () => {
  assert.deepEqual(recentTurnsListParams("thread-1"), {
    threadId: "thread-1",
    limit: 5,
    sortDirection: "desc",
    itemsView: "summary"
  });
  assert.deepEqual(latestTurnListParams("thread-1"), {
    threadId: "thread-1",
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded"
  });
  assert.deepEqual(recentItemsListParams("thread-1", "cursor", 32), {
    threadId: "thread-1",
    limit: 32,
    sortDirection: "desc",
    cursor: "cursor"
  });
});

test("extractRecentMessages keeps only user text and final answers in chronological order", () => {
  const result = {
    data: [
      {
        id: "new",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Latest question" }] },
          { type: "reasoning", text: "private reasoning" },
          { type: "agentMessage", phase: "commentary", text: "Working on it" },
          { type: "commandExecution", command: "pwd" },
          { type: "agentMessage", phase: "final_answer", text: "Latest answer" }
        ]
      },
      {
        id: "old",
        items: [
          {
            type: "userMessage",
            content: [
              { type: "text", text: "Old question" },
              { type: "image", url: "file:///private/image.png" }
            ]
          },
          { type: "fileChange", changes: ["secret diff"] },
          { type: "agentMessage", phase: "final_answer", text: "Old answer" }
        ]
      }
    ]
  };

  assert.deepEqual(extractRecentMessages(result), [
    { role: "user", text: "Old question", turn_id: "old" },
    { role: "assistant", text: "Old answer", turn_id: "old" },
    { role: "user", text: "Latest question", turn_id: "new" },
    { role: "assistant", text: "Latest answer", turn_id: "new" }
  ]);
});

test("paginated item rows keep only public messages and current commentary", () => {
  const rows = [
    {
      turnId: "new",
      item: { type: "agentMessage", id: "progress-2", phase: "commentary", text: "Second" }
    },
    { turnId: "new", item: { type: "reasoning", id: "private", summary: ["hidden"] } },
    {
      turnId: "new",
      item: { type: "agentMessage", id: "progress-1", phase: "commentary", text: "First" }
    },
    {
      turnId: "new",
      item: { type: "userMessage", id: "question", content: [{ type: "text", text: "Question" }] }
    },
    {
      turnId: "old",
      item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Answer" }
    },
    { turnId: "old", item: { type: "commandExecution", id: "command", output: "hidden" } },
    {
      turnId: "old",
      item: { type: "userMessage", id: "old-question", content: [{ type: "text", text: "Old" }] }
    }
  ];

  assert.deepEqual(extractRecentMessagesFromItemRows(rows), [
    { role: "user", text: "Old", turn_id: "old" },
    { role: "assistant", text: "Answer", turn_id: "old" },
    { role: "user", text: "Question", turn_id: "new" }
  ]);
  assert.deepEqual(extractLiveProgressFromItemRows(rows, {
    turn_id: "new",
    status: "inProgress",
    is_active: true
  }), [
    { turn_id: "new", item_id: "progress-1", text: "First" },
    { turn_id: "new", item_id: "progress-2", text: "Second" }
  ]);
});

test("a validated Codex task delegation is restored as the user's message", () => {
  const delegation = {
    type: "functionCallOutput",
    id: "delegated-user-message",
    namespace: "codex_app",
    name: "send_message_to_thread",
    output: `
      <codex_delegation>
        <source_thread_id>01a03823-c96f-75d0-a69f-23936c6246f6</source_thread_id>
        <input>Continue from Pinland.</input>
      </codex_delegation>
    `
  };

  assert.equal(textFromCodexDelegation(delegation), "Continue from Pinland.");
  assert.deepEqual(extractRecentMessagesFromItemRows([
    {
      turnId: "turn-2",
      item: {
        type: "agentMessage",
        id: "answer",
        phase: "final_answer",
        text: "Done."
      }
    },
    { turnId: "turn-2", item: delegation }
  ]), [
    { role: "user", text: "Continue from Pinland.", turn_id: "turn-2" },
    { role: "assistant", text: "Done.", turn_id: "turn-2" }
  ]);
});

test("delegation parsing stays fail-closed for every other tool output", () => {
  const base = {
    type: "functionCallOutput",
    namespace: "codex_app",
    name: "send_message_to_thread",
    output: "<codex_delegation><source_thread_id>source</source_thread_id><input>Public prompt</input></codex_delegation>"
  };
  assert.equal(textFromCodexDelegation({ ...base, namespace: "other" }), "");
  assert.equal(textFromCodexDelegation({ ...base, name: "read_thread" }), "");
  assert.equal(textFromCodexDelegation({ ...base, output: "private tool output" }), "");
  assert.equal(textFromCodexDelegation({
    ...base,
    output: "<codex_delegation><source_thread_id>bad path</source_thread_id><input>Prompt</input></codex_delegation>"
  }), "");
});

test("the same user prompt is not duplicated when both public encodings exist", () => {
  const output = "<codex_delegation><source_thread_id>source</source_thread_id><input>Same prompt</input></codex_delegation>";
  assert.deepEqual(extractRecentMessagesFromItemRows([
    {
      turnId: "turn",
      item: {
        type: "functionCallOutput",
        id: "delegation",
        namespace: "codex_app",
        name: "send_message_to_thread",
        output
      }
    },
    {
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "user",
        content: [{ type: "text", text: "Same prompt" }]
      }
    }
  ]), [
    { role: "user", text: "Same prompt", turn_id: "turn" }
  ]);
});

test("bounded recent messages preserve only valid turn identity", () => {
  assert.deepEqual(boundRecentMessages([
    { role: "user", text: "First", turn_id: " turn-1 " },
    { role: "assistant", text: "Second", turn_id: "x".repeat(129) }
  ]), [
    { role: "user", text: "First", turn_id: "turn-1" },
    { role: "assistant", text: "Second" }
  ]);
});

test("extractLiveCommentary keeps only the latest turn's last public commentary", () => {
  const result = {
    data: [
      {
        id: "latest-turn",
        items: [
          { type: "reasoning", text: "private reasoning" },
          { type: "agentMessage", id: "first", phase: "commentary", text: "First update" },
          { type: "commandExecution", command: "cat secret" },
          { type: "fileChange", changes: ["secret diff"] },
          { type: "mcpToolCall", result: "private tool output" },
          { type: "agentMessage", id: "last", phase: "commentary", text: "Latest update" }
        ]
      },
      {
        id: "older-turn",
        items: [
          { type: "agentMessage", id: "older", phase: "commentary", text: "Old update" }
        ]
      }
    ]
  };

  assert.deepEqual(extractLiveCommentary(result), {
    turn_id: "latest-turn",
    item_id: "last",
    text: "Latest update"
  });
});

test("extractLiveCommentary clears progress once the latest turn has a final answer", () => {
  assert.equal(extractLiveCommentary({
    data: [{
      id: "turn",
      items: [
        { type: "agentMessage", id: "progress", phase: "commentary", text: "Working" },
        { type: "agentMessage", id: "final", phase: "final_answer", text: "Done" },
        { type: "agentMessage", id: "late", phase: "commentary", text: "Must stay hidden" }
      ]
    }]
  }), undefined);
});

test("extractLiveProgress keeps every public commentary block in source order", () => {
  const result = {
    data: [
      {
        id: "latest-turn",
        items: [
          { type: "reasoning", id: "reasoning", text: "private reasoning" },
          { type: "agentMessage", id: "first", phase: "commentary", text: "First update" },
          { type: "commandExecution", id: "command", output: "private output" },
          { type: "fileChange", id: "diff", changes: ["private diff"] },
          { type: "mcpToolCall", id: "tool", result: "private tool result" },
          { type: "agentMessage", id: "second", phase: "commentary", text: "Second update" },
          { type: "agentMessage", id: "finalish", phase: "final", text: "Not a final answer" }
        ]
      },
      {
        id: "older-turn",
        items: [
          { type: "agentMessage", id: "older", phase: "commentary", text: "Old update" }
        ]
      }
    ]
  };

  assert.deepEqual(extractLiveProgress(result), [
    { turn_id: "latest-turn", item_id: "first", text: "First update" },
    { turn_id: "latest-turn", item_id: "second", text: "Second update" }
  ]);
});

test("extractLiveProgress clears the whole transient sequence after final answer", () => {
  assert.deepEqual(extractLiveProgress({
    data: [{
      id: "turn",
      items: [
        { type: "agentMessage", id: "one", phase: "commentary", text: "One" },
        { type: "agentMessage", id: "two", phase: "commentary", text: "Two" },
        { type: "agentMessage", id: "final", phase: "final_answer", text: "Done" }
      ]
    }]
  }), []);
});

test("live progress has high bounded item and aggregate UTF-8 ceilings", () => {
  const progress = Array.from({ length: 70 }, (_, index) => ({
    turn_id: "turn",
    item_id: `item-${index}`,
    text: `${index}-${"🙂".repeat(2_000)}`
  }));
  const bounded = boundLiveProgress(progress);

  assert.equal(bounded.length, 17);
  assert.equal(bounded.at(-1).item_id, "item-69");
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") < 70 * 1_024);
  assert.ok(bounded.every((item) => Buffer.byteLength(item.text, "utf8") <= 4_000));
  assert.ok(bounded.every((item) => !item.text.includes("�")));
});

test("live commentary requires bounded identities and truncates on UTF-8 boundaries", () => {
  assert.deepEqual(boundLiveCommentary({
    turn_id: " turn-1 ",
    item_id: " item-1 ",
    text: "a🙂b"
  }, { maxTextBytes: 4 }), {
    turn_id: "turn-1",
    item_id: "item-1",
    text: "a"
  });
  assert.equal(boundLiveCommentary({
    turn_id: "x".repeat(129),
    item_id: "item",
    text: "Must stay hidden"
  }), undefined);
  assert.equal(boundLiveCommentary({
    turn_id: "turn",
    item_id: "x".repeat(129),
    text: "Must stay hidden"
  }), undefined);
});

test("live turn uses only the current app-server TurnStatus whitelist", () => {
  const valid = [
    ["inProgress", true],
    ["completed", false],
    ["interrupted", true],
    ["interrupted", false],
    ["failed", false]
  ];
  for (const [status, isActive] of valid) {
    assert.deepEqual(boundLiveTurn({
      turn_id: " turn-1 ",
      status,
      is_active: isActive
    }), {
      turn_id: "turn-1",
      status,
      is_active: isActive
    });
  }
  for (const status of ["active", "cancelled", "canceled", "completed ", "unknown", ""]) {
    assert.equal(boundLiveTurn({
      turn_id: "turn-1",
      status,
      is_active: false
    }), undefined);
  }
  assert.equal(boundLiveTurn({
    turn_id: "turn-1",
    status: "inProgress",
    is_active: false
  }), undefined);
  assert.equal(boundLiveTurn({
    turn_id: "turn-1",
    status: "completed",
    is_active: true
  }), undefined);
  assert.equal(boundLiveTurn({ turn_id: "turn-1", status: "interrupted" }), undefined);
  assert.equal(boundLiveTurn({
    turn_id: "x".repeat(129),
    status: "inProgress",
    is_active: true
  }), undefined);
});

test("extractLiveTurn reads explicit in-progress state and never infers it from commentary", () => {
  assert.deepEqual(extractLiveTurn({
    data: [
      {
        id: "latest",
        status: "inProgress",
        completedAt: null,
        durationMs: null,
        items: [{ type: "agentMessage", phase: "commentary", text: "Working" }]
      },
      { id: "older", status: "completed", items: [] }
    ]
  }), {
    turn_id: "latest",
    status: "inProgress",
    is_active: true
  });
  assert.equal(extractLiveTurn({
    data: [{
      id: "latest",
      items: [{ type: "agentMessage", phase: "commentary", text: "Working" }]
    }]
  }), undefined);
});

test("extractLiveTurn distinguishes Desktop-owned live interrupted from terminal interrupted", () => {
  assert.deepEqual(extractLiveTurn({
    data: [{
      id: "desktop-live",
      status: "interrupted",
      completedAt: null,
      durationMs: null,
      items: []
    }]
  }), {
    turn_id: "desktop-live",
    status: "interrupted",
    is_active: true
  });
  assert.deepEqual(extractLiveTurn({
    data: [{
      id: "historical-interrupt",
      status: "interrupted",
      completedAt: 1_788_101_344,
      durationMs: 579_800,
      items: []
    }]
  }), {
    turn_id: "historical-interrupt",
    status: "interrupted",
    is_active: false
  });
});

test("extractLiveTurn fails closed on malformed completion metadata", () => {
  for (const turn of [
    { id: "turn", status: "interrupted", completedAt: "123", durationMs: null },
    { id: "turn", status: "interrupted", completedAt: null, durationMs: -1 },
    { id: "turn", status: "interrupted", completedAt: 1.5, durationMs: null },
    { id: "turn", status: "interrupted", completedAt: null, durationMs: Number.MAX_VALUE }
  ]) {
    assert.equal(extractLiveTurn({ data: [{ ...turn, items: [] }] }), undefined);
  }
});

test("recent messages are limited to five and safely truncated on UTF-8 boundaries", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `${index}-${"🙂".repeat(4_000)}`
  }));
  const bounded = boundRecentMessages(messages);

  assert.equal(bounded.length, 5);
  assert.equal(bounded[0].text.startsWith("3-"), true);
  assert.ok(bounded.every((message) => Buffer.byteLength(message.text, "utf8") <= 4_000));
  assert.ok(bounded.every((message) => !message.text.includes("�")));
  assert.equal(truncateUTF8("a🙂b", 4), "a");
});

test("attachRecentMessages reads only added or updated sessions and prunes unpinned cache", async () => {
  const cache = new Map([
    ["same", { updateKey: "1000", messages: [{ role: "assistant", text: "cached" }] }],
    ["removed", { updateKey: "1", messages: [] }]
  ]);
  const calls = [];
  const sessions = [
    { session_id: "same", updated_at_ms: 1_000 },
    { session_id: "changed", updated_at_ms: 2_000 }
  ];
  const attached = await attachRecentMessages(sessions, cache, async (sessionID) => {
    calls.push(sessionID);
    return {
      data: [{ items: [{ type: "agentMessage", phase: "final_answer", text: "fresh" }] }]
    };
  });

  assert.deepEqual(calls, ["changed"]);
  assert.equal(cache.has("removed"), false);
  assert.deepEqual(attached[0].recent_messages, [{ role: "assistant", text: "cached" }]);
  assert.deepEqual(attached[1].recent_messages, [{ role: "assistant", text: "fresh" }]);
  assert.equal(attached[0].live_commentary, null);
  assert.equal(attached[1].live_commentary, null);
  assert.deepEqual(attached[0].live_progress, []);
  assert.deepEqual(attached[1].live_progress, []);
  assert.equal(attached[0].live_turn, null);
  assert.equal(attached[1].live_turn, null);
});

test("paginated history reads only new public items and clears progress on final", async () => {
  const cache = new Map();
  const turnReplies = [
    { data: [{ id: "new", status: "inProgress", completedAt: null, durationMs: null }] },
    { data: [{ id: "new", status: "inProgress", completedAt: null, durationMs: null }] },
    { data: [{ id: "new", status: "completed", completedAt: 20, durationMs: 10 }] }
  ];
  const itemReplies = [
    { data: [
      { turnId: "new", item: { type: "agentMessage", id: "p1", phase: "commentary", text: "One" } },
      { turnId: "new", item: { type: "reasoning", id: "hidden" } },
      { turnId: "new", item: { type: "userMessage", id: "u3", content: [{ type: "text", text: "Three" }] } },
      { turnId: "two", item: { type: "agentMessage", id: "a2", phase: "final_answer", text: "Two answer" } },
      { turnId: "two", item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "Two" }] } },
      { turnId: "one", item: { type: "agentMessage", id: "a1", phase: "final_answer", text: "One answer" } },
      { turnId: "one", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "One question" }] } }
    ], nextCursor: null },
    { data: [
      { turnId: "new", item: { type: "agentMessage", id: "p2", phase: "commentary", text: "Two" } },
      { turnId: "new", item: { type: "agentMessage", id: "p1", phase: "commentary", text: "One" } }
    ], nextCursor: null },
    { data: [
      { turnId: "new", item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Done" } },
      { turnId: "new", item: { type: "agentMessage", id: "p2", phase: "commentary", text: "Two" } }
    ], nextCursor: null }
  ];
  let turnCalls = 0;
  let itemCalls = 0;
  const options = {
    historyModeForSession: () => "paginated",
    fetchItems: async () => itemReplies[itemCalls++]
  };
  const session = [{ session_id: "task", updated_at_ms: 1_000 }];
  const first = await attachRecentMessages(session, cache, async () => turnReplies[turnCalls++], options);
  const second = await attachRecentMessages(session, cache, async () => turnReplies[turnCalls++], options);
  const final = await attachRecentMessages(session, cache, async () => turnReplies[turnCalls++], options);

  assert.equal(turnCalls, 3);
  assert.equal(itemCalls, 3);
  assert.equal(first[0].recent_messages.length, 5);
  assert.deepEqual(second[0].live_progress, [
    { turn_id: "new", item_id: "p1", text: "One" },
    { turn_id: "new", item_id: "p2", text: "Two" }
  ]);
  assert.deepEqual(final[0].live_progress, []);
  assert.equal(final[0].recent_messages.at(-1).text, "Done");
});

test("unsupported paginated items are cached and fall back to summaries", async () => {
  const cache = new Map();
  let itemCalls = 0;
  let turnCalls = 0;
  const attached = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    async (_threadID, params) => {
      turnCalls += 1;
      return params.itemsView === "notLoaded"
        ? { data: [{ id: "turn", status: "completed", completedAt: 2, durationMs: 1 }] }
        : { data: [{ id: "turn", status: "completed", completedAt: 2, durationMs: 1,
          items: [{ type: "agentMessage", phase: "final_answer", text: "Fallback" }] }] };
    },
    {
      historyModeForSession: () => "paginated",
      fetchItems: async () => {
        itemCalls += 1;
        const error = new Error("thread/items/list is not supported yet");
        error.code = -32601;
        throw error;
      }
    }
  );
  await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    async () => { throw new Error("must stay cached"); },
    { historyModeForSession: () => "paginated", fetchItems: async () => ({ data: [] }) }
  );

  assert.equal(itemCalls, 1);
  assert.equal(turnCalls, 2);
  assert.equal(cache.get("task").itemsUnsupportedFor, "paginated");
  assert.deepEqual(attached[0].recent_messages, [
    { role: "assistant", text: "Fallback", turn_id: "turn" }
  ]);
});

test("same-key live polling replaces commentary and clears it with final turn status", async () => {
  const cache = new Map();
  const replies = [
    {
      data: [{
        id: "turn",
        status: "inProgress",
        items: [
          { type: "agentMessage", id: "one", phase: "commentary", text: "First" }
        ]
      }]
    },
    {
      data: [{
        id: "turn",
        status: "inProgress",
        items: [
          { type: "agentMessage", id: "one", phase: "commentary", text: "First" },
          { type: "agentMessage", id: "two", phase: "commentary", text: "Second" }
        ]
      }]
    },
    {
      data: [{
        id: "turn",
        status: "completed",
        items: [
          { type: "agentMessage", id: "two", phase: "commentary", text: "Second" },
          { type: "agentMessage", id: "final", phase: "final_answer", text: "Done" }
        ]
      }]
    }
  ];
  let calls = 0;
  const fetchTurns = async () => replies[calls++];

  const first = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 0 }
  );
  const second = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 10_000 }
  );
  const completed = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 22_500 }
  );
  const terminalSameKey = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 22_501 }
  );

  assert.equal(calls, 3);
  assert.deepEqual(first[0].live_commentary, {
    turn_id: "turn",
    item_id: "one",
    text: "First"
  });
  assert.deepEqual(first[0].live_progress, [{
    turn_id: "turn",
    item_id: "one",
    text: "First"
  }]);
  assert.deepEqual(second[0].live_commentary, {
    turn_id: "turn",
    item_id: "two",
    text: "Second"
  });
  assert.deepEqual(second[0].live_progress, [
    { turn_id: "turn", item_id: "one", text: "First" },
    { turn_id: "turn", item_id: "two", text: "Second" }
  ]);
  assert.equal(completed[0].live_commentary, null);
  assert.deepEqual(completed[0].live_progress, []);
  assert.deepEqual(completed[0].live_turn, {
    turn_id: "turn",
    status: "completed",
    is_active: false
  });
  assert.deepEqual(terminalSameKey[0].live_turn, completed[0].live_turn);
  assert.equal(terminalSameKey[0].live_commentary, null);
  assert.deepEqual(terminalSameKey[0].live_progress, []);
});

test("a refreshed authoritative snapshot can restore a formerly missing prompt in order", async () => {
  const cache = new Map();
  const replies = [
    {
      data: [{
        id: "turn",
        status: "inProgress",
        items: [
          { type: "agentMessage", phase: "final_answer", text: "Answer" }
        ]
      }]
    },
    {
      data: [{
        id: "turn",
        status: "inProgress",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Prompt" }] },
          { type: "agentMessage", phase: "final_answer", text: "Answer" }
        ]
      }]
    }
  ];
  let calls = 0;
  const fetchTurns = async () => replies[calls++];

  const first = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 0 }
  );
  const second = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    fetchTurns,
    { now: 10_000 }
  );

  assert.deepEqual(first[0].recent_messages, [
    { role: "assistant", text: "Answer", turn_id: "turn" }
  ]);
  assert.deepEqual(second[0].recent_messages, [
    { role: "user", text: "Prompt", turn_id: "turn" },
    { role: "assistant", text: "Answer", turn_id: "turn" }
  ]);
});

test("legacy metadata churn cannot bypass the active refresh guard", async () => {
  const cache = new Map();
  const replies = [
    { data: [{
      id: "turn",
      status: "inProgress",
      completedAt: null,
      durationMs: null,
      items: [{ type: "agentMessage", id: "one", phase: "commentary", text: "First" }]
    }] },
    { data: [{
      id: "turn",
      status: "completed",
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Done" }]
    }] }
  ];
  let calls = 0;
  const fetchTurns = async () => replies[calls++];

  await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000, runtime_is_active: true }],
    cache,
    fetchTurns,
    { now: 0 }
  );
  const guarded = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 2_000, runtime_is_active: true }],
    cache,
    fetchTurns,
    { now: 900 }
  );
  const stillGuarded = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 2_500, runtime_is_active: true }],
    cache,
    fetchTurns,
    { now: 600_000 }
  );
  const terminal = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 3_000, runtime_is_active: false }],
    cache,
    fetchTurns,
    { now: 600_900 }
  );

  assert.equal(calls, 2);
  assert.equal(guarded[0].live_turn.is_active, true);
  assert.equal(stillGuarded[0].live_turn.is_active, true);
  assert.equal(terminal[0].live_turn.is_active, false);
  assert.equal(terminal[0].recent_messages.at(-1).text, "Done");
});

test("desktop sync can omit legacy history without clearing Pinland's local cache", async () => {
  const cache = new Map([["task", {
    updateKey: "old",
    source: "legacy",
    messages: [{ role: "assistant", text: "Old bridge cache" }]
  }]]);
  let calls = 0;
  const attached = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 2_000, runtime_is_active: true }],
    cache,
    async () => {
      calls += 1;
      throw new Error("legacy history must not be scanned");
    },
    {
      historyModeForSession: () => "legacy",
      skipLegacyHistory: true
    }
  );

  assert.equal(calls, 0);
  assert.equal(cache.has("task"), false);
  assert.deepEqual(attached, [{
    session_id: "task",
    updated_at_ms: 2_000,
    runtime_is_active: true
  }]);
  assert.equal(Object.hasOwn(attached[0], "recent_messages"), false);
  assert.equal(Object.hasOwn(attached[0], "live_turn"), false);
});

test("terminal interrupted turns never replay stale commentary", async () => {
  const cache = new Map();
  let calls = 0;
  const fetchTurns = async () => {
    calls += 1;
    return {
      data: [{
        id: "turn",
        status: "interrupted",
        completedAt: 1_788_101_344,
        durationMs: 579_800,
        items: [
          { type: "agentMessage", id: "stale", phase: "commentary", text: "Old progress" }
        ]
      }]
    };
  };
  const session = [{ session_id: "task", updated_at_ms: 1_000 }];

  const terminal = await attachRecentMessages(session, cache, fetchTurns);
  const sameKey = await attachRecentMessages(session, cache, fetchTurns);

  assert.equal(calls, 1);
  assert.equal(terminal[0].live_commentary, null);
  assert.equal(sameKey[0].live_commentary, null);
  assert.deepEqual(terminal[0].live_progress, []);
  assert.deepEqual(sameKey[0].live_progress, []);
  assert.deepEqual(terminal[0].live_turn, {
    turn_id: "turn",
    status: "interrupted",
    is_active: false
  });
  assert.deepEqual(sameKey[0].live_turn, terminal[0].live_turn);
});

test("same-key live polling observes retry backoff without discarding cached state", async () => {
  const cache = new Map([["task", {
    updateKey: "1000",
    messages: [],
    liveCommentary: { turn_id: "turn", item_id: "one", text: "Cached" },
    liveProgress: [{ turn_id: "turn", item_id: "one", text: "Cached" }],
    liveTurn: { turn_id: "turn", status: "inProgress", is_active: true }
  }]]);
  let calls = 0;
  const fetchTurns = async () => {
    calls += 1;
    throw new Error("history unavailable");
  };
  const session = [{ session_id: "task", updated_at_ms: 1_000 }];

  const first = await attachRecentMessages(session, cache, fetchTurns, { now: 10_000 });
  const backedOff = await attachRecentMessages(session, cache, fetchTurns, { now: 10_100 });
  const retried = await attachRecentMessages(session, cache, fetchTurns, { now: 15_001 });

  assert.equal(calls, 2);
  for (const snapshot of [first, backedOff, retried]) {
    assert.deepEqual(snapshot[0].live_commentary, {
      turn_id: "turn",
      item_id: "one",
      text: "Cached"
    });
    assert.deepEqual(snapshot[0].live_progress, [{
      turn_id: "turn",
      item_id: "one",
      text: "Cached"
    }]);
    assert.deepEqual(snapshot[0].live_turn, {
      turn_id: "turn",
      status: "inProgress",
      is_active: true
    });
  }
});

test("a history failure keeps cached messages, does not reject, and backs off retries", async () => {
  const cache = new Map([
    ["task", { updateKey: "1000", messages: [{ role: "assistant", text: "last good" }] }]
  ]);
  let calls = 0;
  const fetchTurns = async () => {
    calls += 1;
    throw new Error("history unavailable");
  };
  const changed = [{ session_id: "task", updated_at_ms: 2_000 }];

  const first = await attachRecentMessages(changed, cache, fetchTurns, { now: 10_000 });
  const second = await attachRecentMessages(changed, cache, fetchTurns, { now: 10_100 });

  assert.equal(calls, 1);
  assert.deepEqual(first[0].recent_messages, [{ role: "assistant", text: "last good" }]);
  assert.deepEqual(second[0].recent_messages, [{ role: "assistant", text: "last good" }]);
  assert.equal(first[0].live_commentary, null);
  assert.equal(second[0].live_commentary, null);
  assert.deepEqual(first[0].live_progress, []);
  assert.deepEqual(second[0].live_progress, []);
  assert.equal(first[0].live_turn, null);
  assert.equal(second[0].live_turn, null);
});

test("an active partial transcript never clears the last complete conversation", async () => {
  const cachedMessages = [
    { role: "user", text: "Earlier question", turn_id: "older" },
    { role: "assistant", text: "Earlier answer", turn_id: "older" }
  ];
  const cache = new Map([[
    "task",
    { updateKey: "1000", messages: cachedMessages }
  ]]);

  const attached = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 2_000 }],
    cache,
    async () => ({
      data: [{
        id: "active",
        status: "interrupted",
        completedAt: null,
        durationMs: null,
        items: [{
          type: "agentMessage",
          id: "progress",
          phase: "commentary",
          text: "Still working"
        }]
      }]
    })
  );

  assert.deepEqual(attached[0].recent_messages, cachedMessages);
  assert.deepEqual(attached[0].live_progress, [{
    turn_id: "active",
    item_id: "progress",
    text: "Still working"
  }]);
});

test("a cold-cache history failure omits history instead of authoritatively clearing it", async () => {
  const cache = new Map();
  const attached = await attachRecentMessages(
    [{ session_id: "task", updated_at_ms: 1_000 }],
    cache,
    async () => {
      throw new Error("history unavailable");
    }
  );

  assert.equal(Object.hasOwn(attached[0], "recent_messages"), false);
  assert.equal(Object.hasOwn(cache.get("task"), "messages"), false);
});
