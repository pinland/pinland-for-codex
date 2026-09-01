const DEFAULT_MAX_MESSAGES = 5;
// Keep this at or below the app-side 4,000-character validation ceiling.
// A UTF-8 byte ceiling of 4,000 guarantees the decoded Swift String cannot
// contain more than 4,000 characters, including for ASCII-heavy CLI output.
const DEFAULT_MAX_MESSAGE_BYTES = 4_000;
const DEFAULT_MAX_SESSION_BYTES = DEFAULT_MAX_MESSAGES * DEFAULT_MAX_MESSAGE_BYTES;
// Public commentary shares the app-side 4,000-character validation ceiling.
// Bound UTF-8 bytes more strictly so even ASCII-heavy progress cannot exceed it.
const DEFAULT_MAX_LIVE_COMMENTARY_BYTES = 4_000;
// A turn can publish many public commentary messages. Preserve the ordered
// sequence for the active preview while keeping a single pathological turn
// from consuming the bridge snapshot. Per-item limits match live_commentary;
// the aggregate ceiling is intentionally generous for ordinary long turns.
const DEFAULT_MAX_LIVE_PROGRESS_ITEMS = 64;
const DEFAULT_MAX_LIVE_PROGRESS_BYTES = 64 * 1_024;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEGACY_ACTIVE_REFRESH_MS = 10_000;
const DEFAULT_MAX_LEGACY_ACTIVE_REFRESH_MS = 15_000;
const DEFAULT_LEGACY_ACTIVE_REFRESH_STEP_MS = 2_500;
const DEFAULT_ITEMS_PAGE_SIZE = 64;
const DEFAULT_MAX_ITEMS_SCAN = 256;
const DEFAULT_MAX_PUBLIC_ITEM_ROWS = 128;
const MAX_CODEX_DELEGATION_BYTES = 20 * 1_024;
const CODEX_DELEGATION_PATTERN = /^\s*<codex_delegation>\s*<source_thread_id>([^<>\r\n]+)<\/source_thread_id>\s*<input>([\s\S]+)<\/input>\s*<\/codex_delegation>\s*$/;
const ALLOWED_LIVE_TURN_STATUSES = new Set([
  "inProgress",
  "completed",
  "interrupted",
  "failed"
]);

export function recentTurnsListParams(threadID) {
  return {
    threadId: threadID,
    limit: 5,
    sortDirection: "desc",
    itemsView: "summary"
  };
}

export function latestTurnListParams(threadID) {
  return {
    threadId: threadID,
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded"
  };
}

export function recentItemsListParams(threadID, cursor, limit = DEFAULT_ITEMS_PAGE_SIZE) {
  return {
    threadId: threadID,
    limit,
    sortDirection: "desc",
    ...(typeof cursor === "string" && cursor ? { cursor } : {})
  };
}

export function truncateUTF8(value, maximumBytes) {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(typeof value === "string" ? value : "", "utf8");
  if (bytes.length <= maximumBytes) return bytes.toString("utf8");
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanTurnID(value) {
  const turnID = cleanText(value);
  return turnID && turnID.length <= 128 ? turnID : undefined;
}

function cleanItemID(value) {
  const itemID = cleanText(value);
  return itemID && itemID.length <= 128 ? itemID : undefined;
}

function textFromUserMessage(item) {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return item.content
    .filter((part) => part?.type === "text")
    .map((part) => cleanText(part.text))
    .filter(Boolean)
    .join("\n\n");
}

export function textFromCodexDelegation(item) {
  if (item?.type !== "functionCallOutput"
      || item.namespace !== "codex_app"
      || item.name !== "send_message_to_thread"
      || typeof item.output !== "string"
      || Buffer.byteLength(item.output, "utf8") > MAX_CODEX_DELEGATION_BYTES) {
    return "";
  }
  const match = CODEX_DELEGATION_PATTERN.exec(item.output);
  if (!match) return "";
  const sourceThreadID = cleanText(match[1]);
  const input = cleanText(match[2]);
  if (!/^[\p{L}\p{N}_.:-]{1,256}$/u.test(sourceThreadID) || !input) return "";
  return input;
}

function appendDistinctMessage(messages, seen, message) {
  const identity = JSON.stringify([message.role, message.turn_id || "", message.text]);
  if (seen.has(identity)) return;
  seen.add(identity);
  messages.push(message);
}

export function boundRecentMessages(messages, {
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxSessionBytes = DEFAULT_MAX_SESSION_BYTES
} = {}) {
  if (!Array.isArray(messages) || maxMessages <= 0 || maxMessageBytes <= 0) return [];
  const normalized = messages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => {
      const turnID = cleanTurnID(message.turn_id);
      return {
        role: message.role,
        text: truncateUTF8(cleanText(message.text), maxMessageBytes),
        ...(turnID ? { turn_id: turnID } : {})
      };
    })
    .filter((message) => message.text)
    .slice(-maxMessages);

  let remainingBytes = Math.max(0, maxSessionBytes);
  const newestFirst = [];
  for (let index = normalized.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
    const message = normalized[index];
    const text = truncateUTF8(message.text, Math.min(maxMessageBytes, remainingBytes));
    if (!text) continue;
    newestFirst.push({ ...message, text });
    remainingBytes -= Buffer.byteLength(text, "utf8");
  }
  return newestFirst.reverse();
}

function hasOwn(object, key) {
  return object !== null
    && object !== undefined
    && Object.prototype.hasOwnProperty.call(object, key);
}

export function extractRecentMessages(result, limits) {
  const newestFirstTurns = Array.isArray(result?.data) ? result.data : [];
  const messages = [];
  const seen = new Set();
  for (const turn of [...newestFirstTurns].reverse()) {
    if (!Array.isArray(turn?.items)) continue;
    const turnID = cleanTurnID(turn.id);
    for (const item of turn.items) {
      const userText = textFromUserMessage(item);
      const delegatedUserText = textFromCodexDelegation(item);
      if (userText || delegatedUserText) {
        appendDistinctMessage(messages, seen, {
          role: "user",
          text: userText || delegatedUserText,
          ...(turnID ? { turn_id: turnID } : {})
        });
      } else if (item?.type === "agentMessage" && item.phase === "final_answer") {
        const assistantText = cleanText(item.text);
        if (assistantText) {
          appendDistinctMessage(messages, seen, {
            role: "assistant",
            text: assistantText,
            ...(turnID ? { turn_id: turnID } : {})
          });
        }
      }
    }
  }
  return boundRecentMessages(messages, limits);
}

function itemRowIdentity(row) {
  const turnID = cleanTurnID(row?.turnId);
  const itemID = cleanItemID(row?.item?.id);
  return turnID && itemID ? `${turnID}\u0000${itemID}` : undefined;
}

function isPublicItemRow(row) {
  if (!cleanTurnID(row?.turnId)) return false;
  if (row?.item?.type === "userMessage") return Boolean(textFromUserMessage(row.item));
  if (row?.item?.type === "functionCallOutput") {
    return Boolean(textFromCodexDelegation(row.item));
  }
  return row?.item?.type === "agentMessage"
    && (row.item.phase === "commentary" || row.item.phase === "final_answer")
    && Boolean(cleanText(row.item.text));
}

export function extractRecentMessagesFromItemRows(rows, limits) {
  const messages = [];
  const seen = new Set();
  for (const row of [...(Array.isArray(rows) ? rows : [])].reverse()) {
    const turnID = cleanTurnID(row?.turnId);
    if (!turnID) continue;
    const userText = textFromUserMessage(row?.item);
    const delegatedUserText = textFromCodexDelegation(row?.item);
    if (userText || delegatedUserText) {
      appendDistinctMessage(messages, seen, {
        role: "user",
        text: userText || delegatedUserText,
        turn_id: turnID
      });
    } else if (row?.item?.type === "agentMessage"
        && row.item.phase === "final_answer") {
      const assistantText = cleanText(row.item.text);
      if (assistantText) {
        appendDistinctMessage(messages, seen, {
          role: "assistant",
          text: assistantText,
          turn_id: turnID
        });
      }
    }
  }
  return boundRecentMessages(messages, limits);
}

export function extractLiveProgressFromItemRows(rows, liveTurn, limits) {
  const boundedTurn = boundLiveTurn(liveTurn);
  if (!boundedTurn?.is_active) return [];
  const currentRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => cleanTurnID(row?.turnId) === boundedTurn.turn_id);
  if (currentRows.some((row) => row?.item?.type === "agentMessage"
      && row.item.phase === "final_answer")) {
    return [];
  }
  return boundLiveProgress(
    [...currentRows]
      .reverse()
      .filter((row) => row?.item?.type === "agentMessage"
        && row.item.phase === "commentary")
      .map((row) => ({
        turn_id: boundedTurn.turn_id,
        item_id: row.item.id,
        text: row.item.text
      })),
    limits
  );
}

export function boundLiveCommentary(commentary, {
  maxTextBytes = DEFAULT_MAX_LIVE_COMMENTARY_BYTES
} = {}) {
  if (!commentary || maxTextBytes <= 0) return undefined;
  const turnID = cleanTurnID(commentary.turn_id);
  const itemID = cleanItemID(commentary.item_id);
  const text = truncateUTF8(cleanText(commentary.text), maxTextBytes);
  if (!turnID || !itemID || !text) return undefined;
  return {
    turn_id: turnID,
    item_id: itemID,
    text
  };
}

export function extractLiveCommentary(result, limits) {
  // thread/turns/list is requested newest-first. Never revive commentary from
  // an older turn when the current turn has not emitted public progress.
  const latestTurn = Array.isArray(result?.data) ? result.data[0] : undefined;
  if (!latestTurn || !Array.isArray(latestTurn.items)) return undefined;

  // A final answer is authoritative for the turn even if commentary items
  // precede it. This clears the transient progress from Pinland immediately.
  if (latestTurn.items.some(
    (item) => item?.type === "agentMessage" && item.phase === "final_answer"
  )) {
    return undefined;
  }

  let latestCommentary;
  for (const item of latestTurn.items) {
    if (item?.type === "agentMessage" && item.phase === "commentary") {
      latestCommentary = {
        turn_id: latestTurn.id,
        item_id: item.id,
        text: item.text
      };
    }
  }
  return boundLiveCommentary(latestCommentary, limits);
}

export function boundLiveProgress(progress, {
  maxItems = DEFAULT_MAX_LIVE_PROGRESS_ITEMS,
  maxTextBytes = DEFAULT_MAX_LIVE_COMMENTARY_BYTES,
  maxSessionBytes = DEFAULT_MAX_LIVE_PROGRESS_BYTES
} = {}) {
  if (!Array.isArray(progress)
      || maxItems <= 0
      || maxTextBytes <= 0
      || maxSessionBytes <= 0) {
    return [];
  }

  const normalized = progress
    .map((commentary) => boundLiveCommentary(commentary, { maxTextBytes }))
    .filter(Boolean)
    .slice(-maxItems);

  // Prefer the most recent public updates only when an unusually large turn
  // exceeds the aggregate safety ceiling, then restore chronological order.
  let remainingBytes = maxSessionBytes;
  const newestFirst = [];
  for (let index = normalized.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
    // Do not surface a one- or two-character shard from an older update merely
    // to fill the last bytes of the aggregate budget.
    if (remainingBytes < Math.min(64, maxTextBytes)) break;
    const commentary = normalized[index];
    const text = truncateUTF8(
      commentary.text,
      Math.min(maxTextBytes, remainingBytes)
    );
    if (!text) continue;
    newestFirst.push({ ...commentary, text });
    remainingBytes -= Buffer.byteLength(text, "utf8");
  }
  return newestFirst.reverse();
}

export function extractLiveProgress(result, limits) {
  // thread/turns/list is newest-first. Progress from an older turn must never
  // be shown as though it belongs to the current active turn.
  const latestTurn = Array.isArray(result?.data) ? result.data[0] : undefined;
  if (!latestTurn || !Array.isArray(latestTurn.items)) return [];

  // A published final answer is authoritative even if app-server retains the
  // earlier commentary items in the same turn.
  if (latestTurn.items.some(
    (item) => item?.type === "agentMessage" && item.phase === "final_answer"
  )) {
    return [];
  }

  const progress = latestTurn.items
    .filter((item) => item?.type === "agentMessage" && item.phase === "commentary")
    .map((item) => ({
      turn_id: latestTurn.id,
      item_id: item.id,
      text: item.text
    }));
  return boundLiveProgress(progress, limits);
}

export function boundLiveTurn(turn) {
  if (!turn) return undefined;
  const turnID = cleanTurnID(turn.turn_id);
  const status = typeof turn.status === "string" ? turn.status : undefined;
  const isActive = turn.is_active;
  if (!turnID
      || !ALLOWED_LIVE_TURN_STATUSES.has(status)
      || typeof isActive !== "boolean") {
    return undefined;
  }
  // Statuses with an unambiguous lifecycle meaning must agree with the
  // normalized active bit. app-server currently reports Desktop-owned live
  // turns as interrupted without completion metadata, so interrupted may be
  // either active or terminal depending on that metadata.
  if ((status === "inProgress" && !isActive)
      || ((status === "completed" || status === "failed") && isActive)) {
    return undefined;
  }
  return {
    turn_id: turnID,
    status,
    is_active: isActive
  };
}

function optionalNonnegativeInteger(value) {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function extractLiveTurn(result) {
  const latestTurn = Array.isArray(result?.data) ? result.data[0] : undefined;
  if (!latestTurn) return undefined;
  const completedAt = optionalNonnegativeInteger(latestTurn.completedAt);
  const durationMs = optionalNonnegativeInteger(latestTurn.durationMs);
  if (completedAt === undefined || durationMs === undefined) return undefined;

  // A separate app-server currently serializes a Desktop-owned active turn as
  // interrupted with no completion timestamp or duration. A genuinely
  // interrupted historical turn has one or both completion fields populated.
  const isActive = latestTurn.status === "inProgress"
    || (latestTurn.status === "interrupted"
      && completedAt === null
      && durationMs === null);
  return boundLiveTurn({
    turn_id: latestTurn.id,
    status: latestTurn.status,
    is_active: isActive
  });
}

function updateKey(session) {
  return Number.isFinite(session?.updated_at_ms)
    ? String(session.updated_at_ms)
    : "missing";
}

function prefersPaginatedItems(entry, historyMode, fetchItems) {
  return historyMode === "paginated"
    && typeof fetchItems === "function"
    && entry?.itemsUnsupportedFor !== historyMode;
}

function shouldRefresh(entry, key, now, usePaginatedItems, runtimeIsActive) {
  if (entry?.failedUpdateKey === key && entry.retryAtMs > now) return false;
  // A legacy rollout can update its metadata several times during one turn.
  // Once the initial bounded summary has established its current turn, never
  // rescan that legacy rollout while the cheap state database still reports it
  // active. Large pre-pagination rollouts otherwise make app-server repeatedly
  // parse gigabytes of history. The cheap runtime transition to inactive still
  // refreshes immediately, so the final answer is collected without polling.
  if (!usePaginatedItems && entry?.liveTurn?.is_active === true) {
    if (runtimeIsActive === false) return true;
    if (runtimeIsActive === true) return false;
    return now >= (entry?.nextActiveRefreshAtMs || 0);
  }
  if (entry?.updateKey !== key) return true;
  if (entry?.liveTurn?.is_active !== true
      && !entry?.liveCommentary
      && !(Array.isArray(entry?.liveProgress) && entry.liveProgress.length > 0)) {
    return false;
  }
  // The paginated item store is indexed and cheap enough to read at the
  // companion cadence. Legacy summaries still scan the rollout, so refresh
  // them only on updatedAt changes plus a conservative active-turn guard.
  return usePaginatedItems || now >= (entry?.nextActiveRefreshAtMs || 0);
}

async function runWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await operation(values[index]);
      }
    }
  );
  await Promise.all(workers);
}

function unsupportedItemsError(error) {
  return error?.code === -32601
    || (typeof error?.message === "string"
      && error.message.toLowerCase().includes("thread/items/list is not supported"));
}

function mergeUnique(values, maximum) {
  const merged = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
    if (merged.length >= maximum) break;
  }
  return merged;
}

function mergePublicItemRows(incoming, previous) {
  const merged = [];
  const seen = new Set();
  for (const row of [
    ...(Array.isArray(incoming) ? incoming : []),
    ...(Array.isArray(previous) ? previous : [])
  ]) {
    const identity = itemRowIdentity(row);
    if (!identity || seen.has(identity) || !isPublicItemRow(row)) continue;
    seen.add(identity);
    merged.push(row);
    if (merged.length >= DEFAULT_MAX_PUBLIC_ITEM_ROWS) break;
  }
  return merged;
}

async function fetchIncrementalItemRows(
  sessionID,
  previous,
  liveTurn,
  fetchItems,
  maxItemsScan
) {
  const known = new Set(Array.isArray(previous?.seenItemKeys)
    ? previous.seenItemKeys
    : []);
  const publicRows = [];
  const itemKeys = [];
  let cursor;
  let foundKnown = false;
  let reachedBeginning = false;
  let sawOlderTurn = liveTurn?.is_active !== true;
  let scanned = 0;

  for (let page = 0; page < 20 && scanned < maxItemsScan; page += 1) {
    const remaining = Math.min(DEFAULT_ITEMS_PAGE_SIZE, maxItemsScan - scanned);
    const result = await fetchItems(
      sessionID,
      recentItemsListParams(sessionID, cursor, remaining)
    );
    if (!result || !Array.isArray(result.data)) {
      throw new Error("thread/items/list returned an invalid page");
    }

    for (const row of result.data) {
      const identity = itemRowIdentity(row);
      if (identity && known.has(identity)) {
        foundKnown = true;
        break;
      }
      scanned += 1;
      if (identity) itemKeys.push(identity);
      if (isPublicItemRow(row)) publicRows.push(row);
      if (liveTurn?.is_active === true
          && cleanTurnID(row?.turnId) !== liveTurn.turn_id) {
        sawOlderTurn = true;
      }
      if (scanned >= maxItemsScan) break;
    }
    if (foundKnown || scanned >= maxItemsScan) break;

    const savedCount = extractRecentMessagesFromItemRows(publicRows).length;
    if (savedCount >= DEFAULT_MAX_MESSAGES && sawOlderTurn) break;
    if (!result.nextCursor) {
      reachedBeginning = true;
      break;
    }
    cursor = result.nextCursor;
  }

  return { publicRows, itemKeys, foundKnown, reachedBeginning };
}

function legacyActiveRefreshDelay(
  previous,
  key,
  liveTurn,
  baseDelay,
  maximumDelay,
  step
) {
  if (liveTurn?.is_active !== true) return undefined;
  if (previous?.source !== "legacy"
      || previous.updateKey !== key
      || previous.liveTurn?.is_active !== true) {
    return baseDelay;
  }
  return Math.min(maximumDelay, (previous.activeRefreshDelayMs || baseDelay) + step);
}

async function refreshLegacyEntry(session, key, previous, fetchTurns, options) {
  const result = await fetchTurns(
    session.session_id,
    recentTurnsListParams(session.session_id)
  );
  const liveTurn = extractLiveTurn(result);
  const liveProgress = liveTurn?.is_active === true ? extractLiveProgress(result) : [];
  const extractedMessages = extractRecentMessages(result);
  // Each successful turns/list response is already an authoritative
  // chronological snapshot. Re-merging the prior snapshot in front could pin
  // a formerly missing row to the wrong position when it appears later.
  const messages = extractedMessages;
  const activeRefreshDelayMs = legacyActiveRefreshDelay(
    previous,
    key,
    liveTurn,
    options.legacyActiveRefreshMs,
    options.maxLegacyActiveRefreshMs,
    options.legacyActiveRefreshStepMs
  );
  const next = {
    updateKey: key,
    source: "legacy",
    liveCommentary: liveProgress.at(-1) || null,
    liveProgress,
    liveTurn,
    ...(previous?.itemsUnsupportedFor
      ? { itemsUnsupportedFor: previous.itemsUnsupportedFor }
      : {}),
    ...(activeRefreshDelayMs === undefined
      ? {}
      : {
        activeRefreshDelayMs,
        nextActiveRefreshAtMs: options.now + activeRefreshDelayMs
      })
  };
  if (messages.length > 0 || liveTurn?.is_active !== true) {
    next.messages = messages;
  } else if (hasOwn(previous, "messages")) {
    next.messages = previous.messages;
  }
  return next;
}

async function refreshPaginatedEntry(
  session,
  key,
  previous,
  fetchTurns,
  fetchItems,
  options
) {
  const latestTurnResult = await fetchTurns(
    session.session_id,
    latestTurnListParams(session.session_id)
  );
  const liveTurn = extractLiveTurn(latestTurnResult);
  const incremental = await fetchIncrementalItemRows(
    session.session_id,
    previous,
    liveTurn,
    fetchItems,
    options.maxItemsScan
  );
  const authoritativeReset = incremental.reachedBeginning && !incremental.foundKnown;
  const publicItemRows = authoritativeReset
    ? mergePublicItemRows(incremental.publicRows, [])
    : mergePublicItemRows(incremental.publicRows, previous?.publicItemRows);
  const extractedMessages = extractRecentMessagesFromItemRows(publicItemRows);
  // publicItemRows already merges by stable item identity in newest-first
  // protocol order. Reversing that set above yields the authoritative
  // chronology; appending the previous presentation order can only scramble
  // a delayed row.
  const messages = extractedMessages;
  const liveProgress = extractLiveProgressFromItemRows(
    publicItemRows,
    liveTurn
  );
  const next = {
    updateKey: key,
    source: "items",
    publicItemRows,
    seenItemKeys: mergeUnique([
      ...incremental.itemKeys,
      ...(authoritativeReset ? [] : (previous?.seenItemKeys || []))
    ], options.maxItemsScan),
    liveCommentary: liveProgress.at(-1) || null,
    liveProgress,
    liveTurn
  };
  if (messages.length > 0 || liveTurn?.is_active !== true) {
    next.messages = messages;
  } else if (hasOwn(previous, "messages")) {
    next.messages = previous.messages;
  }
  return next;
}

export async function attachRecentMessages(sessions, cache, fetchTurns, {
  now = Date.now(),
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  concurrency = DEFAULT_CONCURRENCY,
  fetchItems,
  historyModeForSession = () => undefined,
  legacyActiveRefreshMs = DEFAULT_LEGACY_ACTIVE_REFRESH_MS,
  maxLegacyActiveRefreshMs = DEFAULT_MAX_LEGACY_ACTIVE_REFRESH_MS,
  legacyActiveRefreshStepMs = DEFAULT_LEGACY_ACTIVE_REFRESH_STEP_MS,
  maxItemsScan = DEFAULT_MAX_ITEMS_SCAN,
  skipLegacyHistory = false
} = {}) {
  const pinnedIDs = new Set(sessions.map((session) => session.session_id));
  for (const sessionID of cache.keys()) {
    if (!pinnedIDs.has(sessionID)) cache.delete(sessionID);
  }

  // Pre-pagination rollouts require app-server to scan the entire legacy JSONL
  // even when only a handful of summarized turns are requested. The desktop
  // companion opts out of that background work: Pinland keeps its persisted
  // bounded transcript and lifecycle hooks append the current prompt/result.
  // New paginated tasks continue to receive indexed incremental history.
  if (skipLegacyHistory) {
    for (const session of sessions) {
      if (historyModeForSession(session.session_id) === "legacy") {
        cache.delete(session.session_id);
      }
    }
  }

  const refreshes = sessions
    .map((session) => {
      const entry = cache.get(session.session_id);
      const historyMode = historyModeForSession(session.session_id);
      const usePaginatedItems = prefersPaginatedItems(entry, historyMode, fetchItems);
      const isSkippedLegacy = skipLegacyHistory && historyMode === "legacy";
      return {
        session,
        key: updateKey(session),
        historyMode,
        usePaginatedItems,
        isSkippedLegacy
      };
    })
    .filter(({ session, key, usePaginatedItems, isSkippedLegacy }) => (
      !isSkippedLegacy && shouldRefresh(
        cache.get(session.session_id),
        key,
        now,
        usePaginatedItems,
        session.runtime_is_active
      )
    ));

  const refreshOptions = {
    now,
    legacyActiveRefreshMs,
    maxLegacyActiveRefreshMs,
    legacyActiveRefreshStepMs,
    maxItemsScan
  };
  await runWithConcurrency(
    refreshes,
    concurrency,
    async ({ session, key, historyMode, usePaginatedItems }) => {
      let previous = cache.get(session.session_id);
      try {
        if (usePaginatedItems) {
          try {
            const next = await refreshPaginatedEntry(
              session,
              key,
              previous,
              fetchTurns,
              fetchItems,
              refreshOptions
            );
            cache.set(session.session_id, next);
            return;
          } catch (error) {
            if (!unsupportedItemsError(error)) throw error;
            previous = {
              ...previous,
              itemsUnsupportedFor: historyMode
            };
          }
        }
        cache.set(
          session.session_id,
          await refreshLegacyEntry(
            session,
            key,
            previous,
            fetchTurns,
            refreshOptions
          )
        );
      } catch {
        const next = {
          ...previous,
          failedUpdateKey: key,
          retryAtMs: now + retryDelayMs
        };
        if (!hasOwn(previous, "messages")) delete next.messages;
        cache.set(session.session_id, next);
      }
    }
  );

  return sessions.map((session) => {
    if (skipLegacyHistory && historyModeForSession(session.session_id) === "legacy") {
      return { ...session };
    }
    const entry = cache.get(session.session_id);
    return {
      ...session,
      ...(hasOwn(entry, "messages")
        ? { recent_messages: entry.messages }
        : {}),
      // Always send the key so a successful refresh can explicitly clear stale
      // progress after the latest turn publishes its final answer.
      live_commentary: entry?.liveCommentary || null,
      // Transient and public-only. The app never persists this sequence and a
      // terminal turn explicitly replaces it with an empty array.
      live_progress: entry?.liveProgress || [],
      // Turn status comes only from app-server's bounded TurnStatus field. It is
      // never inferred from commentary presence or lifecycle hook timing.
      live_turn: entry?.liveTurn || null
    };
  });
}
