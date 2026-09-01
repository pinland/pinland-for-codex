import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_MAX_TAIL_BYTES = 512 * 1_024;
const DEFAULT_MAX_LINE_BYTES = 256 * 1_024;
const DEFAULT_MAX_DIRECTORIES = 4_096;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 100_000;
const DEFAULT_DISCOVERY_RETRY_MS = 15_000;
const MAX_IDENTIFIER_LENGTH = 128;
const APPROVAL_INPUT_PATTERN = /\bsandbox_permissions\s*:\s*["']require_escalated["']/u;
const NESTED_EXEC_COMMAND_PATTERN = /\btools\s*\.\s*exec_command\s*\(\s*\{/u;
const NESTED_PERMISSION_REQUEST_PATTERN = /^\s*(?:(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*)?await\s+tools\s*\.\s*request_permissions\s*\(\s*\{/u;

function cleanIdentifier(value) {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return identifier && identifier.length <= MAX_IDENTIFIER_LENGTH
    ? identifier
    : undefined;
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maximumLength) : undefined;
}

/**
 * The detector intentionally emits only generic metadata. In particular it
 * never forwards the command, path, justification, or tool input read from a
 * Codex rollout. Those details remain available in Codex's native approval UI.
 */
export function boundExternalApproval(value) {
  if (!value || typeof value !== "object") return undefined;
  const turnID = cleanIdentifier(value.turn_id);
  const kind = cleanText(value.kind, 64);
  const toolName = cleanText(value.tool_name, 128);
  const summary = cleanText(value.summary, 256);
  if (!kind || !summary) return undefined;
  return {
    ...(turnID ? { turn_id: turnID } : {}),
    kind,
    ...(toolName ? { tool_name: toolName } : {}),
    summary
  };
}

function responseItemTurnID(payload) {
  return cleanIdentifier(
    payload?.internal_chat_message_metadata_passthrough?.turn_id
  );
}

function nestedApprovalKind(payload, liveTurnID) {
  if (payload?.type !== "custom_tool_call"
      || payload.name !== "exec"
      || responseItemTurnID(payload) !== liveTurnID
      || !cleanIdentifier(payload.call_id)
      || typeof payload.input !== "string"
      || payload.input.length > DEFAULT_MAX_LINE_BYTES) {
    return undefined;
  }
  // `custom_tool_call` is the outer code-mode call. request_permissions must
  // be the first executable statement, which prevents command strings that
  // merely search for the API name from looking like approvals. For
  // exec_command, additionally require its escalation option so ordinary
  // long-running commands never look like approvals.
  if (NESTED_PERMISSION_REQUEST_PATTERN.test(payload.input)) {
    return "permissions";
  }
  if (NESTED_EXEC_COMMAND_PATTERN.test(payload.input)
      && APPROVAL_INPUT_PATTERN.test(payload.input)) {
    return "command";
  }
  return undefined;
}

/**
 * Derives one pending Desktop-owned approval from a bounded rollout tail.
 * Matching is deliberately strict: current turn, outer exec call, a known
 * approval-producing nested invocation, and no later output for the same call
 * id. The nested input is classified locally and is never forwarded.
 */
export function extractExternalApprovalFromRolloutText(
  text,
  { liveTurnID, startedMidLine = false } = {}
) {
  const normalizedTurnID = cleanIdentifier(liveTurnID);
  if (!normalizedTurnID || typeof text !== "string" || !text) return undefined;

  const lines = text.split("\n");
  if (startedMidLine) lines.shift();
  const candidates = new Map();
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, "utf8") > DEFAULT_MAX_LINE_BYTES) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "response_item") continue;
    const payload = entry.payload;
    const approvalKind = nestedApprovalKind(payload, normalizedTurnID);
    if (approvalKind) {
      candidates.set(payload.call_id, approvalKind);
      continue;
    }
    if (payload?.type === "custom_tool_call_output") {
      const callID = cleanIdentifier(payload.call_id);
      if (callID) candidates.delete(callID);
    }
  }
  if (candidates.size === 0) return undefined;
  const pendingKinds = Array.from(candidates.values());
  return {
    turn_id: normalizedTurnID,
    kind: pendingKinds[pendingKinds.length - 1],
    tool_name: "Codex",
    summary: "Approval required in Codex"
  };
}

export function defaultCodexSessionsRoot(environment = process.env) {
  const codexHome = typeof environment.CODEX_HOME === "string"
    ? environment.CODEX_HOME.trim()
    : "";
  return path.join(codexHome || path.join(homedir(), ".codex"), "sessions");
}

/**
 * Searches filenames only and stops at explicit traversal ceilings. The exact
 * task id suffix avoids opening unrelated rollouts during discovery.
 */
export async function discoverRolloutPath(
  sessionsRoot,
  sessionID,
  {
    maximumDirectories = DEFAULT_MAX_DIRECTORIES,
    maximumEntries = DEFAULT_MAX_DIRECTORY_ENTRIES,
    fileSystem = fs.promises
  } = {}
) {
  const normalizedSessionID = cleanIdentifier(sessionID);
  if (!normalizedSessionID || !sessionsRoot) return undefined;
  const suffix = `-${normalizedSessionID}.jsonl`;
  const pending = [path.resolve(sessionsRoot)];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let newest;

  while (pending.length > 0
      && visitedDirectories < maximumDirectories
      && visitedEntries < maximumEntries) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fileSystem.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirectories += 1;
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maximumEntries) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (pending.length + visitedDirectories < maximumDirectories) {
          pending.push(candidate);
        }
        continue;
      }
      if (!entry.isFile()
          || !entry.name.startsWith("rollout-")
          || !entry.name.endsWith(suffix)) {
        continue;
      }
      try {
        const stats = await fileSystem.stat(candidate);
        if (!newest || stats.mtimeMs > newest.modifiedAt) {
          newest = { path: candidate, modifiedAt: stats.mtimeMs };
        }
      } catch {
        // The writer may rotate a rollout while discovery is in progress.
      }
    }
  }
  return newest?.path;
}

async function readRolloutTail(
  filePath,
  { maximumBytes = DEFAULT_MAX_TAIL_BYTES, fileSystem = fs.promises } = {}
) {
  const handle = await fileSystem.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const contentStart = Math.max(0, stats.size - maximumBytes);
    const readStart = contentStart > 0 ? contentStart - 1 : 0;
    const length = stats.size - readStart;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, readStart);
    const hasLeadingProbe = readStart < contentStart && bytesRead > 0;
    const startedMidLine = hasLeadingProbe && buffer[0] !== 0x0a;
    const contentOffset = hasLeadingProbe ? 1 : 0;
    return {
      text: buffer.subarray(contentOffset, bytesRead).toString("utf8"),
      startedMidLine,
      size: stats.size,
      modifiedAt: stats.mtimeMs
    };
  } finally {
    await handle.close();
  }
}

export class ExternalApprovalSnapshotTracker {
  constructor({
    sessionsRoot = defaultCodexSessionsRoot(),
    discoveryRetryMs = DEFAULT_DISCOVERY_RETRY_MS,
    now = () => Date.now(),
    discover = discoverRolloutPath,
    stat = (filePath) => fs.promises.stat(filePath),
    readTail = readRolloutTail
  } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.discoveryRetryMs = discoveryRetryMs;
    this.now = now;
    this.discover = discover;
    this.stat = stat;
    this.readTail = readTail;
    this.entries = new Map();
  }

  async attach(sessions) {
    const pinnedIDs = new Set(sessions.map((session) => session.session_id));
    for (const sessionID of this.entries.keys()) {
      if (!pinnedIDs.has(sessionID)) this.entries.delete(sessionID);
    }

    const attached = [];
    for (const session of sessions) {
      const liveTurn = session?.live_turn;
      const liveTurnID = liveTurn?.is_active === true
        ? cleanIdentifier(liveTurn.turn_id)
        : undefined;
      if (!liveTurnID) {
        attached.push({ ...session, external_approval: null });
        continue;
      }

      const sessionID = cleanIdentifier(session.session_id);
      if (!sessionID) {
        attached.push({ ...session, external_approval: null });
        continue;
      }
      let entry = this.entries.get(sessionID) || {};
      if (!entry.rolloutPath && (entry.retryAt || 0) <= this.now()) {
        const rolloutPath = await this.discover(this.sessionsRoot, sessionID);
        entry = rolloutPath
          ? { rolloutPath }
          : { retryAt: this.now() + this.discoveryRetryMs };
      }

      let externalApproval;
      if (entry.rolloutPath) {
        try {
          const stats = await this.stat(entry.rolloutPath);
          if (entry.size === stats.size
              && entry.modifiedAt === stats.mtimeMs
              && entry.liveTurnID === liveTurnID) {
            externalApproval = entry.externalApproval;
          } else {
            const tail = await this.readTail(entry.rolloutPath);
            externalApproval = extractExternalApprovalFromRolloutText(
              tail.text,
              { liveTurnID, startedMidLine: tail.startedMidLine }
            );
            entry = {
              ...entry,
              size: tail.size,
              modifiedAt: tail.modifiedAt,
              liveTurnID,
              externalApproval
            };
          }
        } catch {
          // Rollout rotation or a transient read failure must not invent an
          // approval. Rediscover on the next bounded retry.
          entry = { retryAt: this.now() + this.discoveryRetryMs };
        }
      }
      this.entries.set(sessionID, entry);
      attached.push({
        ...session,
        external_approval: boundExternalApproval(externalApproval) || null
      });
    }
    return attached;
  }
}
