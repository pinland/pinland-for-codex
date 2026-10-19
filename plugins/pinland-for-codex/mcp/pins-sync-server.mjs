import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  attachRecentMessages,
  boundLiveCommentary,
  boundLiveProgress,
  boundLiveTurn,
  boundRecentMessages,
  recentTurnsListParams,
  truncateUTF8
} from "./recent-history.mjs";
import {
  attachCurrentTitles,
  CurrentTitleIndex
} from "./current-titles.mjs";
import {
  dispatchInstructionForAvailableHost,
  dispatchInstructionWithTemporaryOwner,
  InstructionOwnerCapacity
} from "./instruction-owner-lifecycle.mjs";
import { InstructionCommandLedger } from "./instruction-command-ledger.mjs";
import {
  DAEMON_PROTOCOL_VERSION,
  daemonLeaseDisposition
} from "./daemon-lease-policy.mjs";
import {
  boundExternalApproval,
  ExternalApprovalSnapshotTracker
} from "./external-approval.mjs";
import { LegacyHistoryTailTracker } from "./legacy-history-tail.mjs";
import {
  migrateLegacyPluginData,
  preparePluginDataDirectory,
  previousPluginDataDirectory,
  resolvePluginDataDirectory
} from "./plugin-data.mjs";
import { mirrorLegacyPluginLease } from "./plugin-data-lease.mjs";
import { NativePinSnapshotSyncState } from "./snapshot-sync-state.mjs";
import { SyncDiagnosticsReporter, syncFailureCode } from "./sync-diagnostics.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { CodexExecutableResolver } from "./codex-executable.mjs";
import { PluginUpdateSync, pluginIdentity } from "./plugin-update.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";
import { installedPluginForHandoff, startInstalledCompanion } from "./plugin-handoff.mjs";
import { AccountUsageSync } from "./account-usage.mjs";
import { DesktopQuestionBridge } from "./desktop-question-bridge.mjs";
import {
  desktopToolsPipeForInvocation,
  detachedDaemonEnvironment
} from "./daemon-runtime-policy.mjs";
import {
  dispatchInstructionWithDesktopIPC
} from "./codex-desktop-ipc-client.mjs";
import { createDirectInstructionServer } from "./direct-instruction-server.mjs";
import { CodexAppToolsChannel } from "./codex-app-tools-client.mjs";
import { DirectInstructionEndpointHost } from "./direct-instruction-endpoint-host.mjs";
import {
  DESKTOP_INSTRUCTION_PROVIDER_PORT,
  dispatchInstructionWithDesktopProvider
} from "./desktop-instruction-provider.mjs";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 53631;
const POLL_INTERVAL_MS = 900;
const FOLLOWER_RETRY_MS = 5_000;
const LEADER_HEARTBEAT_MS = 2_000;
const LEADER_STALE_MS = 15_000;
const DAEMON_HEARTBEAT_MS = 2_000;
const DAEMON_STALE_MS = 15_000;
const DAEMON_HOST_CHECK_MS = 20_000;
const DAEMON_HOST_EXIT_GRACE_MS = 120_000;
const DAEMON_CLI_IDLE_MS = 15 * 60_000;
const MAX_PINNED_SESSIONS = 256;
const MAX_CANONICAL_SESSIONS_BYTES = 850 * 1_024;
const MAX_BRIDGE_RESPONSE_BYTES = 64 * 1_024;
const BRIDGE_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invocationMode = process.argv[2] || "--mcp";
const serverPath = fileURLToPath(import.meta.url);
const runningPluginIdentity = pluginIdentity(path.resolve(path.dirname(serverPath), ".."));
const ownerToken = randomUUID();
const dataDir = resolvePluginDataDirectory();
const previousDataDir = previousPluginDataDirectory();
const tokenPath = path.join(dataDir, "bridge-token");
const pairedPath = path.join(dataDir, "paired");
const revisionPath = path.join(dataDir, "pins-revision");
const sourceIDPath = path.join(dataDir, "pins-source-id");
const leaderDir = path.join(dataDir, "native-pins-sync-leader");
const leaderOwnerPath = path.join(leaderDir, "owner.json");
const daemonDir = path.join(dataDir, "native-pins-sync-daemon");
const daemonOwnerPath = path.join(daemonDir, "owner.json");
const activityPath = path.join(dataDir, "native-pins-sync-activity");

preparePluginDataDirectory(dataDir);
migrateLegacyPluginData(dataDir);

let shuttingDown = false;
let retiringForUpgrade = false;
let isLeader = false;
let leaderHeartbeatTimer;
let followerTimer;
let daemonHeartbeatTimer;
let daemonHostTimer;
let ownsDaemonLease = false;
let syncLoopPromise;
let activeAppServer;
const codexExecutable = new CodexExecutableResolver();
const desktopQuestions = new DesktopQuestionBridge({ bridgeRequest });
let lastWakeAt = 0;
let daemonStartedAt = Date.now();
let lastDesktopSeenAt = 0;
let checkingDaemonHost = false;
let directInstructionEndpoint;
let directInstructionEndpointStart;
let desktopInstructionProviderHost;
let desktopInstructionProviderChannel;
const instructionOwnerCapacity = new InstructionOwnerCapacity(2);
const instructionOwnerClients = new Set();

function writeMCP(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function mcpResult(id, result) {
  writeMCP({ jsonrpc: "2.0", id, result });
}

function mcpError(id, code, message) {
  writeMCP({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMCPMessage(message) {
  if (!message || typeof message !== "object" || message.id === undefined) {
    return;
  }
  switch (message.method) {
    case "initialize":
      mcpResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pinland", version: "0.1.0" }
      });
      break;
    case "ping":
      mcpResult(message.id, {});
      break;
    case "tools/list":
      mcpResult(message.id, { tools: [] });
      break;
    case "resources/list":
      mcpResult(message.id, { resources: [] });
      break;
    case "prompts/list":
      mcpResult(message.id, { prompts: [] });
      break;
    default:
      mcpError(message.id, -32601, "Method not found");
  }
}

function startMCPEndpoint() {
  const mcpInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  mcpInput.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handleMCPMessage(JSON.parse(line));
    } catch {
      // Malformed host input must not terminate the companion.
    }
  });
  mcpInput.on("close", () => shutdown(0));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function fileAge(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function touchActivityMarker() {
  try {
    const descriptor = fs.openSync(activityPath, "a", 0o600);
    fs.closeSync(descriptor);
    const now = new Date();
    fs.utimesSync(activityPath, now, now);
  } catch {
    // Activity is only a lifetime hint; sync can still continue without it.
  }
}

function daemonOwnerIsHealthy(owner = readJSON(daemonOwnerPath)) {
  return daemonLeaseDisposition(owner, {
    pluginVersion: runningPluginIdentity.version,
    age: fileAge(daemonOwnerPath),
    staleMilliseconds: DAEMON_STALE_MS,
    processIsAlive
  }) === "keep";
}

function spawnDetachedDaemon() {
  touchActivityMarker();
  if (daemonOwnerIsHealthy()) return false;
  try {
    const child = spawn(process.execPath, [serverPath, "--daemon"], {
      detached: true,
      stdio: "ignore",
      env: detachedDaemonEnvironment()
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function repairStaleLease(directoryPath) {
  const stalePath = `${directoryPath}.stale.${ownerToken}`;
  try {
    fs.renameSync(directoryPath, stalePath);
  } catch {
    return false;
  }
  try {
    fs.rmSync(stalePath, { recursive: true, force: true });
  } catch {
    // The renamed lease can no longer block a new owner.
  }
  return true;
}

function acquireDaemonLease() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(daemonDir, { mode: 0o700 });
      fs.writeFileSync(daemonOwnerPath, JSON.stringify({
        protocol_version: DAEMON_PROTOCOL_VERSION,
        plugin_version: runningPluginIdentity.version,
        token: ownerToken,
        pid: process.pid,
        started_at_ms: daemonStartedAt
      }), { mode: 0o600 });
      ownsDaemonLease = true;
      mirrorLegacyPluginLease(dataDir, previousDataDir, "native-pins-sync-daemon");
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
    }

    const owner = readJSON(daemonOwnerPath);
    const disposition = daemonLeaseDisposition(owner, {
      pluginVersion: runningPluginIdentity.version,
      age: owner ? fileAge(daemonOwnerPath) : fileAge(daemonDir),
      staleMilliseconds: DAEMON_STALE_MS,
      processIsAlive
    });
    if (disposition === "keep" || disposition === "wait") return false;
    if (!repairStaleLease(daemonDir)) return false;
  }
  return false;
}

function releaseDaemonLease() {
  clearInterval(daemonHeartbeatTimer);
  daemonHeartbeatTimer = undefined;
  clearInterval(daemonHostTimer);
  daemonHostTimer = undefined;
  if (!ownsDaemonLease) return;
  ownsDaemonLease = false;
  if (readJSON(daemonOwnerPath)?.token !== ownerToken) return;
  try {
    fs.rmSync(daemonDir, { recursive: true, force: true });
  } catch {
    // A future process repairs the lease if this cleanup is interrupted.
  }
}

function codexDesktopIsRunning() {
  return new Promise((resolve) => {
    let output = "";
    let finished = false;
    let child;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // The process check may already have exited.
      }
      finish(false);
    }, 2_000);
    try {
      child = spawn("/bin/ps", ["-axo", "comm="], {
        stdio: ["ignore", "pipe", "ignore"]
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (output.length < 1_000_000) output += chunk;
      });
      child.on("error", () => finish(false));
      child.on("close", () => {
        const desktopExecutable = /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/;
        finish(output.split("\n").some((line) => desktopExecutable.test(line.trim())));
      });
    } catch {
      finish(false);
    }
  });
}

function activityTimestamp() {
  try {
    return fs.statSync(activityPath).mtimeMs;
  } catch {
    return daemonStartedAt;
  }
}

async function checkDaemonLifetime() {
  if (!ownsDaemonLease || checkingDaemonHost || shuttingDown) return;
  checkingDaemonHost = true;
  try {
    const now = Date.now();
    if (await codexDesktopIsRunning()) {
      lastDesktopSeenAt = now;
      return;
    }
    const mostRecentActivity = Math.max(activityTimestamp(), lastDesktopSeenAt, daemonStartedAt);
    const idleLimit = lastDesktopSeenAt > 0
      ? DAEMON_HOST_EXIT_GRACE_MS
      : DAEMON_CLI_IDLE_MS;
    if (now - mostRecentActivity > idleLimit) shutdown(0);
  } finally {
    checkingDaemonHost = false;
  }
}

function startDaemonLeaseHeartbeat() {
  daemonHeartbeatTimer = setInterval(() => {
    if (readJSON(daemonOwnerPath)?.token !== ownerToken) {
      retireForUpgrade();
      return;
    }
    try {
      const now = new Date();
      fs.utimesSync(daemonOwnerPath, now, now);
      mirrorLegacyPluginLease(dataDir, previousDataDir, "native-pins-sync-daemon");
    } catch {
      shutdown(0);
    }
  }, DAEMON_HEARTBEAT_MS);
  daemonHostTimer = setInterval(checkDaemonLifetime, DAEMON_HOST_CHECK_MS);
  checkDaemonLifetime();
}

function bridgeRequest(requestPath, token, body, timeout = 1_200) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request({
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: requestPath,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": payload.length
      }
    }, (response) => {
      const chunks = [];
      let byteCount = 0;
      response.on("data", (chunk) => {
        byteCount += chunk.length;
        if (byteCount > MAX_BRIDGE_RESPONSE_BYTES) {
          response.destroy();
          finish({ status: 0 });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        let json;
        if (responseBody) {
          try {
            json = JSON.parse(responseBody);
          } catch {
            // A malformed bridge body is treated as unavailable by callers.
          }
        }
        const rawEpoch = response.headers["x-pinland-bridge-epoch"];
        const bridgeEpoch = typeof rawEpoch === "string"
            && BRIDGE_EPOCH_PATTERN.test(rawEpoch)
          ? rawEpoch.toLowerCase()
          : undefined;
        const rawRecovery = response.headers["x-pinland-recovery-epoch"];
        const recoveryEpoch = typeof rawRecovery === "string" && BRIDGE_EPOCH_PATTERN.test(rawRecovery)
          ? rawRecovery.toLowerCase() : undefined;
        finish({ status: response.statusCode ?? 0, json, bridgeEpoch, recoveryEpoch });
      });
    });
    request.setTimeout(timeout, () => request.destroy());
    request.on("error", () => finish({ status: 0 }));
    request.end(payload);
  });
}

async function forwardApprovalToBridge(token, approval) {
  // Wake and authenticate Pinland before sending the one side-effectful
  // approval request. Replaying an approval after an uncertain socket failure
  // could create a second prompt for the same app-server request.
  let health = await bridgeRequest(
    "/v1/health",
    token,
    { schema_version: 1 },
    2_000
  );
  if (health.status === 0) {
    wakePinland();
    await sleep(700);
    health = await bridgeRequest(
      "/v1/health",
      token,
      { schema_version: 1 },
      2_000
    );
  }
  if (health.status === 401) clearPairedMarker();
  if (health.status !== 204) return health;

  const response = await bridgeRequest("/v1/approvals", token, approval, 0);
  if (response.status === 401) clearPairedMarker();
  return response;
}

async function dispatchDirectInstruction(command) {
  if (retiringForUpgrade || shuttingDown) return { accepted: false, error_code: "codex_unavailable" };
  // The ledger is an idempotency receipt, never an outbox: it contains no
  // prompt and cannot dispatch anything on its own. Every invocation below is
  // caused by exactly one live POST from the Pinland composer.
  const instructionLedger = new InstructionCommandLedger(dataDir);
  const token = readOrCreateBridgeToken();
  if (!token) return { accepted: false, error_code: "codex_unavailable" };
  // First steer through the task's exact Desktop owner. Some older idle tasks
  // remain loaded but do not answer owner discovery; route those through a
  // Codex-hosted cross-task tool channel before considering a new app-server
  // writer. Only a proven pre-delivery outage advances to the next route.
  const dispatch = await dispatchInstructionForAvailableHost(
    () => dispatchInstructionWithDesktopIPC(command, instructionLedger),
    () => dispatchInstructionWithDesktopProvider(
      command,
      token,
      instructionLedger
    ),
    () => dispatchInstructionWithTemporaryOwner(
      () => createAppServerClient(token, "pinland-instruction-owner"),
      command,
      instructionLedger,
      { ownerCapacity: instructionOwnerCapacity }
    )
  );
  if (dispatch.ownerClient && dispatch.releasePromise) {
    const ownerClient = dispatch.ownerClient;
    instructionOwnerClients.add(ownerClient);
    void Promise.resolve(dispatch.releasePromise)
      .catch(() => {})
      .finally(() => instructionOwnerClients.delete(ownerClient));
  }
  return dispatch.result;
}

function acquireDesktopInstructionProvider() {
  const pipePath = desktopToolsPipeForInvocation(invocationMode);
  if (!pipePath || shuttingDown) return Promise.resolve(false);

  if (!desktopInstructionProviderChannel) {
    desktopInstructionProviderChannel = new CodexAppToolsChannel(pipePath);
  }
  if (!desktopInstructionProviderHost) {
    const channel = desktopInstructionProviderChannel;
    desktopInstructionProviderHost = new DirectInstructionEndpointHost({
      warmHostChannel: () => channel.warm(),
      createEndpoint: () => createDirectInstructionServer({
        port: DESKTOP_INSTRUCTION_PROVIDER_PORT,
        tokenProvider: () => fs.existsSync(pairedPath)
          ? readOrCreateBridgeToken()
          : undefined,
        dispatch: (providerCommand) => channel.dispatch(providerCommand)
      })
    });
  }
  return desktopInstructionProviderHost.acquire();
}

function makeDirectInstructionEndpoint() {
  return createDirectInstructionServer({
    tokenProvider: () => fs.existsSync(pairedPath)
      ? readOrCreateBridgeToken()
      : undefined,
    dispatch: async (command) => {
      const token = readOrCreateBridgeToken();
      if (!token || !fs.existsSync(pairedPath)) {
        return { accepted: false, error_code: "codex_unavailable" };
      }
      return dispatchDirectInstruction(command);
    }
  });
}

function acquireDirectInstructionEndpoint() {
  if (directInstructionEndpoint) return Promise.resolve(true);
  if (directInstructionEndpointStart) return directInstructionEndpointStart;

  directInstructionEndpointStart = (async () => {
    const candidate = makeDirectInstructionEndpoint();
    try {
      await candidate.start({
        addressInUseRetryCount: 3,
        retryDelayMilliseconds: 250
      });
    } catch {
      await candidate.close().catch(() => {});
      return false;
    }
    if (shuttingDown) {
      await candidate.close().catch(() => {});
      return false;
    }
    directInstructionEndpoint = candidate;
    return true;
  })().finally(() => {
    directInstructionEndpointStart = undefined;
  });
  return directInstructionEndpointStart;
}

function readOrCreateBridgeToken() {
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (/^[a-fA-F0-9]{64}$/.test(existing)) return existing;
  } catch {
    // Create below.
  }
  const candidate = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(tokenPath, candidate, { flag: "wx", mode: 0o600 });
    return candidate;
  } catch {
    try {
      const winner = fs.readFileSync(tokenPath, "utf8").trim();
      return /^[a-fA-F0-9]{64}$/.test(winner) ? winner : undefined;
    } catch {
      return undefined;
    }
  }
}

async function ensurePaired() {
  const token = readOrCreateBridgeToken();
  if (!token) return undefined;
  if (fs.existsSync(pairedPath)) return token;
  const response = await bridgeRequest("/v1/pair", token, {});
  if (response.status !== 204) return undefined;
  try {
    fs.writeFileSync(pairedPath, "", { mode: 0o600 });
  } catch {
    return undefined;
  }
  return token;
}

function clearPairedMarker() {
  try {
    fs.unlinkSync(pairedPath);
  } catch {
    // Already disconnected.
  }
}

function wakePinland() {
  const now = Date.now();
  if (now - lastWakeAt < 15_000) return;
  lastWakeAt = now;
  try {
    const child = spawn("/usr/bin/open", ["-gj", "pinland://codex/wake"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // The next poll retries without disturbing Codex.
  }
}

function nextRevision() {
  let previous = 0;
  try {
    previous = Number.parseInt(fs.readFileSync(revisionPath, "utf8"), 10) || 0;
  } catch {
    // Start from the wall clock below.
  }
  const revision = Math.max(previous + 1, Date.now() * 1_000);
  const temporaryPath = `${revisionPath}.${ownerToken}.tmp`;
  fs.writeFileSync(temporaryPath, String(revision), { mode: 0o600 });
  fs.renameSync(temporaryPath, revisionPath);
  return revision;
}

function readOrCreateSourceID() {
  try {
    const existing = fs.readFileSync(sourceIDPath, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch {
    // Create below.
  }
  return rotateSourceID();
}

function rotateSourceID() {
  const sourceID = randomUUID();
  const temporaryPath = `${sourceIDPath}.${ownerToken}.tmp`;
  fs.writeFileSync(temporaryPath, sourceID, { mode: 0o600 });
  fs.renameSync(temporaryPath, sourceIDPath);
  return sourceID;
}

async function listAll(client, method, baseParams, maximumItems) {
  const values = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.request(method, { ...baseParams, cursor });
    if (!result || !Array.isArray(result.data)) {
      throw new Error(`${method} returned an invalid page`);
    }
    values.push(...result.data);
    if (values.length > maximumItems) {
      throw new Error(`${method} exceeded the supported snapshot size`);
    }
    cursor = result.nextCursor;
    if (!cursor) return values;
  }
  throw new Error(`${method} pagination did not complete`);
}

function boundedPinnedSessions(sessions) {
  let titleBytes = 4_096;
  let workingDirectoryBytes = 8_192;
  let recentMessageBytes = 4_000;
  let recentMessageCount = 5;
  let liveCommentaryBytes = 4_000;
  let liveProgressItemCount = 64;
  let liveProgressBytes = 64 * 1_024;
  while (true) {
    const bounded = sessions.map((session) => {
      const boundedSession = {
        ...session,
        title: truncateUTF8(session.title, titleBytes),
        working_directory: truncateUTF8(
          session.working_directory,
          workingDirectoryBytes
        ),
        live_commentary: boundLiveCommentary(session.live_commentary, {
          maxTextBytes: liveCommentaryBytes
        }) || null,
        live_progress: boundLiveProgress(session.live_progress, {
          maxItems: liveProgressItemCount,
          maxTextBytes: liveCommentaryBytes,
          maxSessionBytes: liveProgressBytes
        }),
        live_turn: boundLiveTurn(session.live_turn) || null,
        external_approval: boundExternalApproval(session.external_approval) || null
      };
      if (Object.prototype.hasOwnProperty.call(session, "recent_messages")
          && recentMessageCount > 0) {
        boundedSession.recent_messages = boundRecentMessages(
          session.recent_messages,
          {
            maxMessages: recentMessageCount,
            maxMessageBytes: recentMessageBytes,
            maxSessionBytes: recentMessageCount * recentMessageBytes
          }
        );
      } else {
        // Transport-level omission means "keep the app's last good history".
        // Never turn an unavailable or size-elided transcript into the
        // protocol's authoritative empty-array clear signal.
        delete boundedSession.recent_messages;
      }
      return boundedSession;
    });
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8")
        <= MAX_CANONICAL_SESSIONS_BYTES) {
      return bounded;
    }
    // Live progress is transient and can be fetched again on the next poll;
    // compress it before the saved user/final-answer transcript.
    if (liveProgressBytes > 1_024) {
      liveProgressBytes = Math.max(1_024, Math.floor(liveProgressBytes / 2));
      continue;
    }
    if (liveProgressItemCount > 1) {
      liveProgressItemCount = Math.max(1, Math.floor(liveProgressItemCount / 2));
      continue;
    }
    if (liveCommentaryBytes > 64) {
      liveCommentaryBytes = Math.max(64, Math.floor(liveCommentaryBytes / 2));
      continue;
    }
    if (recentMessageBytes > 64) {
      recentMessageBytes = Math.max(64, Math.floor(recentMessageBytes / 2));
      continue;
    }
    if (recentMessageCount > 0) {
      recentMessageCount -= 1;
      continue;
    }
    if (titleBytes === 64 && workingDirectoryBytes === 128) {
      // 256 IDs plus these minimum byte caps remain far below the bridge's
      // 1 MiB parser limit, even when every character needs JSON escaping.
      return bounded;
    }
    titleBytes = Math.max(64, Math.floor(titleBytes / 2));
    workingDirectoryBytes = Math.max(128, Math.floor(workingDirectoryBytes / 2));
  }
}

async function readPinnedSessions(
  client,
  recentMessagesCache,
  currentTitlesCache,
  currentTitleIndex,
  legacyHistoryTracker,
  externalApprovalTracker
) {
  if (!client.pinnedSectionID) {
    const sections = await listAll(client, "threadSection/list", { limit: 100 }, 500);
    const pinnedSection = sections.find(
      (section) => typeof section?.name === "string"
        && section.name.localeCompare("Pinned", undefined, { sensitivity: "accent" }) === 0
    );
    if (!pinnedSection || typeof pinnedSection.id !== "string") {
      throw new Error("Codex Pinned section is unavailable");
    }
    client.pinnedSectionID = pinnedSection.id;
  }
  const threads = await listAll(client, "thread/list", {
    limit: 100,
    archived: false,
    sectionId: client.pinnedSectionID,
    sortKey: "section_position",
    sortDirection: "asc",
    useStateDbOnly: true
  }, MAX_PINNED_SESSIONS);

  const historyModes = new Map();
  const sessions = threads.map((thread) => {
    if (!thread || typeof thread.id !== "string") {
      throw new Error("Codex returned a pinned task without an id");
    }
    const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
    const explicitName = typeof thread.name === "string" ? thread.name.trim() : "";
    const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
    const fallbackName = cwd ? path.basename(cwd) : "Codex Task";
    const updatedAtSeconds = Number.isFinite(thread.updatedAt) ? thread.updatedAt : undefined;
    const sectionEnteredAtSeconds = Number.isFinite(thread.sectionEnteredAt)
      ? thread.sectionEnteredAt
      : undefined;
    if (thread.historyMode === "paginated" || thread.historyMode === "legacy") {
      historyModes.set(thread.id, thread.historyMode);
    }
    return {
      session_id: thread.id,
      title: (explicitName || preview || fallbackName).slice(0, 4_096),
      title_is_authoritative: Boolean(explicitName),
      working_directory: cwd.slice(0, 8_192),
      model: "",
      // Internal-only. This comes from the cheap state database-backed list
      // and prevents legacy metadata churn from bypassing history throttling.
      runtime_is_active: thread?.status?.type === "active",
      updated_at_ms: updatedAtSeconds === undefined
        ? undefined
        : Math.trunc(updatedAtSeconds * 1_000),
      // Codex updates this generation whenever a task re-enters Pinned. It
      // lets Pinland distinguish a deliberate re-pin from an older local hide
      // even when the companion missed the brief unpinned snapshot.
      section_entered_at: sectionEnteredAtSeconds === undefined
        ? undefined
        : Math.trunc(sectionEnteredAtSeconds)
    };
  });
  const indexedCurrentTitles = await currentTitleIndex.titlesFor(
    sessions,
    (cursor) => client.request("thread/list", {
      limit: 100,
      cursor,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true
    })
  );
  // A section-filtered thread/list response currently leaves `name` null and
  // exposes only the immutable initial prompt in `preview`. Resolve the task's
  // user-assigned current name from thread/read, with a bounded update-key
  // cache so active tasks do not generate a read on every poll.
  const sessionsWithCurrentTitles = await attachCurrentTitles(
    sessions,
    currentTitlesCache,
    (threadID) => client.request("thread/read", {
      threadId: threadID,
      includeTurns: false
    }),
    { currentNames: indexedCurrentTitles }
  );
  const sessionsWithHistory = await attachRecentMessages(
    sessionsWithCurrentTitles,
    recentMessagesCache,
    (threadID, params = recentTurnsListParams(threadID)) => client.request(
      "thread/turns/list",
      params
    ),
    {
      historyModeForSession: (threadID) => historyModes.get(threadID),
      // Legacy history is deliberately maintained by Pinland's bounded local
      // cache plus lifecycle hooks. Asking app-server for even a five-turn
      // summary makes it parse the entire old rollout on every daemon start.
      skipLegacyHistory: true,
      fetchItems: (threadID, params) => client.request(
        "thread/items/list",
        params
      )
    }
  );
  const sessionsWithLegacyHistory = await legacyHistoryTracker.attach(
    sessionsWithHistory,
    (threadID) => historyModes.get(threadID)
  );
  const sessionsWithExternalApprovals = await externalApprovalTracker.attach(
    sessionsWithLegacyHistory
  );
  return boundedPinnedSessions(sessionsWithExternalApprovals);
}

async function createAppServerClient(token, clientName = "pinland") {
  const executable = await codexExecutable.resolve();
  if (!executable) throw new Error("Codex executable is unavailable");
  const client = new CodexAppServerClient(
    executable,
    (approval) => forwardApprovalToBridge(token, approval),
    { clientName }
  );
  try {
    await client.start();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function runSyncLoop() {
  let sourceID = readOrCreateSourceID();
  let restartDelay = 1_000;
  const recentMessagesCache = new Map();
  const currentTitlesCache = new Map();
  const currentTitleIndex = new CurrentTitleIndex();
  const legacyHistoryTracker = new LegacyHistoryTailTracker();
  const externalApprovalTracker = new ExternalApprovalSnapshotTracker();
  const snapshotSyncState = new NativePinSnapshotSyncState(nextRevision);
  const ownsSync = () => isLeader && !shuttingDown && currentLeaderOwner()?.token === ownerToken;
  const producer = { runtime_id: ownerToken, plugin_version: runningPluginIdentity.version };
  const syncRequest = (route, token, body) => ownsSync()
    ? bridgeRequest(route, token, { ...body, ...producer }) : Promise.resolve({ status: 409 });
  const diagnostics = new SyncDiagnosticsReporter(syncRequest);
  const accountUsage = new AccountUsageSync();
  const pluginUpdate = new PluginUpdateSync({ identity: runningPluginIdentity,
    protocolVersion: DAEMON_PROTOCOL_VERSION, runtimeID: ownerToken, isOwner: ownsSync,
    hasOwnedTasks: () => instructionOwnerCapacity.activeCount > 0,
    installedForHandoff: installedPluginForHandoff, startCompanion: startInstalledCompanion,
    journal: new PluginUpdateJournal(path.join(dataDir, "plugin-update-state.json")) });
  pluginUpdate.setHost(codexExecutable.report("discovering"));
  let acknowledgedRevision;
  let pairedToken;
  let recoveryEpoch;
  while (ownsSync()) {
    try {
      const token = await ensurePaired();
      if (!token) {
        desktopQuestions.close();
        pairedToken = undefined;
        await sleep(2_000);
        continue;
      }
      pairedToken = token;
      const bridgeObservation = await bridgeRequest("/v1/health", token, {});
      if (bridgeObservation.recoveryEpoch && recoveryEpoch !== bridgeObservation.recoveryEpoch) {
        codexExecutable.reset();
        if (recoveryEpoch) {
          // Only the read-only sync client is rebuilt. Never restart Codex,
          // instruction owners, or replay a user's in-flight message.
          await activeAppServer?.close();
          activeAppServer = undefined;
        }
        recoveryEpoch = bridgeObservation.recoveryEpoch;
      }
      const reportEpoch = recoveryEpoch || bridgeObservation.bridgeEpoch;
      if (!activeAppServer || activeAppServer.closed) {
        await pluginUpdate.refresh(undefined, bridgeRequest, token, reportEpoch);
        codexExecutable.setApplicationPath(pluginUpdate.target?.codex_app_path);
        activeAppServer = await createAppServerClient(token);
        pluginUpdate.setHost(codexExecutable.report("ready"));
        restartDelay = 1_000;
      }

      if (bridgeObservation.status === 204) {
        pluginUpdate.refresh(activeAppServer, bridgeRequest, token, reportEpoch);
        accountUsage.refresh(activeAppServer, syncRequest, token, reportEpoch);
      }
      diagnostics.observeBridge(bridgeObservation.bridgeEpoch);
      snapshotSyncState.observeBridge(
        bridgeObservation.status,
        bridgeObservation.bridgeEpoch
      );
      const sessions = await readPinnedSessions(
        activeAppServer,
        recentMessagesCache,
        currentTitlesCache,
        currentTitleIndex,
        legacyHistoryTracker,
        externalApprovalTracker
      );
      if (!ownsSync()) break; // An old in-flight read must not publish after takeover.
      const canonical = JSON.stringify(sessions);
      const hash = createHash("sha256").update(canonical).digest("hex");
      const pendingSnapshot = snapshotSyncState.snapshotFor(
        hash,
        sourceID,
        sessions
      );
      if (pendingSnapshot) {
        let response = await syncRequest(
          "/v1/pins/snapshot",
          token,
          pendingSnapshot.body
        );
        snapshotSyncState.observeBridge(response.status, response.bridgeEpoch);
        if (response.status === 0) {
          wakePinland();
          await sleep(700);
          response = await syncRequest(
            "/v1/pins/snapshot",
            token,
            pendingSnapshot.body
          );
          snapshotSyncState.observeBridge(response.status, response.bridgeEpoch);
        }
        if (response.status === 204) {
          snapshotSyncState.acknowledge(hash);
          acknowledgedRevision = pendingSnapshot.body.revision;
        } else if (response.status === 401) {
          clearPairedMarker();
        } else if (response.status === 409) {
          // A partial plugin-data restore can leave Pinland with a newer
          // revision. Rotate producer identity so the next complete snapshot
          // recovers automatically instead of replaying one stale body.
          sourceID = rotateSourceID();
          acknowledgedRevision = undefined;
          snapshotSyncState.rejectAsStale();
        } else if (response.status >= 400) {
          await diagnostics.report(token, sourceID, { failure: "snapshot_rejected" });
        }
      }
      if (!snapshotSyncState.pendingSnapshot && acknowledgedRevision !== undefined) {
        const status = await diagnostics.report(token, sourceID, { revision: acknowledgedRevision });
        if (status === 409) snapshotSyncState.rejectAsStale();
      }
      if (bridgeObservation.status === 204 && !snapshotSyncState.pendingSnapshot) {
        void desktopQuestions.update(sessions.map(session => session.session_id), token, bridgeObservation.bridgeEpoch);
      } else {
        desktopQuestions.close();
      }
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      desktopQuestions.close();
      if (pairedToken) {
        if (!activeAppServer || activeAppServer.closed) {
          pluginUpdate.setHost(codexExecutable.report(error.message === "Codex executable is unavailable"
            ? "executable_missing" : "start_failed"));
          await pluginUpdate.refresh(undefined, bridgeRequest, pairedToken, recoveryEpoch);
        }
        await diagnostics.report(pairedToken, sourceID, { failure: syncFailureCode(error) });
      }
      await activeAppServer?.close();
      activeAppServer = undefined;
      await sleep(restartDelay);
      restartDelay = Math.min(restartDelay * 2, 15_000);
    }
  }
}

function currentLeaderOwner() {
  return readJSON(leaderOwnerPath);
}

function acquireLeadership() {
  if (shuttingDown || retiringForUpgrade || isLeader) return;
  try {
    fs.mkdirSync(leaderDir, { mode: 0o700 });
    fs.writeFileSync(
      leaderOwnerPath,
      JSON.stringify({
        protocol_version: DAEMON_PROTOCOL_VERSION,
        plugin_version: runningPluginIdentity.version,
        token: ownerToken,
        pid: process.pid
      }),
      { mode: 0o600 }
    );
  } catch (error) {
    if (error?.code !== "EEXIST") return;
    try {
      const owner = currentLeaderOwner();
      const disposition = daemonLeaseDisposition(owner, {
        pluginVersion: runningPluginIdentity.version,
        age: owner ? fileAge(leaderOwnerPath) : fileAge(leaderDir),
        staleMilliseconds: LEADER_STALE_MS,
        processIsAlive
      });
      if (disposition !== "replace") return;
      if (!repairStaleLease(leaderDir)) return;
      acquireLeadership();
    } catch {
      // Another instance repaired or acquired the lease first.
    }
    return;
  }

  isLeader = true;
  mirrorLegacyPluginLease(dataDir, previousDataDir, "native-pins-sync-leader");
  leaderHeartbeatTimer = setInterval(() => {
    const owner = currentLeaderOwner();
    if (owner?.token !== ownerToken) {
      releaseLeadership(false);
      return;
    }
    try {
      const now = new Date();
      fs.utimesSync(leaderOwnerPath, now, now);
      mirrorLegacyPluginLease(dataDir, previousDataDir, "native-pins-sync-leader");
    } catch {
      releaseLeadership(false);
    }
  }, LEADER_HEARTBEAT_MS);
  syncLoopPromise = runSyncLoop();
}

function startFollowerMaintenance({
  maintainInstructionEndpoint = false,
  maintainDesktopProvider = false
} = {}) {
  const maintain = () => {
    acquireLeadership();
    if (maintainInstructionEndpoint) void acquireDirectInstructionEndpoint();
    if (maintainDesktopProvider) void acquireDesktopInstructionProvider();
  };
  maintain();
  followerTimer = setInterval(maintain, FOLLOWER_RETRY_MS);
}

function releaseLeadership(removeLease = true) {
  if (!isLeader) return Promise.resolve();
  isLeader = false;
  desktopQuestions.close();
  clearInterval(leaderHeartbeatTimer);
  leaderHeartbeatTimer = undefined;
  const closingClients = [];
  if (activeAppServer) closingClients.push(activeAppServer.close());
  activeAppServer = undefined;
  if (removeLease && currentLeaderOwner()?.token === ownerToken) {
    try {
      fs.rmSync(leaderDir, { recursive: true, force: true });
    } catch {
      // A follower will repair a stale lease if needed.
    }
  }
  return Promise.allSettled(closingClients);
}

function retireForUpgrade() {
  if (retiringForUpgrade || shuttingDown) return;
  retiringForUpgrade = true;
  clearInterval(followerTimer);
  void releaseLeadership(false);
  releaseDaemonLease();
  // Stop accepting new instructions, but preserve any app-server that owns an
  // already submitted headless turn until its normal terminal notification.
  void directInstructionEndpoint?.close().catch(() => {});
  const finish = () => {
    if (instructionOwnerCapacity.activeCount > 0 || instructionOwnerClients.size > 0) return;
    clearInterval(drain);
    shutdown(0);
  };
  const drain = setInterval(finish, 250);
  finish();
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(followerTimer);
  const closePromise = releaseLeadership(true);
  const endpoint = directInstructionEndpoint;
  const endpointStart = directInstructionEndpointStart;
  const closeDirectInstructionEndpoint = Promise.resolve(endpointStart)
    .catch(() => {})
    .then(() => endpoint?.close())
    .catch(() => {});
  directInstructionEndpoint = undefined;
  directInstructionEndpointStart = undefined;
  const closeInstructionOwners = Promise.allSettled(
    [...instructionOwnerClients].map((client) => client.close())
  );
  instructionOwnerClients.clear();
  const providerHost = desktopInstructionProviderHost;
  const providerChannel = desktopInstructionProviderChannel;
  desktopInstructionProviderHost = undefined;
  desktopInstructionProviderChannel = undefined;
  const closeDesktopInstructionProvider = Promise.resolve(
    providerHost?.close()
  ).catch(() => {}).finally(() => providerChannel?.close());
  releaseDaemonLease();
  Promise.allSettled([
    Promise.resolve(syncLoopPromise),
    closePromise,
    closeDirectInstructionEndpoint,
    closeInstructionOwners,
    closeDesktopInstructionProvider
  ])
    .finally(() => process.exit(exitCode));
  // close() first asks the child to exit, then escalates through SIGTERM and
  // SIGKILL. Keep the daemon alive long enough for both bounded grace periods.
  setTimeout(() => process.exit(exitCode), 2_500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", () => shutdown(1));
process.on("unhandledRejection", () => {
  // Keep the MCP endpoint alive; the sync loop owns its own retry policy.
});

async function startDaemon() {
  if (!acquireDaemonLease()) {
    // A winner may have completed atomic mkdir but not owner.json yet. Wait
    // once for that tiny window; a healthy established owner exits promptly.
    if (daemonOwnerIsHealthy()) return;
    await sleep(DAEMON_STALE_MS + 250);
    if (!acquireDaemonLease()) return;
  }
  // The detached daemon permanently owns Pinland's public composer listener.
  // Each request first follows Codex Desktop's registered task owner, then a
  // Codex-hosted cross-task provider, and finally one temporary app-server
  // only when both Desktop routes prove they received nothing. No route
  // persists prompts or retries them in the background.
  startDaemonLeaseHeartbeat();
  await acquireDirectInstructionEndpoint();
  startFollowerMaintenance({ maintainInstructionEndpoint: true });
}

async function main() {
  switch (invocationMode) {
    case "--migrate-data":
      // Directory preparation and legacy migration run before main(). This
      // short-lived mode lets the hook preserve an existing pairing before it
      // considers creating a fresh bridge token in the new persistent path.
      return;
    case "--ensure-daemon":
      spawnDetachedDaemon();
      return;
    case "--daemon":
      await startDaemon();
      return;
    case "--mcp":
      // The detached daemon owns pin syncing and the stable public composer
      // listener. This stdio endpoint remains intentionally tool-free.
      spawnDetachedDaemon();
      startMCPEndpoint();
      startFollowerMaintenance({ maintainDesktopProvider: true });
      return;
    default:
      process.stderr.write("Unknown Pinland native pin sync mode.\n");
      process.exitCode = 64;
  }
}

main().catch(() => shutdown(1));
