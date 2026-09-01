import assert from "node:assert/strict";
import test from "node:test";

import { NativePinSnapshotSyncState } from "./snapshot-sync-state.mjs";

test("an unchanged native Pin snapshot is replayed with a new revision after bridge recovery", () => {
  let revision = 40;
  const state = new NativePinSnapshotSyncState(() => ++revision);
  const sessions = [{ session_id: "thread-one", title: "One" }];

  const initial = state.snapshotFor("same-hash", "source-one", sessions);
  assert.equal(initial.body.revision, 41);
  state.acknowledge("same-hash");
  assert.equal(state.snapshotFor("same-hash", "source-one", sessions), undefined);

  // The detached companion survives while Pinland is stopped. Its next bridge
  // request observes the refused connection, then a later poll reaches the
  // relaunched app even though Codex's native Pin set has not changed.
  state.observeBridge(0);
  state.observeBridge(204, "epoch-two");

  const replay = state.snapshotFor("same-hash", "source-one", sessions);
  assert.equal(replay.body.revision, 42);
  assert.deepEqual(replay.body.sessions, sessions);
  assert.notEqual(replay.body.revision, initial.body.revision);

  state.acknowledge("same-hash");
  assert.equal(state.snapshotFor("same-hash", "source-one", sessions), undefined);
});

test("an unacknowledged changed snapshot keeps its revision across an outage", () => {
  let revision = 80;
  const state = new NativePinSnapshotSyncState(() => ++revision);
  state.acknowledge("old-hash");

  const pending = state.snapshotFor("new-hash", "source-one", []);
  assert.equal(pending.body.revision, 81);
  state.observeBridge(0);
  state.observeBridge(204, "epoch-two");

  const retried = state.snapshotFor("new-hash", "source-one", []);
  assert.equal(retried.body.revision, 81);
  assert.strictEqual(retried, pending);
});

test("a stale rejection requires another snapshot even when the hash is unchanged", () => {
  let revision = 100;
  const state = new NativePinSnapshotSyncState(() => ++revision);
  const initial = state.snapshotFor("same-hash", "source-one", []);
  state.acknowledge("same-hash");

  state.observeBridge(0);
  state.observeBridge(204, "epoch-two");
  const rejected = state.snapshotFor("same-hash", "source-one", []);
  state.rejectAsStale();

  const rotated = state.snapshotFor("same-hash", "source-two", []);
  assert.equal(initial.body.revision, 101);
  assert.equal(rejected.body.revision, 102);
  assert.equal(rotated.body.revision, 103);
  assert.equal(rotated.body.source_id, "source-two");
});

test("a changed bridge epoch replays an unchanged snapshot even when downtime was missed", () => {
  let revision = 200;
  const state = new NativePinSnapshotSyncState(() => ++revision);
  const sessions = [{ session_id: "thread-one", title: "One" }];

  state.observeBridge(204, "epoch-one");
  const initial = state.snapshotFor("same-hash", "source-one", sessions);
  state.acknowledge("same-hash");

  // Pinland can quit and relaunch between two companion polls. Both requests
  // succeed, so the per-launch epoch is what proves the bridge restarted.
  state.observeBridge(204, "epoch-two");
  const replay = state.snapshotFor("same-hash", "source-one", sessions);

  assert.equal(initial.body.revision, 201);
  assert.equal(replay.body.revision, 202);
  assert.deepEqual(replay.body.sessions, sessions);
});
