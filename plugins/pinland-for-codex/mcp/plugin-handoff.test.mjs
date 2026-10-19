import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { installedPluginForHandoff, startInstalledCompanion } from "./plugin-handoff.mjs";
import { pluginIdentity } from "./plugin-update.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pinland-handoff-test-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const family = path.join(temp, "cache/pinland/pinland-for-codex");
  const old = "0.1.0+codex.20261007000000", version = "0.1.0+codex.20261008000000";
  function write(directory, v = directory) {
    const root = path.join(family, directory);
    fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "pinland-for-codex", version: v }));
    fs.writeFileSync(path.join(root, ".mcp.json"), "trusted declarations");
    fs.writeFileSync(path.join(root, "mcp/pins-sync-server.mjs"), "// fixture");
    return root;
  }
  const identity = pluginIdentity(write(old));
  return { temp, family, old, version, identity, write };
}

test("handoff reads the installed copy, never the source or an advertised API version", t => {
  const f = fixture(t);
  assert.equal(installedPluginForHandoff(f.identity, f.version), undefined);
  const root = f.write(f.version);
  assert.deepEqual(installedPluginForHandoff(f.identity, f.version), { version: f.version, entry: path.join(root, "mcp/pins-sync-server.mjs") });
  assert.equal(f.identity.version, f.old, "Startup identity is immutable even after installation");
  assert.equal(installedPluginForHandoff({ ...f.identity, cacheFamily: path.join(f.temp, "source") }, f.version), undefined);
});

test("changed declarations, version mismatch and symlinked cache entry cannot execute", t => {
  const f = fixture(t), root = f.write(f.version);
  fs.writeFileSync(path.join(root, ".mcp.json"), "needs new review");
  assert.equal(installedPluginForHandoff(f.identity, f.version), undefined);
  fs.writeFileSync(path.join(root, ".mcp.json"), "trusted declarations");
  fs.unlinkSync(path.join(root, "mcp/pins-sync-server.mjs"));
  fs.symlinkSync(path.join(root, ".mcp.json"), path.join(root, "mcp/pins-sync-server.mjs"));
  assert.equal(installedPluginForHandoff(f.identity, f.version), undefined);
});

test("native local cache layout is supported without rereading the old runtime identity", t => {
  const f = fixture(t); const root = f.write("local", f.version);
  assert.equal(installedPluginForHandoff(f.identity, f.version)?.entry, path.join(root, "mcp/pins-sync-server.mjs"));
});

test("handoff starts only the bounded ensure-daemon entry, not a task or host restart", async () => {
  const entry = "/private/tmp/cache/pinland/pinland-for-codex/new/mcp/pins-sync-server.mjs";
  const result = await startInstalledCompanion({ entry }, { spawnProcess: (file, args) => {
    assert.equal(file, process.execPath); assert.deepEqual(args, [entry, "--ensure-daemon"]);
    const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
  } });
  assert.equal(result, true);
});

test("durable update receipt survives restart; corrupt journals fail closed", t => {
  const f = fixture(t), file = path.join(f.temp, "update.json");
  const journal = new PluginUpdateJournal(file);
  const entry = journal.load("target"); entry.phase = "submitted"; entry.attempts = 1;
  journal.save(entry);
  assert.deepEqual(new PluginUpdateJournal(file).load("target"), entry);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "broken");
  assert.throws(() => new PluginUpdateJournal(file).load("target"));
});
