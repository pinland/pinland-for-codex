export class NativePinSnapshotSyncState {
  constructor(nextRevision) {
    if (typeof nextRevision !== "function") {
      throw new TypeError("nextRevision must be a function");
    }
    this.nextRevision = nextRevision;
    this.lastSentHash = undefined;
    this.pendingSnapshot = undefined;
    this.bridgeWasUnavailable = false;
    this.bridgeEpoch = undefined;
    this.replayRequired = false;
  }

  observeBridge(status, bridgeEpoch) {
    if (status === 0) {
      this.bridgeWasUnavailable = true;
      return;
    }
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    if (typeof bridgeEpoch === "string" && bridgeEpoch.length > 0) {
      if (this.bridgeEpoch !== undefined && bridgeEpoch !== this.bridgeEpoch) {
        this.replayRequired = true;
      }
      this.bridgeEpoch = bridgeEpoch;
    }
    if (this.bridgeWasUnavailable) {
      this.bridgeWasUnavailable = false;
      this.replayRequired = true;
    }
  }

  snapshotFor(hash, sourceID, sessions) {
    if (!this.pendingSnapshot
        && hash === this.lastSentHash
        && !this.replayRequired) {
      return undefined;
    }
    if (!this.pendingSnapshot || this.pendingSnapshot.hash !== hash) {
      this.pendingSnapshot = {
        hash,
        body: {
          schema_version: 1,
          source_id: sourceID,
          revision: this.nextRevision(),
          complete: true,
          sessions
        }
      };
    }
    this.replayRequired = false;
    return this.pendingSnapshot;
  }

  acknowledge(hash) {
    this.lastSentHash = hash;
    this.pendingSnapshot = undefined;
    this.replayRequired = false;
    this.bridgeWasUnavailable = false;
  }

  rejectAsStale() {
    this.pendingSnapshot = undefined;
    this.replayRequired = true;
  }
}
