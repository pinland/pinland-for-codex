import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { migratePluginSource, verifyPinlandMarketplace } from "./plugin-source-migration.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";
import { discoverUpdateEligibility, PluginUpdateSync } from "./plugin-update.mjs";

const version = "0.1.0+codex.20261018010000";
const target = { version, marketplace_path: "/Users/test/Applications/Pinland.app/Contents/Resources/Integrations/.agents/plugins/marketplace.json" };
const oldPath = "/Users/test/projects/Pinland/Integrations/.agents/plugins/marketplace.json";
const identity = { version: "0.1.0+codex.20261008000000", declarations: ["mcp", null, "hooks"] };
const readIdentity = () => ({ ...identity, version });
function catalog(file) {
  const root = path.resolve(path.dirname(file), "../..");
  return { name: "pinland", path: file, plugins: [{ id: "pinland-for-codex@pinland", name: "pinland-for-codex",
    installed: true, enabled: true, source: { type: "local", path: `${root}/plugins/pinland-for-codex` },
    installPolicy: "AVAILABLE", availability: "AVAILABLE", mustShowInstallationInterstitial: false }] };
}
function fixture(options = {}) {
  let current = options.current ?? catalog(oldPath);
  const calls = [], saves = [], phases = [];
  const journal = options.journal ?? new PluginUpdateJournal();
  const attempt = options.attempt ?? journal.load("migration");
  const detail = () => {
    const m = catalog(target.marketplace_path);
    options.changeTarget?.(m.plugins[0]);
    return { plugin: { marketplaceName: m.name, marketplacePath: m.path, summary: m.plugins[0] } };
  };
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    const injected = await options.request?.(method, params);
    if (injected !== undefined) return injected;
    if (method === "plugin/installed") return { marketplaces: current ? [current] : [] };
    if (method === "plugin/read") return detail();
    if (method === "marketplace/remove") { current = undefined; return {}; }
    if (method === "marketplace/add") { current = catalog(target.marketplace_path); return {}; }
    if (method === "plugin/install") return { appsNeedingAuth: [] };
    if (method === "hooks/list") return { data: [{ hooks: [{ pluginId: "pinland-for-codex@pinland",
      enabled: true, trustStatus: "trusted" }], errors: [] }] };
    throw Error("unexpected request");
  } };
  const migration = { attempt, verifyTarget: options.verifyTarget ?? (async () => true),
    save: () => { journal.save(attempt); saves.push(structuredClone(attempt)); },
    isOwner: options.isOwner, onProgress: async state => phases.push(state) };
  return { client, calls, saves, phases, attempt, migration, journal, current: () => current,
    run: () => discoverUpdateEligibility(client, target, identity, readIdentity, migration) };
}

test("a verified moved source migrates only its own native catalog before installation", async () => {
  const f = fixture();
  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.calls.map(c => c.method), ["plugin/installed", "plugin/read", "marketplace/remove", "marketplace/add", "plugin/installed"]);
  assert.deepEqual(f.calls[2].params, { marketplaceName: "pinland" });
  assert.equal(f.current().path, target.marketplace_path);
  assert.equal(f.attempt.sourceMigration.phase, "registered");
  assert.ok(f.saves.some(s => s.sourceMigration.phase === "prepared"), "persist before removing the old registration");
  assert.deepEqual(f.phases, ["migrating", "ready"]);
});

test("disabled, removed, remote, policy-blocked and unrelated catalogs never migrate", async () => {
  for (const change of [m => m.plugins[0].enabled = false, m => m.plugins[0].installed = false,
    m => m.plugins[0].source.type = "git", m => m.plugins[0].installPolicy = "NOT_AVAILABLE",
    m => m.plugins[0].mustShowInstallationInterstitial = true,
    m => m.plugins.push({ id: "other@pinland", name: "other" }), m => m.name = "other"]) {
    const current = catalog(oldPath); change(current);
    const f = fixture({ current });
    assert.notEqual(await f.run(), undefined);
    assert.ok(f.calls.every(c => c.method === "plugin/installed"));
  }
});

test("native target review requirements wait without changing source or granting trust", async () => {
  const f = fixture({ changeTarget: p => p.mustShowInstallationInterstitial = true });
  assert.equal(await f.run(), "review_required");
  assert.deepEqual(f.calls.map(c => c.method), ["plugin/installed", "plugin/read"]);
  assert.equal(f.current().path, oldPath);
});

test("a stale one-shot recovery catalog does not block migration after both App paths disappear", async () => {
  let registered = false;
  const missing = "/Old/Pinland.app/Contents/Resources/Integrations/.agents/plugins/marketplace.json";
  const helper = "/Old/Pinland.app/Contents/Resources/Integrations/Recovery/.agents/plugins/marketplace.json";
  const f = fixture({ request: method => {
    if (method === "plugin/installed" && !registered) return { marketplaces: [], marketplaceLoadErrors: [
      { marketplacePath: missing }, { marketplacePath: helper }] };
    if (method === "marketplace/add") registered = true;
  } });
  assert.equal(await f.run(), undefined);
  assert.equal(f.current().path, target.marketplace_path);
  assert.ok(f.calls.filter(call => call.method === "marketplace/remove").every(call => call.params.marketplaceName === "pinland"));
});

test("new target hooks require native receipts even if the old package had no hooks", async () => {
  const f = fixture({ request: method => method === "hooks/list" ? { data: [{ hooks: [], errors: [] }] } : undefined });
  const sync = new PluginUpdateSync({ identity: { ...identity, declarations: ["mcp", null, null] },
    protocolVersion: 37, readIdentity, sourceMigrationEnabled: true, verifyMigrationTarget: async () => true });
  await sync.refresh(f.client, async () => ({ status: 200, json: target }), "token", "epoch");
  assert.equal(sync.issue, "query_failed");
  assert.equal(sync.state, "checking");
  assert.ok(!f.calls.some(call => call.method === "plugin/install"));
});

test("unverified source targets cannot change registrations", async () => {
  const f = fixture({ verifyTarget: async () => false });
  assert.equal(await f.run(), "source_changed");
  assert.equal(f.calls.length, 1);
});

test("an interrupted removal resumes automatically without reinstalling or repeating removal", async () => {
  let first = true;
  const f = fixture({ request: method => { if (method === "marketplace/add" && first) { first = false; throw Error("offline"); } } });
  await assert.rejects(f.run(), /offline/);
  assert.equal(f.current(), undefined);
  assert.equal(f.journal.load("migration").sourceMigration.phase, "detached");
  assert.equal(await f.run(), undefined);
  assert.equal(f.calls.filter(c => c.method === "marketplace/remove").length, 1);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
});

test("losing ownership cannot remove a source", async () => {
  const f = fixture({ isOwner: () => false });
  await assert.rejects(f.run(), /lost leadership/);
  assert.ok(!f.calls.some(c => c.method === "marketplace/remove"));
});

test("same-version App moves migrate registration without reinstalling an up-to-date package", async () => {
  const f = fixture();
  const reports = [];
  const sync = new PluginUpdateSync({ identity: { ...identity, version }, protocolVersion: 37,
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true, readIdentity });
  const send = async (route, token, body) => { reports.push(body); return { status: 200, json: target }; };
  await sync.refresh(f.client, send, "token", "epoch");
  assert.equal(sync.state, "current");
  assert.equal(sync.report().source_state, "ready");
  assert.equal(f.current().path, target.marketplace_path);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
  await sync.refresh(f.client, send, "token", "new-epoch");
  assert.equal(f.calls.filter(c => c.method === "marketplace/remove").length, 1);
});

test("legacy source_changed journals get one automatic migration recheck", async () => {
  const f = fixture();
  const journal = new PluginUpdateJournal();
  let now = 100000;
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, journal,
    now: () => now, sourceMigrationEnabled: true, verifyMigrationTarget: async () => true, readIdentity });
  const send = async () => ({ status: 200, json: target });
  sync.verifyMigrationTarget = async () => false;
  await sync.refresh(f.client, send, "token", "epoch");
  assert.equal(sync.issue, "source_changed");
  sync.verifyMigrationTarget = async () => true;
  now += 31000;
  await sync.refresh(f.client, send, "token", "epoch2");
  assert.equal(sync.report().source_state, "ready");
  assert.equal(sync.report().install_receipt, "acknowledged");
});

test("an old missing-source retry budget can recover once without clearing an install receipt", async () => {
  const f = fixture();
  const key = createHash("sha256").update(`${target.version}:${target.marketplace_path}`).digest("hex");
  const journal = new PluginUpdateJournal();
  const previous = journal.load(key);
  Object.assign(previous, { phase: "manual", issue: "query_failed", attempts: 5, nextAt: Date.now() + 300000 });
  journal.save(previous);
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, journal,
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true, readIdentity });
  await sync.refresh(f.client, async () => ({ status: 200, json: target }), "token", "epoch");
  assert.equal(sync.report().source_state, "ready");
  assert.equal(sync.report().install_receipt, "acknowledged");
  assert.equal(journal.load(key).sourceMigrationChecked, true);
});

test("Codex hook review pauses automatic handoff and resumes after native confirmation", async () => {
  let trusted = false, installed = false, starts = 0, now = 100000;
  const f = fixture({ request: method => {
    if (method === "plugin/install") { installed = true; return { appsNeedingAuth: [] }; }
    if (method === "hooks/list") return { data: [{ hooks: [{ pluginId: "pinland-for-codex@pinland",
      trustStatus: trusted ? "trusted" : "modified" }] }] };
  } });
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, readIdentity, now: () => now,
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true,
    installedForHandoff: () => installed ? { version, entry: "/verified/cache/mcp/pins-sync-server.mjs" } : undefined,
    startCompanion: async () => { starts++; return true; } });
  const send = async () => ({ status: 200, json: target });
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, "review_required");
  assert.equal(starts, 0);
  trusted = true; now += 31000;
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, undefined);
  assert.equal(starts, 1);
});

test("new native hook review after installation resumes without reinstalling or trusting hooks", async () => {
  let trusted = false, installed = false, starts = 0, now = 100000;
  const declarations = ["new mcp", null, "new hooks"];
  const f = fixture({ request: method => {
    if (method === "plugin/install") { installed = true; return { appsNeedingAuth: [] }; }
    if (method === "hooks/list") return { data: [{ hooks: [{ pluginId: "pinland-for-codex@pinland",
      trustStatus: !installed || trusted ? "trusted" : "modified" }] }] };
  } });
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, now: () => now,
    readIdentity: () => ({ version, declarations }),
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true,
    installedForHandoff: approved => installed && JSON.stringify(approved.declarations) === JSON.stringify(declarations)
      ? { version, entry: "/verified/cache/mcp/pins-sync-server.mjs" } : undefined,
    startCompanion: async () => { starts++; return true; } });
  const send = async () => ({ status: 200, json: target });
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, "review_required");
  assert.equal(starts, 0);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
  trusted = true; now += 31000;
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, undefined);
  assert.equal(starts, 1);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
  assert.ok(f.calls.every(c => ["plugin/installed", "plugin/read", "marketplace/remove", "marketplace/add",
    "plugin/install", "hooks/list"].includes(c.method)), "only Codex can grant hook trust");
});

test("native hook load failures and missing own hooks never authorize a package handoff", async () => {
  for (const result of [{ data: [{ hooks: [], errors: [{ path: "/private/hooks.json", message: "load failed" }] }] },
    { data: [] }, { data: [{ hooks: [] }] }, { data: [{}] }]) {
    let now = 100000, starts = 0, recovered = false;
    const f = fixture({ request: method => method === "hooks/list" && !recovered ? result : undefined });
    const sync = new PluginUpdateSync({ identity, protocolVersion: 37, now: () => now, readIdentity,
      sourceMigrationEnabled: true, verifyMigrationTarget: async () => true,
      installedForHandoff: () => ({ version, entry: "/verified/cache/mcp/pins-sync-server.mjs" }),
      startCompanion: async () => { starts++; return true; } });
    const send = async () => ({ status: 200, json: target });
    for (let attempt = 0; attempt < 7; attempt++) {
      await sync.refresh(f.client, send, "token", "e");
      assert.equal(sync.issue, "query_failed");
      assert.equal(sync.state, "checking", "a temporary read error must not require manual recovery");
      assert.equal(sync.handoffIdentity, undefined);
      assert.equal(starts, 0);
      assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
      now += 31000;
    }
    recovered = true;
    await sync.refresh(f.client, send, "token", "e");
    assert.equal(sync.issue, undefined);
    assert.equal(starts, 1, "a recovered native read resumes automatically without confirmation");
  }
});

test("hook-read failure after native installation keeps its receipt and resumes without reinstalling", async () => {
  let installed = false, recovered = false, starts = 0, now = 100000;
  const f = fixture({ request: method => {
    if (method === "plugin/install") { installed = true; return { appsNeedingAuth: [] }; }
    if (method === "hooks/list" && installed && !recovered) throw Error("native hook query timed out");
  } });
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, readIdentity, now: () => now,
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true,
    installedForHandoff: () => installed ? { version, entry: "/verified/cache/mcp/pins-sync-server.mjs" } : undefined,
    startCompanion: async () => { starts++; return true; } });
  const send = async () => ({ status: 200, json: target });
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, "query_failed");
  assert.equal(sync.report().install_receipt, "acknowledged");
  assert.equal(sync.handoffIdentity, undefined);
  assert.equal(starts, 0);
  recovered = true; now += 31000;
  await sync.refresh(f.client, send, "token", "e");
  assert.equal(sync.issue, undefined);
  assert.equal(starts, 1);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("explicitly disabled own hooks remain disabled without requiring trust", async () => {
  const f = fixture({ request: method => method === "hooks/list" ? { data: [{ hooks: [{
    pluginId: "pinland-for-codex@pinland", enabled: false, trustStatus: "untrusted" }], errors: [] }] } : undefined });
  const sync = new PluginUpdateSync({ identity: { ...identity, version }, protocolVersion: 37, readIdentity,
    sourceMigrationEnabled: true, verifyMigrationTarget: async () => true });
  await sync.refresh(f.client, async () => ({ status: 200, json: target }), "token", "e");
  assert.equal(sync.state, "current");
  assert.equal(sync.issue, undefined);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
});

test("a newer running plugin clears obsolete source progress without querying or downgrading", async () => {
  const sync = new PluginUpdateSync({ identity: { ...identity, version: "0.1.0+codex.20261019010000" },
    protocolVersion: 37, sourceMigrationEnabled: true });
  sync.sourceState = "migrating";
  sync.state = "updating";
  sync.issue = "review_required";
  const reports = [];
  await sync.refresh({ request: async () => { assert.fail("rollback must not install or migrate an older target"); } },
    async (route, token, report) => { reports.push(report); return { status: 200, json: target }; }, "token", "e");
  assert.equal(sync.state, "current");
  assert.equal(sync.report().source_state, undefined);
  assert.equal(sync.issue, undefined);
  assert.equal(reports.at(-1).update_state, "current");
  const sourceRun = new PluginUpdateSync({ identity, protocolVersion: 37 });
  assert.ok(!sourceRun.report().capabilities.includes("source_migration_v1"));
});

test("target verification requires the signed own App, exact catalog and matching package", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-signed-source-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = path.join(temp, "Pinland.app");
  const root = path.join(app, "Contents/Resources/Integrations");
  const file = path.join(root, ".agents/plugins/marketplace.json");
  const plugin = path.join(root, "plugins/pinland-for-codex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(plugin, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: "pinland", plugins: [{ name: "pinland-for-codex", source: { source: "local", path: "./plugins/pinland-for-codex" } }] }));
  fs.writeFileSync(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "pinland-for-codex", version }));
  const value = { version, marketplace_path: file };
  let checks = 0;
  const options = { verifySignature: async appPath => { checks++; assert.equal(appPath, app); return true; } };
  assert.equal(await verifyPinlandMarketplace(value, options), true);
  assert.equal(checks, 1);
  assert.equal(await verifyPinlandMarketplace(value, { verifySignature: async () => false }), false);
  assert.equal(await verifyPinlandMarketplace({ ...value, version: identity.version }, options), false);
  assert.equal(await verifyPinlandMarketplace({ ...value, marketplace_path: oldPath }, options), false);
  fs.symlinkSync(file, path.join(plugin, "unsealed"));
  assert.equal(await verifyPinlandMarketplace(value, options), false);
});
