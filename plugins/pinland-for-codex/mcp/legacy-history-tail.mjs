import { createHash } from "node:crypto";
import fs from "node:fs";
import { parseAsyncQuestionReply } from "./desktop-async-questions.mjs";

import {
  boundLiveProgress,
  boundRecentMessages,
  textFromCodexDelegation,
  truncateUTF8
} from "./recent-history.mjs";
import {
  defaultCodexSessionsRoot,
  discoverRolloutPath
} from "./external-approval.mjs";

// A single tool-heavy Codex turn can exceed 64 MiB even though its public
// transcript contains only a few compact messages. Keep memory bounded to one
// chunk while allowing a cold start to reach the requested five public rows.
const DEFAULT_MAX_SCAN_BYTES = 128 * 1_024 * 1_024;
const DEFAULT_CHUNK_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_MAX_LINE_BYTES = 256 * 1_024;
const DEFAULT_MAX_INCREMENT_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MAX_COLD_SCANS_PER_ATTACH = 2;
const DEFAULT_DISCOVERY_RETRY_MS = 15_000;
const DEFAULT_MAX_SAVED_MESSAGES = 5;
const MAX_IDENTIFIER_LENGTH = 128;

function cleanIdentifier(value) {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return identifier && identifier.length <= MAX_IDENTIFIER_LENGTH
    ? identifier
    : undefined;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function userDisplayText(text) {
  const replies = parseAsyncQuestionReply([{ type: "text", text }]);
  if (replies) return replies.map(r => r.answer).join("\n\n");
  const requestMarker = /(?:^|\n)## My request(?: for Codex)?:\s*\n/u;
  const marker = requestMarker.exec(text);
  const request = marker
    ? text.slice(marker.index + marker[0].length)
    : text;
  // Codex records app attachment descriptors after the human request. They
  // are transport metadata, not conversation copy for the compact preview.
  return request
    .replace(/\n*<image\b[^>]*>[\s\S]*?<\/image>\s*$/gu, "")
    .trim();
}

function assistantDisplayText(text) {
  // Memory citations are an app rendering side channel appended after the
  // visible answer. Keep them out of Pinland's plain conversation cards.
  return text
    .replace(/\n*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/u, "")
    .trim();
}

function fallbackItemID(turnID, kind, text) {
  return `legacy-${createHash("sha256")
    .update(`${turnID}\u0000${kind}\u0000${text}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Parses only explicitly public rollout records. Do not broaden this parser to
 * recursively collect text: rollout files also contain reasoning, tool input,
 * tool output, diffs, environment state, and attachment metadata.
 */
export function parseLegacyPublicRolloutLine(line) {
  if (typeof line !== "string" || !line) return undefined;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (entry?.type === "turn_context") {
    const turnID = cleanIdentifier(entry.payload?.turn_id);
    return turnID ? { kind: "context", turnID } : undefined;
  }

  if (entry?.type === "event_msg") {
    const eventType = entry.payload?.type;
    if (eventType === "task_started" || eventType === "task_complete") {
      const turnID = cleanIdentifier(entry.payload?.turn_id);
      return turnID
        ? { kind: eventType === "task_started" ? "started" : "completed", turnID }
        : undefined;
    }
    let kind;
    let text;
    if (eventType === "user_message") {
      kind = "user";
      text = userDisplayText(cleanText(entry.payload?.message));
    } else if (eventType === "agent_message"
        && entry.payload?.phase === "commentary") {
      kind = "commentary";
      text = assistantDisplayText(cleanText(entry.payload?.message));
    } else if (eventType === "agent_message"
        && entry.payload?.phase === "final_answer") {
      kind = "final";
      text = assistantDisplayText(cleanText(entry.payload?.message));
    } else {
      return undefined;
    }
    text = truncateUTF8(text, 4_000);
    if (!text) return undefined;
    const sourceID = cleanText(entry.timestamp).slice(0, 64);
    return { kind, text, sourceID };
  }

  if (entry?.type === "response_item"
      && entry.payload?.type === "function_call_output") {
    // Codex records a user-authored cross-task send as one narrowly-defined
    // public delegation envelope instead of an event_msg/user_message row.
    // Normalize only that exact envelope; every other tool output remains
    // private and continues to fail closed below.
    const text = truncateUTF8(textFromCodexDelegation({
      type: "functionCallOutput",
      namespace: entry.payload.namespace,
      name: entry.payload.name,
      output: entry.payload.output
    }), 4_000);
    if (!text) return undefined;
    const turnID = cleanIdentifier(
      entry.payload.internal_chat_message_metadata_passthrough?.turn_id
    );
    const sourceID = cleanIdentifier(entry.payload.id);
    return {
      kind: "user",
      text,
      ...(turnID ? { turnID } : {}),
      ...(sourceID ? { sourceID } : {})
    };
  }
  // response_item/message rows are not trusted as public on legacy rollouts:
  // some internal environment/context injections also use role=user. Their
  // matching event_msg record is the authoritative visible publication. The
  // validated delegation exception above is the only tool output rendered.
  return undefined;
}

function savedRow(row) {
  return row?.kind === "user" || row?.kind === "final";
}

function rowKey(row) {
  return row?.itemID || `${row?.kind || ""}\u0000${row?.turnID || ""}\u0000${row?.text || ""}`;
}

function emptyLegacyState() {
  return {
    recentRows: [],
    liveRows: [],
    latestTurnID: undefined,
    latestTurnHasFinal: false,
    seenKeys: []
  };
}

function applyRows(previous, rows) {
  const state = previous
    ? {
      recentRows: [...(previous.recentRows || [])],
      liveRows: [...(previous.liveRows || [])],
      latestTurnID: previous.latestTurnID,
      latestTurnHasFinal: previous.latestTurnHasFinal === true,
      seenKeys: [...(previous.seenKeys || [])]
    }
    : emptyLegacyState();
  const seen = new Set(state.seenKeys);

  for (const unassociatedRow of rows) {
    let row = unassociatedRow;
    if ((row.kind === "user" || row.kind === "commentary" || row.kind === "final")
        && !row.turnID) {
      const turnID = cleanIdentifier(state.latestTurnID);
      if (!turnID) continue;
      row = {
        ...row,
        turnID,
        itemID: fallbackItemID(
          turnID,
          row.kind,
          `${row.sourceID || ""}\u0000${row.text}`
        )
      };
    }
    if (row.kind === "user" || row.kind === "commentary" || row.kind === "final") {
      const text = truncateUTF8(cleanText(row.text), 4_000);
      if (!text) continue;
      row = { ...row, text };
    }
    const key = rowKey(row);
    if (seen.has(key)) continue;

    // Some Codex builds can publish the same user-authored delegation through
    // both the strict function-call envelope and a public user event. Preserve
    // repeated prompts from different turns, while rendering one bubble for
    // two encodings of the same role/text/turn.
    if (savedRow(row)
        && state.recentRows.some((existing) => existing.kind === row.kind
          && existing.turnID === row.turnID
          && existing.text === row.text)) {
      seen.add(key);
      state.seenKeys.push(key);
      continue;
    }
    seen.add(key);
    state.seenKeys.push(key);

    if (row.turnID && row.turnID !== state.latestTurnID) {
      state.latestTurnID = row.turnID;
      state.latestTurnHasFinal = false;
      state.liveRows = [];
    }

    if (row.kind === "started" || row.kind === "context") {
      state.latestTurnHasFinal = false;
      if (row.kind === "started") state.liveRows = [];
    } else if (row.kind === "completed") {
      state.latestTurnHasFinal = true;
      state.liveRows = [];
    } else if (row.kind === "user") {
      state.recentRows.push(row);
      state.recentRows = state.recentRows.slice(-DEFAULT_MAX_SAVED_MESSAGES);
    } else if (row.kind === "commentary") {
      state.liveRows.push(row);
      state.liveRows = state.liveRows.slice(-64);
    } else if (row.kind === "final") {
      state.recentRows.push(row);
      state.recentRows = state.recentRows.slice(-DEFAULT_MAX_SAVED_MESSAGES);
      state.latestTurnHasFinal = true;
      state.liveRows = [];
    }
  }
  state.seenKeys = state.seenKeys.slice(-512);
  return state;
}

function snapshotFromState(state, allowTransientState) {
  const recentMessages = boundRecentMessages(
    (state?.recentRows || []).map((row) => ({
      role: row.kind === "user" ? "user" : "assistant",
      text: row.text,
      turn_id: row.turnID
    }))
  );
  const liveTurnID = cleanIdentifier(state?.latestTurnID);
  // A separate app-server process reports Codex Desktop-owned legacy tasks as
  // `notLoaded`, even while their rollout is actively receiving this turn.
  // The public task_started/task_complete (or final-answer) lifecycle in the
  // rollout is authoritative for these tasks. `allowTransientState` is only
  // false after a deferred cold scan or read/rotation failure, where showing a
  // cached progress row could be misleading.
  const isActive = allowTransientState === true
    && Boolean(liveTurnID)
    && state?.latestTurnHasFinal !== true;
  const liveProgress = isActive && state?.latestTurnHasFinal !== true
    ? boundLiveProgress((state?.liveRows || [])
      .filter((row) => row.turnID === liveTurnID)
      .map((row) => ({
        turn_id: row.turnID,
        item_id: row.itemID,
        text: row.text
      })))
    : [];
  return {
    ...(recentMessages.length > 0 ? { recent_messages: recentMessages } : {}),
    live_commentary: liveProgress.at(-1) || null,
    live_progress: liveProgress,
    live_turn: isActive
      ? { turn_id: liveTurnID, status: "inProgress", is_active: true }
      : null
  };
}

function addReverseFragment(accumulator, fragment, maximumLineBytes) {
  if (accumulator.oversized || fragment.length === 0) return;
  accumulator.length += fragment.length;
  if (accumulator.length > maximumLineBytes) {
    accumulator.fragments = [];
    accumulator.oversized = true;
    return;
  }
  accumulator.fragments.push(Buffer.from(fragment));
}

function consumeReverseLine(accumulator, onLine) {
  if (!accumulator.oversized && accumulator.length > 0) {
    const line = Buffer.concat(
      [...accumulator.fragments].reverse(),
      accumulator.length
    ).toString("utf8");
    onLine(line);
  }
  accumulator.fragments = [];
  accumulator.length = 0;
  accumulator.oversized = false;
}

/**
 * Walks a rollout backwards in fixed chunks. Oversized non-public JSONL rows
 * are discarded without ever assembling them, so a compacted history line
 * cannot turn a five-message preview into a multi-gigabyte read.
 */
export async function scanLegacyRolloutTail(filePath, {
  maximumScanBytes = DEFAULT_MAX_SCAN_BYTES,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maximumLineBytes = DEFAULT_MAX_LINE_BYTES,
  maximumSavedMessages = DEFAULT_MAX_SAVED_MESSAGES,
  fileSystem = fs.promises
} = {}) {
  const handle = await fileSystem.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const minimumPosition = Math.max(0, stats.size - maximumScanBytes);
    let position = stats.size;
    let bytesScanned = 0;
    const uniqueSavedMessages = new Set();
    let commentaryMessages = 0;
    let needsLeadingTurnContext = false;
    let shouldStop = false;
    let firstLineAtEOF = true;
    let trailingPartial = Buffer.alloc(0);
    let droppingTrailingPartial = false;
    const newestRows = [];
    const accumulator = { fragments: [], length: 0, oversized: false };

    let endsWithNewline = true;
    if (stats.size > 0) {
      const probe = Buffer.allocUnsafe(1);
      const probeResult = await handle.read(probe, 0, 1, stats.size - 1);
      endsWithNewline = probeResult.bytesRead === 1 && probe[0] === 0x0a;
    }

    const finishLine = () => {
      if (firstLineAtEOF && !endsWithNewline) {
        if (accumulator.oversized) {
          droppingTrailingPartial = true;
        } else if (accumulator.length > 0) {
          trailingPartial = Buffer.concat(
            [...accumulator.fragments].reverse(),
            accumulator.length
          );
        }
        accumulator.fragments = [];
        accumulator.length = 0;
        accumulator.oversized = false;
        firstLineAtEOF = false;
        return;
      }
      firstLineAtEOF = false;
      consumeReverseLine(accumulator, (line) => {
        const row = parseLegacyPublicRolloutLine(line);
        if (!row) return;
        if (row.kind === "commentary") {
          commentaryMessages += 1;
          if (commentaryMessages > 64) return;
        }
        newestRows.push(row);
        if (savedRow(row)) {
          // Stop only after five distinct public payloads. A user-authored
          // delegation may have both a function-call envelope and a public
          // event encoding; counting those separately could stop the reverse
          // scan before five visible bubbles are actually recoverable.
          uniqueSavedMessages.add(`${row.kind}\u0000${row.text}`);
          if (uniqueSavedMessages.size >= maximumSavedMessages) {
            needsLeadingTurnContext = true;
          }
        } else if (needsLeadingTurnContext
            && (row.kind === "started" || row.kind === "context")) {
          shouldStop = true;
        }
      });
    };

    while (position > minimumPosition && !shouldStop) {
      const readStart = Math.max(minimumPosition, position - chunkBytes);
      const requested = position - readStart;
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, readStart);
      if (bytesRead <= 0) break;
      bytesScanned += bytesRead;
      let cursor = bytesRead;
      while (cursor > 0 && !shouldStop) {
        const newline = buffer.lastIndexOf(0x0a, cursor - 1);
        const fragmentStart = newline + 1;
        addReverseFragment(
          accumulator,
          buffer.subarray(fragmentStart, cursor),
          maximumLineBytes
        );
        if (newline < 0) {
          cursor = 0;
        } else {
          finishLine();
          cursor = newline;
        }
      }
      position = readStart;
    }
    if (position === 0 && !shouldStop) finishLine();

    const state = applyRows(undefined, [...newestRows].reverse());
    return {
      state,
      partialLine: trailingPartial,
      droppingPartialLine: droppingTrailingPartial,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      bytesScanned
    };
  } finally {
    await handle.close();
  }
}

function appendForwardSegment(parser, segment, maximumLineBytes) {
  if (parser.droppingPartialLine || segment.length === 0) return;
  if (parser.partialLine.length + segment.length > maximumLineBytes) {
    parser.partialLine = Buffer.alloc(0);
    parser.droppingPartialLine = true;
    return;
  }
  parser.partialLine = Buffer.concat([parser.partialLine, segment]);
}

/** Reads only bytes appended since the last poll and preserves a partial line. */
export async function readLegacyRolloutAppend(filePath, start, end, {
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maximumLineBytes = DEFAULT_MAX_LINE_BYTES,
  partialLine = Buffer.alloc(0),
  droppingPartialLine = false,
  fileSystem = fs.promises
} = {}) {
  const handle = await fileSystem.open(filePath, "r");
  const parser = {
    partialLine: Buffer.isBuffer(partialLine) ? partialLine : Buffer.alloc(0),
    droppingPartialLine: droppingPartialLine === true
  };
  const rows = [];
  try {
    let position = start;
    while (position < end) {
      const requested = Math.min(chunkBytes, end - position);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) break;
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline < 0) {
          appendForwardSegment(
            parser,
            buffer.subarray(cursor, bytesRead),
            maximumLineBytes
          );
          cursor = bytesRead;
          continue;
        }
        appendForwardSegment(
          parser,
          buffer.subarray(cursor, newline),
          maximumLineBytes
        );
        if (!parser.droppingPartialLine && parser.partialLine.length > 0) {
          const row = parseLegacyPublicRolloutLine(
            parser.partialLine.toString("utf8")
          );
          if (row) rows.push(row);
        }
        parser.partialLine = Buffer.alloc(0);
        parser.droppingPartialLine = false;
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    return {
      rows,
      partialLine: parser.partialLine,
      droppingPartialLine: parser.droppingPartialLine,
      endOffset: position
    };
  } finally {
    await handle.close();
  }
}

export class LegacyHistoryTailTracker {
  constructor({
    sessionsRoot = defaultCodexSessionsRoot(),
    maximumIncrementBytes = DEFAULT_MAX_INCREMENT_BYTES,
    maximumColdScansPerAttach = DEFAULT_MAX_COLD_SCANS_PER_ATTACH,
    discoveryRetryMs = DEFAULT_DISCOVERY_RETRY_MS,
    now = () => Date.now(),
    discover = discoverRolloutPath,
    stat = (filePath) => fs.promises.stat(filePath),
    scanTail = scanLegacyRolloutTail,
    readAppend = readLegacyRolloutAppend
  } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.maximumIncrementBytes = maximumIncrementBytes;
    this.maximumColdScansPerAttach = maximumColdScansPerAttach;
    this.discoveryRetryMs = discoveryRetryMs;
    this.now = now;
    this.discover = discover;
    this.stat = stat;
    this.scanTail = scanTail;
    this.readAppend = readAppend;
    this.entries = new Map();
  }

  async attach(sessions, historyModeForSession = () => undefined) {
    const pinnedIDs = new Set(sessions.map((session) => session.session_id));
    for (const sessionID of this.entries.keys()) {
      if (!pinnedIDs.has(sessionID)) this.entries.delete(sessionID);
    }

    let coldScans = 0;
    const attached = [];
    for (const session of sessions) {
      if (historyModeForSession(session.session_id) !== "legacy") {
        attached.push(session);
        continue;
      }
      const sessionID = cleanIdentifier(session.session_id);
      if (!sessionID) {
        attached.push(session);
        continue;
      }

      let entry = this.entries.get(sessionID) || {};
      if (!entry.rolloutPath
          && !entry.state
          && coldScans >= this.maximumColdScansPerAttach) {
        this.entries.set(sessionID, entry);
        attached.push(session);
        continue;
      }
      if (!entry.rolloutPath && (entry.retryAt || 0) <= this.now()) {
        const rolloutPath = await this.discover(this.sessionsRoot, sessionID);
        entry = rolloutPath
          ? { ...entry, rolloutPath, retryAt: undefined }
          : { ...entry, retryAt: this.now() + this.discoveryRetryMs };
      }

      let suppressTransientState = entry.forceColdScan === true;
      try {
        if (entry.rolloutPath) {
          const stats = await this.stat(entry.rolloutPath);
          const identityChanged = Number.isInteger(entry.device)
            && Number.isInteger(entry.inode)
            && (entry.device !== stats.dev || entry.inode !== stats.ino);
          const needsColdScan = !entry.state
            || entry.forceColdScan === true
            || identityChanged
            || stats.size < (entry.size || 0)
            || stats.size - (entry.size || 0) > this.maximumIncrementBytes;
          if (needsColdScan && coldScans < this.maximumColdScansPerAttach) {
            const scanned = await this.scanTail(entry.rolloutPath);
            coldScans += 1;
            entry = {
              ...entry,
              ...scanned,
              device: stats.dev,
              inode: stats.ino,
              forceColdScan: false
            };
          } else if (!needsColdScan && stats.size > entry.size) {
            const appended = await this.readAppend(
              entry.rolloutPath,
              entry.size,
              stats.size,
              {
                partialLine: entry.partialLine,
                droppingPartialLine: entry.droppingPartialLine
              }
            );
            if (appended.endOffset !== stats.size) {
              throw new Error("legacy rollout append was not read completely");
            }
            entry = {
              ...entry,
              state: applyRows(entry.state, appended.rows),
              partialLine: appended.partialLine,
              droppingPartialLine: appended.droppingPartialLine,
              size: stats.size,
              modifiedAt: stats.mtimeMs,
              device: stats.dev,
              inode: stats.ino
            };
          } else if (needsColdScan) {
            suppressTransientState = true;
          } else if (!needsColdScan) {
            entry = {
              ...entry,
              modifiedAt: stats.mtimeMs,
              device: stats.dev,
              inode: stats.ino
            };
          }
        }
      } catch {
        // Preserve the last good bounded state across a transient rotate/read
        // failure, then rediscover without clearing the app's visible history.
        entry = entry.state
          ? {
            state: entry.state,
            forceColdScan: true,
            retryAt: this.now() + this.discoveryRetryMs
          }
          : { retryAt: this.now() + this.discoveryRetryMs };
        suppressTransientState = true;
      }
      this.entries.set(sessionID, entry);
      attached.push({
        ...session,
        ...(entry.state
          ? snapshotFromState(entry.state, !suppressTransientState)
          : {})
      });
    }
    return attached;
  }
}
