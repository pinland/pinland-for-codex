import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mirrorLegacyPluginLease } from "./plugin-data-lease.mjs";
import { daemonLeaseDisposition } from "./daemon-lease-policy.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-lease-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, "native"), legacy = path.join(root, "legacy");
  for (const dir of [native, legacy]) {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "bridge-token"), "ab".repeat(32), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "paired"), "", { mode: 0o600 });
  }
  const current = { protocol_version: 37, plugin_version: "0.1.0+codex.20261018021000", token: randomUUID(), pid: process.pid };
  function owner(dir, name, value) {
    fs.mkdirSync(path.join(dir, name), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(dir, name, "owner.json"), JSON.stringify(value), { mode: 0o600 });
  }
  return { native, legacy, current, owner };
}

test("one native owner fences both old-directory leases and keeps old followers from reclaiming sync", t => {
  const f = fixture(t);
  for (const lease of ["native-pins-sync-daemon", "native-pins-sync-leader"]) {
    f.owner(f.native, lease, f.current);
    f.owner(f.legacy, lease, { ...f.current, plugin_version: "0.1.0+codex.20261008000000", token: randomUUID() });
    assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), true);
    const file = path.join(f.legacy, lease, "owner.json");
    const mirrored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(mirrored, f.current, "old daemons observe lease loss and use their existing task-draining retirement");
    assert.equal(daemonLeaseDisposition(mirrored, { pluginVersion: "0.1.0+codex.20261008000000",
      age: 0, staleMilliseconds: 15000, processIsAlive: pid => pid === process.pid }), "keep");
    assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), true, "the ownership receipt is kept fresh");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("different pairings, missing pairing and unsafe directories never displace another daemon", t => {
  const f = fixture(t), lease = "native-pins-sync-daemon";
  f.owner(f.native, lease, f.current);
  fs.writeFileSync(path.join(f.legacy, "bridge-token"), "cd".repeat(32), { mode: 0o600 });
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), false);
  assert.equal(fs.existsSync(path.join(f.legacy, lease)), false);
  fs.writeFileSync(path.join(f.legacy, "bridge-token"), "ab".repeat(32), { mode: 0o600 });
  fs.unlinkSync(path.join(f.legacy, "paired"));
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), false);
  fs.writeFileSync(path.join(f.legacy, "paired"), "", { mode: 0o600 });
  fs.mkdirSync(path.join(f.legacy, lease), { mode: 0o755 });
  fs.chmodSync(path.join(f.legacy, lease), 0o755);
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), false);
});

test("only the actual owner may mirror a lease and a newer owner is never overwritten", t => {
  const f = fixture(t), lease = "native-pins-sync-leader";
  f.owner(f.native, lease, { ...f.current, pid: process.pid + 100000 });
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), false);
  f.owner(f.native, lease, f.current);
  const next = { ...f.current, plugin_version: "0.1.0+codex.20261019000000", token: randomUUID() };
  f.owner(f.legacy, lease, next);
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, lease), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.legacy, lease, "owner.json"), "utf8")), next);
  assert.equal(mirrorLegacyPluginLease(f.native, f.legacy, "unrelated"), false);
  assert.equal(mirrorLegacyPluginLease(f.native, f.native, lease), false);
});
