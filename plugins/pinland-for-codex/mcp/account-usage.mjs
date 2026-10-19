// Only normalized quota numbers cross the Pinland bridge. No account tokens,
// email addresses or billing credentials leave the Codex process.
export function codexUsageReport(result, now = Date.now()) {
  // During an account refresh the Codex bucket can exist but still be empty.
  // Use a populated legacy snapshot in that case, never an unrelated model's quota.
  const candidates = [result?.rateLimitsByLimitId?.codex, result?.rateLimits];
  const windows = candidates.map(limits => ["primary", "secondary"].flatMap(id => {
      const value = limits?.[id];
      if (!Number.isFinite(value?.usedPercent) || value.usedPercent < 0) return [];
      return [{ id, usedPercent: value.usedPercent,
        ...(Number.isInteger(value.windowDurationMins) && value.windowDurationMins > 0
          && value.windowDurationMins <= 525_600 ? { durationMinutes: value.windowDurationMins } : {}),
        ...(Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? { resetsAt: value.resetsAt } : {}) }];
    })).find(value => value.length) ?? [];
  return { schema_version: 1, provider: "codex", status: windows.length ? "available" : "unsupported",
    windows, updated_at: now / 1000 };
}

export class AccountUsageSync {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.nextAttemptAt = 0;
    this.failures = 0;
    this.generation = 0;
  }

  refresh(client, bridgeRequest, token, epoch) {
    if (client !== this.client || epoch !== this.epoch || token !== this.token) {
      this.client = client;
      this.epoch = epoch;
      this.token = token;
      this.generation++;
      this.pending = undefined;
      this.nextAttemptAt = 0;
      this.failures = 0;
    }
    if (this.pending || this.now() < this.nextAttemptAt) return;
    const generation = this.generation;
    this.pending = (async () => {
      let report;
      try {
        // This request runs independently of pin/history sync. Network-backed
        // account reads need more room than the local app-server requests.
        const result = await client.request("account/rateLimits/read", {}, 15_000);
        report = codexUsageReport(result, this.now());
      } catch (error) {
        // Never fail pin/history synchronization because billing is unavailable.
        report = { schema_version: 1, provider: "codex", status: "unavailable",
          windows: [], updated_at: this.now() / 1000, failure: usageFailureCode(error) };
      }
      // A replaced client/bridge may finish after its successor has recovered.
      if (generation !== this.generation) return;
      let delivered = false;
      try {
        const response = await bridgeRequest("/v1/usage", token, report);
        delivered = response?.status === undefined || response.status === 204;
      } catch { /* A bridge failure is not an account-read failure. */ }
      if (generation !== this.generation) return;
      const succeeded = delivered && report.status === "available";
      this.failures = succeeded ? 0 : this.failures + 1;
      const delay = succeeded ? 30_000 : Math.min(30_000, 5_000 * 2 ** Math.min(this.failures - 1, 3));
      this.nextAttemptAt = this.now() + delay;
    })().finally(() => {
      if (generation === this.generation) this.pending = undefined;
    });
    return this.pending;
  }
}

export function usageFailureCode(error) {
  if (error?.code === -32601) return "api_unsupported";
  const message = String(error?.message ?? "");
  if (/timed out|timeout/i.test(message)) return "read_timeout";
  if (/not (?:logged|signed) in|unauthori[sz]ed|authentication required/i.test(message)) return "login_required";
  return "read_failed";
}
