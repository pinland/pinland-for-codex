import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LegacyPluginRecovery, RECOVERY_PLUGIN_ID, mainPluginPairing, cachedMainIdentity } from "./legacy-plugin-recovery.mjs";

const version = "0.1.0+codex.20261018030000";
const target = { version, marketplace_path: "/Applications/Pinland.app/Contents/Resources/Integrations/.agents/plugins/marketplace.json",
  recovery_marketplace_path: "/Applications/Pinland.app/Contents/Resources/Integrations/Recovery/.agents/plugins/marketplace.json" };
const identity = { version: "0.1.0+codex.20261008000000", cacheFamily: "/native/plugins/cache/pinland/pinland-for-codex",
  declarations: ["mcp", null, "hooks"] };
const root = file => file.slice(0, -"/.agents/plugins/marketplace.json".length);
function catalog(file) { return { name: "pinland", path: file, plugins: [{ id: "pinland-for-codex@pinland",
  name: "pinland-for-codex", installed: true, enabled: true, source: { type: "local", path: root(file) + "/plugins/pinland-for-codex" },
  installPolicy: "AVAILABLE", availability: "AVAILABLE" }] }; }
function fixture(options = {}) {
  let current = catalog("/Old/Pinland.app/Contents/Resources/Integrations/.agents/plugins/marketplace.json");
  options.change?.(current.plugins[0]);
  let now = 100000, cached = options.cached ?? false, mainReady = false, active = false, trusted = options.trusted ?? true;
  let helperEnabled = true;
  const calls = [], reports = [], starts = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "plugin/installed") return { marketplaces: current ? [current] : [] };
    if (method === "plugin/read" && params.pluginName === "pinland-recovery") return { plugin: {
      summary: { id: RECOVERY_PLUGIN_ID, enabled: helperEnabled } } };
    if (method === "plugin/read") { const m = catalog(target.marketplace_path); return { plugin: {
      marketplaceName: m.name, marketplacePath: m.path, summary: m.plugins[0] } }; }
    if (method === "marketplace/remove") { current = undefined; return {}; }
    if (method === "marketplace/add") { current = catalog(target.marketplace_path); return {}; }
    if (method === "hooks/list") return { data: [{ errors: [], hooks: [{ pluginId: "pinland-for-codex@pinland",
      enabled: true, trustStatus: !cached || trusted ? "trusted" : "modified" }] }] };
    if (method === "plugin/install") { cached = true; return { appsNeedingAuth: [] }; }
    if (method === "config/value/write") { helperEnabled = options.disableOverridden === true; return { status: options.disableOverridden ? "okOverridden" : "ok" }; }
    throw Error("unexpected native method");
  } };
  const pairing = { token: "private-test-token", directory: "/native/main-data" };
  const runner = new LegacyPluginRecovery({ client, identity: options.identity ?? identity, pairing, helperVersion: version,
    runtimeID: "00000000-0000-4000-8000-000000000001", now: () => now,
    verifyTarget: options.verifyTarget ?? (async () => true), readIdentity: () => ({ ...identity, version }),
    installedForHandoff: () => cached ? { version, entry: "/native/verified/mcp/pins-sync-server.mjs" } : undefined,
    startCompanion: async (installed, options) => { starts.push({ installed, options }); return true; },
    environment: { PLUGIN_DATA: "/native/helper-data", HOME: "/home/test", CODEX_HOME: "/native" },
    send: async report => { reports.push(report); return { status: 200,
      json: { ...target, main_ready: mainReady, active_tasks: active } }; } });
  return { runner, calls, reports, starts, advance: () => now += 31000,
    ready: () => mainReady = true, active: value => active = value, approve: () => trusted = true,
    source: () => current?.path };
}

test("reviewed recovery migrates the real main identity, installs natively and starts with the main data directory", async () => {
  const f = fixture();
  await f.runner.run();
  assert.equal(f.source(), target.marketplace_path);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.environment.PLUGIN_DATA, "/native/main-data");
  assert.equal(f.starts[0].options.environment.PLUGIN_ROOT, "/native/verified");
  assert.equal(f.calls.filter(c => c.method === "config/value/write").length, 0,
    "install acknowledgement is not runtime success");
  f.ready(); f.advance();
  await f.runner.run();
  assert.equal(f.runner.complete, true);
  assert.deepEqual(f.calls.find(c => c.method === "config/value/write").params,
    { keyPath: `plugins."${RECOVERY_PLUGIN_ID}".enabled`, value: false, mergeStrategy: "replace" });
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("already cached same-version files still need their actual replacement process, without reinstalling", async () => {
  const f = fixture({ identity: { ...identity, version }, cached: true });
  await f.runner.run();
  assert.equal(f.starts.length, 1);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
});

test("a config write overridden by policy is not a confirmed self-disable", async () => {
  const f = fixture({ disableOverridden: true }); f.ready();
  await assert.rejects(f.runner.run(), /disable not effective/);
  assert.equal(f.runner.complete, undefined);
  assert.equal(f.starts.length, 0);
});

test("native review pauses recovery and native approval resumes it without another installation", async () => {
  const f = fixture({ trusted: false });
  await f.runner.run();
  assert.equal(f.starts.length, 0);
  assert.ok(f.reports.some(r => r.state === "review_required" && r.issue === "review_required"));
  f.approve(); f.advance();
  await f.runner.run();
  assert.equal(f.starts.length, 1);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("active tasks defer every native mutation and a reviewed helper never re-enables or replaces a denied plugin", async () => {
  const busy = fixture(); busy.active(true);
  await busy.runner.run();
  assert.deepEqual(busy.calls, []);
  for (const change of [p => p.enabled = false, p => p.installed = false,
    p => p.installPolicy = "NOT_AVAILABLE", p => p.source.type = "git"]) {
    const f = fixture({ change }); await f.runner.run();
    assert.equal(f.starts.length, 0);
    assert.ok(f.calls.every(c => c.method === "plugin/installed"));
  }
});

test("unverified sources and newer installed packages cannot be used to downgrade or mutate native settings", async () => {
  for (const options of [{ verifyTarget: async () => false },
    { identity: { ...identity, version: "0.1.0+codex.20261019000000" } }]) {
    const f = fixture(options); await f.runner.run();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.starts, []);
    assert.equal(f.runner.complete, undefined);
  }
});

test("legacy pairing is read privately and cache selection never downgrades a newer cached version", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-recovery-identity-"));
  try {
    const data = path.join(home, "plugin-data/pinland-for-codex");
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    const token = "f".repeat(64);
    fs.writeFileSync(path.join(data, "bridge-token"), token, { mode: 0o600 });
    fs.writeFileSync(path.join(data, "paired"), "1", { mode: 0o600 });
    const pairing = mainPluginPairing({ CODEX_HOME: home });
    assert.equal(pairing.directory, data); assert.equal(pairing.token, token);
    for (const value of [identity.version, version, "0.1.0+codex.20261019000000"]) {
      const root = path.join(pairing.cacheFamily, value, ".codex-plugin");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "pinland-for-codex", version: value }));
    }
    assert.equal(cachedMainIdentity(pairing.cacheFamily, identity.version, version).version, "0.1.0+codex.20261019000000");
    fs.rmSync(path.join(pairing.cacheFamily, "0.1.0+codex.20261019000000"), { recursive: true });
    assert.equal(cachedMainIdentity(pairing.cacheFamily, identity.version, version).version, identity.version);
    fs.chmodSync(path.join(data, "bridge-token"), 0o644);
    assert.equal(mainPluginPairing({ CODEX_HOME: home }), undefined, "Do not adopt exposed credentials");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
