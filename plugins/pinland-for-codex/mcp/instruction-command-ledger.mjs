import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LEDGER_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_ACCEPTED_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LEDGER_BYTES = 256 * 1_024;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_GRACE_MS = 250;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_CODES = new Set([
  "codex_unavailable",
  "delivery_uncertain",
  "invalid_payload",
  "request_failed",
  "thread_active",
  "thread_unavailable"
]);
const ENTRY_STATES = new Set([
  "accepted",
  "dispatching",
  "failed",
  "uncertain"
]);
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safeFailureCode(value) {
  return FAILURE_CODES.has(value) ? value : "request_failed";
}

function acceptedTombstoneExpired(entry, now, ttlMilliseconds) {
  return entry?.state === "accepted"
    && Number.isSafeInteger(entry.acknowledged_at_ms)
    && now - entry.acknowledged_at_ms >= ttlMilliseconds;
}

function replayResult(entry, now, ttlMilliseconds) {
  if (acceptedTombstoneExpired(entry, now, ttlMilliseconds)) return undefined;
  switch (entry?.state) {
    case "accepted":
      return { accepted: true };
    case "failed":
      return {
        accepted: false,
        error_code: safeFailureCode(entry.error_code)
      };
    case "dispatching":
    case "uncertain":
      return { accepted: false, error_code: "delivery_uncertain" };
    default:
      return undefined;
  }
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object"
      || !COMMAND_ID_PATTERN.test(value.command_id)
      || !ENTRY_STATES.has(value.state)
      || !Number.isSafeInteger(value.updated_at_ms)
      || value.updated_at_ms < 0) {
    return undefined;
  }
  if (value.state === "failed" && !FAILURE_CODES.has(value.error_code)) {
    return undefined;
  }
  if (value.acknowledged_at_ms !== undefined
      && (value.state !== "accepted"
        || !Number.isSafeInteger(value.acknowledged_at_ms)
        || value.acknowledged_at_ms < 0)) {
    return undefined;
  }
  return {
    command_id: value.command_id,
    state: value.state,
    updated_at_ms: value.updated_at_ms,
    ...(value.state === "failed" ? { error_code: value.error_code } : {}),
    ...(value.state === "accepted" && value.acknowledged_at_ms !== undefined
      ? { acknowledged_at_ms: value.acknowledged_at_ms }
      : {})
  };
}

export class InstructionCommandLedger {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "instruction-command-ledger.json");
    this.lockPath = path.join(dataDir, "instruction-command-ledger.lock");
    this.maxEntries = Number.isSafeInteger(options.maxEntries)
      && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;
    this.acceptedTombstoneTTLMilliseconds = Number.isSafeInteger(
      options.acceptedTombstoneTTLMilliseconds
    ) && options.acceptedTombstoneTTLMilliseconds > 0
      ? options.acceptedTombstoneTTLMilliseconds
      : DEFAULT_ACCEPTED_TOMBSTONE_TTL_MS;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.entries = new Map();
    this.loadFailed = false;
    this.reload();
  }

  reload() {
    this.entries = new Map();
    this.loadFailed = false;
    this.load();
  }

  load() {
    let serialized;
    try {
      const stats = fs.statSync(this.filePath);
      if (stats.size > MAX_LEDGER_BYTES) {
        this.loadFailed = true;
        return;
      }
      serialized = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") this.loadFailed = true;
      return;
    }

    try {
      const payload = JSON.parse(serialized);
      if (payload?.schema_version !== LEDGER_SCHEMA_VERSION
          || !Array.isArray(payload.entries)
          || payload.entries.length > this.maxEntries) {
        this.loadFailed = true;
        return;
      }
      const entries = new Map();
      for (const candidate of payload.entries) {
        const entry = normalizeEntry(candidate);
        if (!entry || entries.has(entry.command_id)) {
          this.loadFailed = true;
          return;
        }
        entries.set(entry.command_id, entry);
      }
      this.entries = entries;
    } catch {
      // Fail closed: an unreadable existing ledger may contain a command that
      // was already handed to Codex, so silently starting over could duplicate it.
      this.loadFailed = true;
    }
  }

  resultFor(commandID) {
    if (this.loadFailed) {
      return { accepted: false, error_code: "delivery_uncertain" };
    }
    return replayResult(
      this.entries.get(commandID),
      this.now(),
      this.acceptedTombstoneTTLMilliseconds
    );
  }

  beginDispatch(commandID) {
    return this.withExclusiveMutation(() => {
      if (this.loadFailed) {
        return { accepted: false, error_code: "delivery_uncertain" };
      }
      this.pruneExpiredAcceptedTombstones();
      const existing = replayResult(
        this.entries.get(commandID),
        this.now(),
        this.acceptedTombstoneTTLMilliseconds
      );
      if (existing) return existing;
      this.makeCapacityFor(commandID);
      this.entries.set(commandID, {
        command_id: commandID,
        state: "dispatching",
        updated_at_ms: this.now()
      });
      this.persist();
      return undefined;
    });
  }

  releaseDispatch(commandID) {
    return this.withExclusiveMutation(() => {
      if (this.loadFailed) {
        throw new Error("instruction ledger is unavailable");
      }
      const existing = this.entries.get(commandID);
      if (existing?.state !== "dispatching") return false;
      this.entries.delete(commandID);
      this.persist();
      return true;
    });
  }

  recordResult(commandID, result) {
    this.withExclusiveMutation(() => {
      if (this.loadFailed) throw new Error("instruction ledger is unavailable");
      this.pruneExpiredAcceptedTombstones();
      this.makeCapacityFor(commandID);
      let entry;
      if (result?.accepted === true) {
        entry = {
          command_id: commandID,
          state: "accepted",
          updated_at_ms: this.now()
        };
      } else if (result?.error_code === "delivery_uncertain") {
        entry = {
          command_id: commandID,
          state: "uncertain",
          updated_at_ms: this.now()
        };
      } else {
        entry = {
          command_id: commandID,
          state: "failed",
          updated_at_ms: this.now(),
          error_code: safeFailureCode(result?.error_code)
        };
      }
      this.entries.set(commandID, entry);
      this.persist();
    });
  }

  acknowledge(commandID) {
    this.withExclusiveMutation(() => {
      if (this.loadFailed || !this.entries.has(commandID)) return;
      const previous = this.entries.get(commandID);
      if (previous.state === "dispatching" || previous.state === "uncertain") {
        // An HTTP ack only confirms that Pinland heard "outcome unknown". Keep
        // the tombstone so a manual retry with the same command id cannot send
        // a second turn whose first delivery may actually have succeeded.
        return;
      }
      if (previous.state === "accepted") {
        // 204 confirms only that the current Pinland process handled the ack.
        // Keep an acknowledged tombstone so a preferences rollback or stale
        // claim after restart replays accepted instead of starting a new turn.
        this.entries.set(commandID, {
          ...previous,
          acknowledged_at_ms: previous.acknowledged_at_ms ?? this.now()
        });
      } else {
        // Definite failures never started a turn and may be retried safely.
        this.entries.delete(commandID);
      }
      this.persist();
    });
  }

  pruneExpiredAcceptedTombstones() {
    const now = this.now();
    for (const [commandID, entry] of this.entries) {
      if (acceptedTombstoneExpired(
        entry,
        now,
        this.acceptedTombstoneTTLMilliseconds
      )) {
        this.entries.delete(commandID);
      }
    }
  }

  makeCapacityFor(commandID) {
    if (this.entries.has(commandID)) return;
    if (this.entries.size < this.maxEntries) return;
    const acknowledgedAccepted = [...this.entries.values()]
      .filter((entry) => entry.state === "accepted"
        && Number.isSafeInteger(entry.acknowledged_at_ms))
      .sort((left, right) => left.acknowledged_at_ms - right.acknowledged_at_ms);
    while (this.entries.size >= this.maxEntries && acknowledgedAccepted.length) {
      this.entries.delete(acknowledgedAccepted.shift().command_id);
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error("instruction ledger capacity reached");
    }
  }

  withExclusiveMutation(mutation) {
    const lockToken = this.acquireLock();
    try {
      this.reload();
      return mutation();
    } finally {
      this.releaseLock(lockToken);
    }
  }

  acquireLock() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      let descriptor;
      let created = false;
      try {
        descriptor = fs.openSync(this.lockPath, "wx", 0o600);
        created = true;
        fs.writeFileSync(descriptor, JSON.stringify({
          token,
          pid: process.pid
        }), "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        return token;
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } catch {
            // Preserve the original lock error.
          }
        }
        if (created) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // The failed create remains fail-closed if cleanup is unavailable.
          }
        }
        if (error?.code !== "EEXIST") throw error;
      }

      this.repairAbandonedLock();
      if (Date.now() >= deadline) {
        throw new Error("instruction ledger lock is unavailable");
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
    }
  }

  repairAbandonedLock() {
    let firstContents;
    let stats;
    try {
      stats = fs.lstatSync(this.lockPath);
      if (!stats.isFile()
          || stats.isSymbolicLink()
          || Date.now() - stats.mtimeMs < LOCK_STALE_GRACE_MS) return;
      firstContents = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return;
    }
    try {
      const owner = JSON.parse(firstContents);
      if (processIsAlive(owner?.pid)) return;
    } catch {
      // A process can die after open("wx") but before writing its owner JSON.
      // Once old and stable, that malformed lock is abandoned and repairable.
    }

    try {
      const currentStats = fs.lstatSync(this.lockPath);
      const currentContents = fs.readFileSync(this.lockPath, "utf8");
      if (currentStats.ino !== stats.ino || currentContents !== firstContents) return;
      fs.unlinkSync(this.lockPath);
    } catch {
      // Another process released or repaired it first.
    }
  }

  releaseLock(token) {
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
      if (owner?.token === token) fs.unlinkSync(this.lockPath);
    } catch {
      // A lost lock fails future mutations closed; never remove another owner.
    }
  }

  persist() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify({
      schema_version: LEDGER_SCHEMA_VERSION,
      entries: [...this.entries.values()]
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) {
      throw new Error("instruction ledger size limit reached");
    }

    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.filePath);
      try {
        const directoryDescriptor = fs.openSync(this.dataDir, "r");
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      } catch {
        // The file rename is already atomic. Directory fsync is a best-effort
        // durability improvement on filesystems that support it.
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may already have been renamed or removed.
      }
      throw error;
    }
  }
}
