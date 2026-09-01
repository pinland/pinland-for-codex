const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_PROMPT_BYTES = 16_000;
const MAX_APPROVAL_SUMMARY_CHARACTERS = 4_000;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedApprovalSummary(value, fallback) {
  const summary = nonemptyString(value) || fallback;
  return Array.from(summary).slice(0, MAX_APPROVAL_SUMMARY_CHARACTERS).join("");
}

function approvalIdentity(params, legacy = false) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const sessionID = nonemptyString(legacy ? params.conversationId : params.threadId);
  if (!sessionID || Array.from(sessionID).length > 256) return undefined;
  const rawTurnID = legacy ? undefined : params.turnId;
  const turnID = rawTurnID === undefined || rawTurnID === null
    ? undefined
    : nonemptyString(rawTurnID);
  if ((rawTurnID !== undefined && rawTurnID !== null && !turnID)
      || (turnID && Array.from(turnID).length > 256)) {
    return undefined;
  }
  return { sessionID, turnID };
}

function approvalBridgePayload(identity, kind, toolName, summary) {
  return {
    schema_version: 1,
    session_id: identity.sessionID,
    ...(identity.turnID ? { turn_id: identity.turnID } : {}),
    kind,
    tool_name: toolName,
    summary
  };
}

function permissionSummary(params) {
  const permissionProfile = params?.permissions;
  const hasNetwork = permissionProfile?.network?.enabled === true;
  const fileSystem = permissionProfile?.fileSystem;
  const hasFileSystem = fileSystem && typeof fileSystem === "object"
    && (Array.isArray(fileSystem.read)
      || Array.isArray(fileSystem.write)
      || Array.isArray(fileSystem.entries));
  if (hasNetwork && hasFileSystem) return "Grant network and file access";
  if (hasNetwork) return "Grant network access";
  if (hasFileSystem) return "Grant file access";
  return "Grant requested permissions";
}

function computerUseElicitation(message) {
  if (message?.method !== "mcpServer/elicitation/request") return undefined;
  const params = message.params;
  const identity = approvalIdentity(params);
  if (!identity) return undefined;

  const serverName = nonemptyString(params?.serverName);
  if (serverName !== "node_repl") return undefined;
  if (params.mode !== "form" && params.mode !== "openai/form") return undefined;

  const schema = params.requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
      || schema.type !== "object") {
    return undefined;
  }
  if (!schema.properties
      || typeof schema.properties !== "object"
      || Array.isArray(schema.properties)
      || Object.keys(schema.properties).length !== 0) {
    return undefined;
  }
  if (schema.required !== undefined
      && (!Array.isArray(schema.required) || schema.required.length !== 0)) {
    return undefined;
  }

  const metadata = params._meta;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || metadata.codex_approval_kind !== "mcp_tool_call"
      || metadata.connector_id !== "computer-use"
      || !Array.isArray(metadata.persist)
      || !metadata.persist.includes("session")) {
    return undefined;
  }
  const connectorName = nonemptyString(metadata.connector_name);
  const operationName = nonemptyString(metadata.tool_name);
  if (connectorName !== "Computer Use" || !operationName
      || Array.from(operationName).length > 128) {
    return undefined;
  }

  return {
    identity,
    toolName: connectorName,
    summary: boundedApprovalSummary(
      nonemptyString(params.message),
      `Allow ${connectorName} to perform ${operationName}`
    )
  };
}

/**
 * Converts an app-server approval callback into the small, bounded protocol
 * understood by Pinland's loopback bridge. Returning undefined keeps unrelated
 * server requests on the existing fail-closed path.
 */
export function normalizeApprovalRequest(message) {
  const params = message?.params;
  switch (message?.method) {
    case "item/commandExecution/requestApproval": {
      const identity = approvalIdentity(params);
      if (!identity) return undefined;
      const networkContext = params.networkApprovalContext;
      const networkSummary = nonemptyString(networkContext?.host)
        ? `Connect to ${networkContext.host}`
        : undefined;
      return approvalBridgePayload(
        identity,
        "command",
        "Bash",
        boundedApprovalSummary(
          nonemptyString(params.reason)
            || networkSummary
            || nonemptyString(params.command),
          "Run a command"
        )
      );
    }
    case "item/fileChange/requestApproval": {
      const identity = approvalIdentity(params);
      if (!identity) return undefined;
      const rootSummary = nonemptyString(params.grantRoot)
        ? `Allow file changes under ${params.grantRoot}`
        : undefined;
      return approvalBridgePayload(
        identity,
        "file_change",
        "apply_patch",
        boundedApprovalSummary(
          nonemptyString(params.reason) || rootSummary,
          "Apply file changes"
        )
      );
    }
    case "item/permissions/requestApproval": {
      const identity = approvalIdentity(params);
      if (!identity
          || !params.permissions
          || typeof params.permissions !== "object"
          || Array.isArray(params.permissions)) {
        return undefined;
      }
      return approvalBridgePayload(
        identity,
        "permissions",
        "request_permissions",
        boundedApprovalSummary(nonemptyString(params.reason), permissionSummary(params))
      );
    }
    case "mcpServer/elicitation/request": {
      const elicitation = computerUseElicitation(message);
      if (!elicitation) return undefined;
      return approvalBridgePayload(
        elicitation.identity,
        "computer_use",
        elicitation.toolName,
        elicitation.summary
      );
    }
    case "execCommandApproval": {
      const identity = approvalIdentity(params, true);
      if (!identity) return undefined;
      const command = Array.isArray(params.command)
        ? params.command.filter((part) => typeof part === "string").join(" ")
        : undefined;
      return approvalBridgePayload(
        identity,
        "command",
        "Bash",
        boundedApprovalSummary(
          nonemptyString(params.reason) || nonemptyString(command),
          "Run a command"
        )
      );
    }
    case "applyPatchApproval": {
      const identity = approvalIdentity(params, true);
      if (!identity) return undefined;
      const fileCount = params.fileChanges && typeof params.fileChanges === "object"
        && !Array.isArray(params.fileChanges)
        ? Object.keys(params.fileChanges).length
        : 0;
      const fileSummary = fileCount > 0
        ? `Apply changes to ${fileCount} ${fileCount === 1 ? "file" : "files"}`
        : undefined;
      return approvalBridgePayload(
        identity,
        "file_change",
        "apply_patch",
        boundedApprovalSummary(
          nonemptyString(params.reason) || fileSummary,
          "Apply file changes"
        )
      );
    }
    default:
      return undefined;
  }
}

export function normalizeApprovalDecision(response) {
  if (response?.status !== 200
      || response?.json?.schema_version !== 1
      || (response.json.decision !== "allow" && response.json.decision !== "deny")) {
    return undefined;
  }
  return response.json.decision;
}

/**
 * Maps Pinland's intentionally tiny allow/deny vocabulary back to the exact
 * response shape expected by the app-server request that is still pending on
 * this connection.
 */
export function approvalServerRequestReply(message, decision) {
  if (decision !== "allow" && decision !== "deny") return undefined;
  const base = { id: message?.id };
  switch (message?.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return {
        ...base,
        result: { decision: decision === "allow" ? "accept" : "decline" }
      };
    case "item/permissions/requestApproval": {
      const permissions = message?.params?.permissions;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
        return undefined;
      }
      return {
        ...base,
        result: {
          permissions: decision === "allow" ? permissions : {},
          scope: "turn"
        }
      };
    }
    case "mcpServer/elicitation/request": {
      if (!computerUseElicitation(message)) return undefined;
      return {
        ...base,
        result: decision === "allow"
          ? {
              action: "accept",
              content: {},
              _meta: { persist: "session" }
            }
          : { action: "decline", content: null, _meta: null }
      };
    }
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        ...base,
        result: {
          decision: decision === "allow"
            ? "approved"
            : { denied: { rejection: "Denied in Pinland." } }
        }
      };
    default:
      return undefined;
  }
}

/**
 * Starts an approval bridge round trip without awaiting it. The boolean return
 * tells the caller whether this was a supported approval; all completion and
 * failure replies are delivered later through writeReply.
 */
export function scheduleApprovalServerRequestReply(
  message,
  approvalRequestHandler,
  writeReply
) {
  const approval = normalizeApprovalRequest(message);
  if (!approval
      || typeof approvalRequestHandler !== "function"
      || typeof writeReply !== "function") {
    return false;
  }
  Promise.resolve()
    .then(() => approvalRequestHandler(approval))
    .then((response) => {
      const decision = normalizeApprovalDecision(response);
      writeReply(
        approvalServerRequestReply(message, decision)
          || fallbackServerRequestReply(message)
      );
    })
    .catch(() => writeReply(fallbackServerRequestReply(message)));
  return true;
}

export function extractInstructionCommandID(value) {
  const commandID = typeof value?.command_id === "string"
    ? value.command_id.trim()
    : "";
  return COMMAND_ID_PATTERN.test(commandID) ? commandID : undefined;
}

export function normalizeInstructionCommand(value) {
  if (!value || typeof value !== "object" || value.schema_version !== 1) {
    return undefined;
  }
  const commandID = typeof value.command_id === "string"
    ? value.command_id.trim()
    : "";
  const sessionID = typeof value.session_id === "string"
    ? value.session_id.trim()
    : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!COMMAND_ID_PATTERN.test(commandID)
      || !/^[\p{L}\p{N}_.:-]{1,256}$/u.test(sessionID)
      || !prompt
      || Array.from(prompt).length > MAX_PROMPT_CHARACTERS
      || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    return undefined;
  }
  return {
    schema_version: 1,
    command_id: commandID,
    session_id: sessionID,
    prompt
  };
}

export function instructionTurnStartParams(command) {
  return {
    threadId: command.session_id,
    clientUserMessageId: command.command_id,
    input: [{ type: "text", text: command.prompt, text_elements: [] }],
    turnTrigger: "pinland"
  };
}

export function isActiveWriterConflict(error) {
  const message = typeof error?.message === "string"
    ? error.message.toLowerCase()
    : "";
  return message.includes("active writer")
    || message.includes("thread-store conflict");
}

export function instructionFailureCode(error) {
  const message = typeof error?.message === "string"
    ? error.message.toLowerCase()
    : "";
  if (isActiveWriterConflict(error)) return "thread_active";
  if (message.includes("thread")
      && (message.includes("not found")
        || message.includes("unknown")
        || message.includes("unavailable"))) {
    return "thread_unavailable";
  }
  if (message.includes("no rollout found")) return "thread_unavailable";
  if (message.includes("timed out")
      || message.includes("app-server")
      || message.includes("closed")
      || message.includes("exited")) {
    return "codex_unavailable";
  }
  return "request_failed";
}

export function turnStartFailureCode(error) {
  // A numbered JSON-RPC error proves that app-server received and rejected the
  // request. Any rejection without such a response is outcome-unknown: even a
  // local stream error can happen after bytes were accepted by the subprocess.
  if (Number.isFinite(error?.code)) return instructionFailureCode(error);
  return "delivery_uncertain";
}

export function resumedThreadFailureCode(result) {
  const status = result?.thread?.status?.type;
  if (status === "idle") return undefined;
  if (status === "active") return "thread_active";
  return "thread_unavailable";
}

export function fallbackServerRequestReply(message) {
  const base = { id: message.id };
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { ...base, result: { decision: "decline" } };
    case "item/permissions/requestApproval":
      return {
        ...base,
        result: { permissions: {}, scope: "turn" }
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        ...base,
        result: {
          decision: {
            denied: { rejection: "Open Codex to review this interactive request." }
          }
        }
      };
    case "item/tool/requestUserInput":
      return { ...base, result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return {
        ...base,
        result: { action: "decline", content: null, _meta: null }
      };
    case "currentTime/read":
      return {
        ...base,
        result: { currentTimeAt: Math.floor(Date.now() / 1_000) }
      };
    default:
      return {
        ...base,
        error: {
          code: -32_601,
          message: "Open Codex to complete this interactive request."
        }
      };
  }
}

export async function resumeInstructionThread(client, command, lifecycle = {}) {
  let resumeResult;
  try {
    resumeResult = await client.request(
      "thread/resume",
      { threadId: command.session_id, excludeTurns: true },
      12_000
    );
  } catch (error) {
    return { accepted: false, error_code: instructionFailureCode(error) };
  }

  const resumeFailure = resumedThreadFailureCode(resumeResult);
  if (resumeFailure) {
    return { accepted: false, error_code: resumeFailure };
  }
  lifecycle.onWriterAcquired?.(resumeResult);

  return { accepted: true };
}

export async function startInstructionTurn(client, command, lifecycle = {}) {
  try {
    const startResult = await client.request(
      "turn/start",
      instructionTurnStartParams(command),
      12_000
    );
    lifecycle.onTurnStarted?.(startResult);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error_code: turnStartFailureCode(error) };
  }
}

export async function dispatchInstruction(client, command, lifecycle = {}) {
  const resumeResult = await resumeInstructionThread(client, command, lifecycle);
  if (!resumeResult.accepted) return resumeResult;
  return startInstructionTurn(client, command, lifecycle);
}

export async function dispatchReservedInstruction(
  client,
  command,
  ledger,
  lifecycle = {},
  dispatcher = dispatchInstruction
) {
  const result = await dispatcher(client, command, lifecycle);
  try {
    ledger.recordResult(command.command_id, result);
    return result;
  } catch {
    // Dispatching is already durable. If persisting the final result fails,
    // never invite a replay whose original turn may already have started.
    if (result.accepted || result.error_code === "delivery_uncertain") {
      return { accepted: false, error_code: "delivery_uncertain" };
    }
    return result;
  }
}

export async function dispatchInstructionOnce(
  client,
  command,
  ledger,
  lifecycle = {},
  dispatcher = dispatchInstruction
) {
  const replay = ledger.resultFor(command.command_id);
  if (replay) return replay;

  try {
    const concurrentReplay = ledger.beginDispatch(command.command_id);
    if (concurrentReplay) return concurrentReplay;
  } catch {
    // Nothing was sent when the pre-dispatch durable write failed.
    return { accepted: false, error_code: "request_failed" };
  }

  return dispatchReservedInstruction(
    client,
    command,
    ledger,
    lifecycle,
    dispatcher
  );
}
