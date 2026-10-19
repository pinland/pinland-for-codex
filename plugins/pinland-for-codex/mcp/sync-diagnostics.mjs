// Allowlisted categories only: never send exception messages, paths, or tokens.
export function syncFailureCode(error) {
  if (error?.code === -32601) return "unsupported_api";
  const message = String(error?.message || "");
  if (message === "Codex executable is unavailable") return "codex_unavailable";
  if (message === "Codex Pinned section is unavailable") return "pinned_section_unavailable";
  if (/timed out/i.test(message)) return "read_timed_out";
  return "read_failed";
}

// Uses the existing sync loop, not another timer. Healthy idle traffic is one
// small local report per 30 seconds; failures and recovery are immediate.
export class SyncDiagnosticsReporter {
  constructor(send, now = Date.now) {
    this.send = send;
    this.now = now;
    this.lastKey = undefined;
    this.lastAttempt = -Infinity;
    this.disabled = false;
    this.bridgeEpoch = undefined;
  }

  observeBridge(epoch) {
    if (typeof epoch !== "string" || !epoch || epoch === this.bridgeEpoch) return;
    this.bridgeEpoch = epoch;
    this.disabled = false;
    this.lastKey = undefined;
  }

  async report(token, sourceID, { revision, failure } = {}) {
    if (this.disabled) return undefined;
    const state = failure ? "error" : "ready";
    // Revision changes don't warrant more traffic: snapshots already notify
    // Pinland. Producer/token changes and error transitions do.
    const key = `${token}:${sourceID}:${state}:${failure || ""}`;
    if (key === this.lastKey && this.now() - this.lastAttempt < 30_000) return undefined;
    this.lastKey = key;
    this.lastAttempt = this.now();
    try {
      const response = await this.send("/v1/pins/status", token, {
        schema_version: 1, source_id: sourceID, state,
        ...(failure ? { failure } : { revision })
      });
      // An older Pinland still syncs normally; don't keep calling a missing API.
      if (response.status === 404) this.disabled = true;
      if (response.status === 409) this.lastKey = undefined;
      return response.status;
    } catch {
      // Diagnostics must never break the underlying sync or change its backoff.
      return undefined;
    }
  }
}
