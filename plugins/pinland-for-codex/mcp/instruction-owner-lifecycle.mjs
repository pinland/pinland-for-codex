import {
  dispatchReservedInstruction,
  resumeInstructionThread,
  startInstructionTurn
} from "./outbound-instructions.mjs";

const DEFAULT_TURN_START_WAIT_MS = 30_000;
const DEFAULT_TURN_TERMINAL_WAIT_MS = 4 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_OWNERS = 2;

/**
 * A non-blocking capacity guard for the heavyweight temporary app-server
 * processes that own Pinland-started turns. It deliberately never queues: a
 * caller either reserves a slot synchronously or receives a retryable busy
 * result without creating a process or touching the delivery ledger.
 */
export class InstructionOwnerCapacity {
  constructor(maxOwners = DEFAULT_MAX_CONCURRENT_OWNERS) {
    if (!Number.isSafeInteger(maxOwners) || maxOwners <= 0) {
      throw new TypeError("maxOwners must be a positive integer");
    }
    this.maxOwners = maxOwners;
    this.activeOwners = 0;
  }

  get activeCount() {
    return this.activeOwners;
  }

  tryAcquire() {
    if (this.activeOwners >= this.maxOwners) return undefined;
    this.activeOwners += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOwners = Math.max(0, this.activeOwners - 1);
    };
  }
}

function turnIDFromStartResult(value) {
  return typeof value?.turn?.id === "string" && value.turn.id.trim()
    ? value.turn.id.trim()
    : undefined;
}

async function releaseAfterOwnedTurn(client, state, options, releaseCapacity) {
  try {
    let turnID = state.turnID;
    if (!turnID) {
      const started = await client.waitForTurnStarted(
        state.threadID,
        options.turnStartWaitMilliseconds
      );
      turnID = started.turnID;
    }
    await client.waitForTurnTerminal(
      state.threadID,
      turnID,
      options.turnTerminalWaitMilliseconds
    );
  } catch {
    // A missing terminal notification must not leave a stale owner process.
  } finally {
    try {
      await client.close();
    } finally {
      releaseCapacity();
    }
  }
}

/**
 * Dispatches exactly one instruction through a fresh app-server connection.
 * The connection is closed immediately when Desktop owns the writer or when
 * dispatch fails. A successfully owned turn retains the connection only
 * until its matching terminal notification so approvals stay on that channel.
 */
export async function dispatchInstructionWithTemporaryOwner(
  createOwnerClient,
  command,
  ledger,
  options = {}
) {
  let replay;
  try {
    replay = ledger.beginDispatch(command.command_id);
  } catch {
    return { result: { accepted: false, error_code: "request_failed" } };
  }
  if (replay) return { result: replay };

  const releaseReservationForDesktop = () => {
    try {
      return ledger.releaseDispatch(command.command_id) === true;
    } catch {
      return false;
    }
  };

  const ownerCapacity = options.ownerCapacity;
  const releaseCapacity = ownerCapacity?.tryAcquire?.() ?? (
    ownerCapacity ? undefined : () => {}
  );
  if (!releaseCapacity) {
    const canFallback = releaseReservationForDesktop();
    return {
      result: {
        accepted: false,
        error_code: canFallback ? "codex_unavailable" : "delivery_uncertain"
      },
      ...(canFallback ? { fallbackToDesktop: true } : {})
    };
  }

  let client;
  try {
    client = await createOwnerClient();
  } catch {
    releaseCapacity();
    const canFallback = releaseReservationForDesktop();
    return {
      result: {
        accepted: false,
        error_code: canFallback ? "codex_unavailable" : "delivery_uncertain"
      },
      ...(canFallback ? { fallbackToDesktop: true } : {})
    };
  }

  const state = {
    threadID: command.session_id,
    writerAcquired: false,
    turnID: undefined
  };
  let resumeResult;
  try {
    resumeResult = await resumeInstructionThread(client, command, {
      onWriterAcquired() {
        state.writerAcquired = true;
      }
    });
  } catch {
    resumeResult = { accepted: false, error_code: "codex_unavailable" };
  }

  if (!resumeResult.accepted) {
    try {
      await client.close();
    } finally {
      releaseCapacity();
    }
    const canFallback = releaseReservationForDesktop();
    return {
      result: canFallback
        ? resumeResult
        : { accepted: false, error_code: "delivery_uncertain" },
      ...(canFallback ? { fallbackToDesktop: true } : {})
    };
  }

  let result;
  try {
    result = await dispatchReservedInstruction(
      client,
      command,
      ledger,
      {
        onTurnStarted(startResult) {
          state.turnID = turnIDFromStartResult(startResult);
        }
      },
      startInstructionTurn
    );
  } catch {
    try {
      await client.close();
    } finally {
      releaseCapacity();
    }
    return { result: { accepted: false, error_code: "delivery_uncertain" } };
  }

  const retainOwner = state.writerAcquired
    && (result.accepted === true || result.error_code === "delivery_uncertain");
  if (!retainOwner) {
    try {
      await client.close();
    } finally {
      releaseCapacity();
    }
    return { result };
  }

  const releasePromise = releaseAfterOwnedTurn(client, state, {
    turnStartWaitMilliseconds: Number.isFinite(options.turnStartWaitMilliseconds)
      ? Math.max(0, options.turnStartWaitMilliseconds)
      : DEFAULT_TURN_START_WAIT_MS,
    turnTerminalWaitMilliseconds: Number.isFinite(options.turnTerminalWaitMilliseconds)
      ? Math.max(0, options.turnTerminalWaitMilliseconds)
      : DEFAULT_TURN_TERMINAL_WAIT_MS
  }, releaseCapacity);
  return { result, ownerClient: client, releasePromise };
}

/**
 * Selects one synchronous delivery route without ever replaying a prompt.
 *
 * The task-owner route is the only route that can steer the currently running
 * task in place. Older, idle Desktop tasks do not always answer owner
 * discovery even though Desktop still holds their app-server writer. In that
 * case a Codex-hosted cross-task provider must be tried before a temporary
 * app-server; otherwise the temporary process collides with Desktop and the
 * idle task is incorrectly reported as active.
 *
 * Each routed dispatcher owns the same durable command reservation and may
 * set `fallbackToOwner` only after proving that no prompt was delivered. An
 * uncertain result therefore stops the chain and can never duplicate a turn.
 */
export async function dispatchInstructionForAvailableHost(
  dispatchDesktop,
  dispatchProvider,
  dispatchOwner
) {
  if (typeof dispatchDesktop === "function") {
    const desktop = await dispatchDesktop();
    const normalized = desktop?.result ? desktop : { result: desktop };
    if (!normalized.fallbackToOwner) return normalized;
  }

  if (typeof dispatchProvider === "function") {
    const provider = await dispatchProvider();
    const normalized = provider?.result ? provider : { result: provider };
    if (!normalized.fallbackToOwner) return normalized;
  }

  const owned = await dispatchOwner();
  const {
    fallbackToDesktop: _fallbackToDesktop,
    fallbackToOwner: _fallbackToOwner,
    ...publicDispatch
  } = owned;
  return publicDispatch;
}
