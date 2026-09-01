/**
 * Elects one Codex-hosted MCP process to expose its verified Desktop task
 * messaging channel to the stable daemon. This provider uses a separate
 * loopback port; Pinland itself always talks to the daemon-owned endpoint.
 */
export class DirectInstructionEndpointHost {
  constructor({ warmHostChannel, createEndpoint }) {
    if (typeof warmHostChannel !== "function"
        || typeof createEndpoint !== "function") {
      throw new TypeError("warmHostChannel and createEndpoint are required");
    }
    this.warmHostChannel = warmHostChannel;
    this.createEndpoint = createEndpoint;
    this.endpoint = undefined;
    this.acquiring = undefined;
    this.closed = false;
  }

  async acquire() {
    if (this.closed) return false;
    if (this.endpoint) return true;
    if (this.acquiring) return this.acquiring;

    this.acquiring = (async () => {
      if (await this.warmHostChannel() !== true || this.closed) return false;
      const candidate = this.createEndpoint();
      try {
        await candidate.start();
      } catch {
        await candidate.close().catch(() => {});
        return false;
      }
      if (this.closed) {
        await candidate.close().catch(() => {});
        return false;
      }
      this.endpoint = candidate;
      return true;
    })().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  async close() {
    this.closed = true;
    await this.acquiring?.catch(() => {});
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    await endpoint?.close().catch(() => {});
  }
}
