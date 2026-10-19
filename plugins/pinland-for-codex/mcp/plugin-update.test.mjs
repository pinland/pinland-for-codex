import assert from "node:assert/strict";
import test from "node:test";
import { PluginUpdateSync, comparePluginVersions, updateEligibility, discoverUpdateEligibility } from "./plugin-update.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";

const oldVersion = "0.1.0+codex.20260918092024";
const newVersion = "0.1.0+codex.20260921000000";
const root = "/Applications/Pinland.app/Contents/Resources/Integrations";
const target = { version: newVersion, marketplace_path: `${root}/.agents/plugins/marketplace.json` };
const identity = { version: oldVersion, declarations: ["mcp", null, "hooks"] };
function installed() {
  return { marketplaces: [{ name: "pinland", path: target.marketplace_path, plugins: [{
    id: "pinland-for-codex@pinland", name: "pinland-for-codex", installed: true, enabled: true,
    source: { type: "local", path: `${root}/plugins/pinland-for-codex` }, installPolicy: "AVAILABLE"
  }] }] };
}
const readIdentity = () => ({ ...identity, version: newVersion });

test("versions compare numerically, including the cachebuster; never downgrade", () => {
  assert.equal(comparePluginVersions(oldVersion, newVersion), -1);
  assert.equal(comparePluginVersions(newVersion, oldVersion), 1);
  assert.equal(comparePluginVersions("0.10.0", "0.9.9"), 1);
  assert.equal(comparePluginVersions(newVersion, newVersion), 0);
  assert.equal(comparePluginVersions("../secret", newVersion), undefined);
});

test("only an installed enabled same-source plugin allowed by native policy auto-updates", () => {
  assert.equal(updateEligibility(installed(), target, identity, readIdentity), undefined);
  for (const [change, expected] of [[p => p.enabled = false, "disabled"], [p => p.installed = false, "not_installed"],
    [p => p.source.type = "git", "source_changed"], [p => p.source.path = "/tmp/other", "source_changed"],
    [p => p.installPolicy = "NOT_AVAILABLE", "admin_blocked"], [p => p.availability = "DISABLED_BY_ADMIN", "admin_blocked"]]) {
    const value = installed(); change(value.marketplaces[0].plugins[0]);
    assert.equal(updateEligibility(value, target, identity, readIdentity), expected);
  }
  const moved = installed(); moved.marketplaces[0].path = "/tmp/marketplace.json";
  assert.equal(updateEligibility(moved, target, identity, readIdentity), "source_changed");
  const interstitial = installed(); interstitial.marketplaces[0].plugins[0].mustShowInstallationInterstitial = true;
  assert.equal(updateEligibility(interstitial, target, identity, readIdentity), "review_required");
  assert.equal(updateEligibility(installed(), target, identity, () => ({ version: newVersion, declarations: ["new server"] })), undefined,
    "a declaration change alone is not a Codex review decision");
  assert.equal(updateEligibility(installed(), target, identity, () => ({ ...identity })), "source_changed");
  assert.equal(updateEligibility(installed(), { ...target, marketplace_path: "relative/file" }, identity, readIdentity), "source_changed");
});

function fixture(requestOverride, options = {}) {
  let now = 100_000;
  const calls = [], reports = [];
  const sync = new PluginUpdateSync({ identity, protocolVersion: 37, readIdentity, now: () => now, ...options });
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (requestOverride) return requestOverride(method, params);
    return method === "plugin/installed" ? installed() : { appsNeedingAuth: [] };
  } };
  const send = async (route, token, body) => {
    assert.equal(route, "/v1/plugin/status"); assert.equal(token, "local-token");
    reports.push(body); return { status: 200, json: target };
  };
  return { sync, calls, reports, client, send, advance: (ms = 31_000) => now += ms };
}

test("targeted install preserves running identity and waits for real reload, no repeated installs", async () => {
  const f = fixture();
  f.sync.refresh(f.client, f.send, "local-token", "epoch");
  f.sync.refresh(f.client, f.send, "local-token", "epoch");
  await f.sync.pending;
  assert.deepEqual(f.calls.map(c => c.method), ["plugin/installed", "plugin/install"]);
  assert.deepEqual(f.calls[1].params, { pluginName: "pinland-for-codex", marketplacePath: target.marketplace_path });
  assert.equal(f.reports.at(-1).update_state, "reload_required");
  assert.ok(f.reports.every(r => r.plugin_version === oldVersion));
  assert.ok(f.reports.at(-1).capabilities.includes("account_usage_v1"));
  f.advance(); f.sync.refresh(f.client, f.send, "local-token", "epoch2"); await f.sync.pending;
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1, "Pinland restart may reconcile but must not reinstall");
});

test("unsupported query APIs stop, transient pre-install query errors retry", async () => {
  for (const code of [-32601, -1]) {
    const f = fixture(() => { throw Object.assign(Error("private error, token=secret"), { code }); });
    f.sync.refresh(f.client, f.send, "local-token", "e"); await f.sync.pending;
    assert.equal(f.reports.at(-1).issue, code === -32601 ? "host_unsupported" : "query_failed");
    assert.ok(!JSON.stringify(f.reports).includes("secret"));
    f.advance(); f.sync.refresh(f.client, f.send, "local-token", "e"); await f.sync.pending;
    assert.equal(f.calls.length, code === -32601 ? 1 : 2);
  }
});

test("newer runtime, old Pinland, and source changes never issue an install", async () => {
  const f = fixture();
  for (const response of [{ status: 404 }, { status: 401 },
    { status: 200, json: { ...target, version: "0.1.0" } },
    { status: 200, json: { ...target, marketplace_path: "/tmp/marketplace.json" } }]) {
    f.advance(); f.sync.refresh(f.client, async () => response, "local-token", "e"); await f.sync.pending;
  }
  assert.ok(f.calls.every(c => c.method !== "plugin/install"));
});

test("auth requirements are reported for native confirmation, never granted", async () => {
  const f = fixture(method => method === "plugin/installed" ? installed() : { appsNeedingAuth: [{ id: "hidden" }] });
  f.sync.refresh(f.client, f.send, "local-token", "e"); await f.sync.pending;
  assert.equal(f.reports.at(-1).update_state, "manual_required");
  assert.equal(f.reports.at(-1).issue, "review_required");
  assert.ok(!JSON.stringify(f.reports).includes("hidden"));
});

test("runtime identity and host failure report before app-server exists, then update once it recovers", async () => {
  const f = fixture();
  f.sync.setHost({ state: "executable_missing", checks: [{ source: "host_cli", layout: "explicit", result: "missing" }] });
  await f.sync.refresh(undefined, f.send, "local-token", "epoch");
  assert.equal(f.reports[0].plugin_version, oldVersion);
  assert.equal(f.reports[0].host.state, "executable_missing");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.journal.memory, undefined);
  assert.deepEqual(f.sync.target, target);
  f.sync.setHost({ state: "ready", source: "host_node", layout: "packaged", checks: [] });
  await f.sync.refresh(f.client, f.send, "local-token", "epoch");
  assert.deepEqual(f.calls.map(c => c.method), ["plugin/installed", "plugin/install"]);
  assert.equal(f.reports.at(-1).host.state, "ready");
});

function detail(value = installed()) {
  const marketplace = value.marketplaces[0];
  return { plugin: { marketplaceName: marketplace.name, marketplacePath: marketplace.path,
    summary: { ...marketplace.plugins[0], localVersion: newVersion } } };
}

test("missing default discovery uses a directed same-source read, not advertised localVersion", async () => {
  const f = fixture((method, params) => {
    if (method === "plugin/installed") return { marketplaces: [] };
    if (method === "plugin/read") {
      assert.deepEqual(params, { pluginName: "pinland-for-codex", marketplacePath: target.marketplace_path });
      return detail();
    }
    return { appsNeedingAuth: [] };
  });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.deepEqual(f.calls.map(c => c.method), ["plugin/installed", "plugin/read", "plugin/install"]);
  assert.equal(f.sync.report().plugin_version, oldVersion);
  assert.equal(f.sync.report().install_receipt, "acknowledged");
});

test("explicit denial or source conflict never falls through to directed discovery", async () => {
  for (const change of [p => p.enabled = false, p => p.installed = false,
    p => p.availability = "DISABLED_BY_ADMIN", p => p.installPolicy = "NOT_AVAILABLE",
    p => p.mustShowInstallationInterstitial = true, p => p.source.path = "/tmp/conflict"]) {
    const value = installed(); change(value.marketplaces[0].plugins[0]);
    const f = fixture(method => { assert.equal(method, "plugin/installed"); return value; });
    await f.sync.refresh(f.client, f.send, "local-token", "e");
    assert.equal(f.sync.state, "manual_required");
    assert.equal(f.calls.length, 1);
  }
  const value = installed(); value.marketplaces.push({ ...value.marketplaces[0], name: "other", path: "/tmp/conflict" });
  assert.equal(await discoverUpdateEligibility({ request: async () => value }, target, identity, readIdentity), "source_changed");
});

test("directed queries enforce every identity, policy, enabled and review check", async () => {
  for (const [change, expected] of [[p => p.enabled = false, "disabled"], [p => p.installed = false, "not_installed"],
    [p => p.installPolicy = "NOT_AVAILABLE", "admin_blocked"], [p => p.mustShowInstallationInterstitial = true, "review_required"],
    [p => p.source.path = "/tmp/other", "source_changed"], [p => p.id = "other@pinland", "source_changed"]]) {
    const value = installed(); change(value.marketplaces[0].plugins[0]);
    const f = fixture(method => method === "plugin/installed" ? { marketplaces: [] } : detail(value));
    await f.sync.refresh(f.client, f.send, "local-token", "e");
    assert.equal(f.sync.issue, expected);
    assert.ok(!f.calls.some(c => c.method === "plugin/install"));
  }
});

test("discovery errors are not an empty default list", async () => {
  const f = fixture(method => { assert.equal(method, "plugin/installed");
    return { marketplaces: [], marketplaceLoadErrors: [{ message: "private path" }] }; });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.sync.issue, "query_failed");
  assert.equal(f.calls.length, 1);
});

test("a recovered query installs once; parallel triggers share the operation", async () => {
  let queries = 0;
  const f = fixture(method => {
    if (method === "plugin/installed" && ++queries === 1) throw new Error("temporary");
    return method === "plugin/installed" ? installed() : { appsNeedingAuth: [] };
  });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  f.advance();
  await Promise.all(Array.from({ length: 6 }, () => f.sync.refresh(f.client, f.send, "local-token", "e")));
  assert.equal(queries, 2);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("automatic retries are bounded and epochs do not reset the budget; reconnect grants one recheck", async () => {
  const f = fixture(() => { throw new Error("temporary"); });
  for (let i = 0; i < 9; i++) {
    await f.sync.refresh(f.client, f.send, "local-token", `bridge-restart-${i}`); f.advance(400_000);
  }
  assert.equal(f.calls.length, 5);
  assert.equal(f.sync.state, "manual_required");
  const manual = async () => ({ status: 200, json: { ...target, recovery_request: "00000000-0000-4000-8000-000000000001" } });
  await f.sync.refresh(f.client, manual, "local-token", "explicit-reconnect");
  f.advance(400_000);
  await f.sync.refresh(f.client, manual, "local-token", "another-app-restart");
  assert.equal(f.calls.length, 6);
});

test("a lost install receipt survives updater restart and is only reconciled, never reinstalled", async () => {
  const journal = new PluginUpdateJournal();
  const f = fixture(method => {
    if (method === "plugin/installed") return installed();
    throw new Error("install response timed out");
  }, { journal });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.sync.issue, "install_uncertain");
  const restarted = fixture(method => {
    assert.equal(method, "plugin/installed"); return installed();
  }, { journal });
  restarted.advance(400_000);
  await restarted.sync.refresh(restarted.client, restarted.send, "local-token", "new-process");
  assert.equal(restarted.sync.issue, "install_uncertain");
  assert.equal(restarted.sync.report().install_receipt, "uncertain");
  assert.deepEqual(restarted.calls.map(c => c.method), ["plugin/installed"]);
});

test("acknowledged install timeout differs from uncertain install and does not retry", async () => {
  const f = fixture(); await f.sync.refresh(f.client, f.send, "local-token", "e");
  f.advance(180_000); await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.sync.issue, "reload_timeout");
  assert.equal(f.sync.report().install_receipt, "acknowledged");
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("a missing native install method is a definite rejection, not an uncertain success", async () => {
  const f = fixture(method => {
    if (method === "plugin/installed") return installed();
    throw Object.assign(new Error("unsupported"), { code: -32601 });
  });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.sync.issue, "host_unsupported");
  assert.equal(f.sync.report().install_receipt, undefined);
});

test("a lost leader and an unavailable durable journal cannot submit installs", async () => {
  let owner = true;
  const f = fixture(() => { owner = false; return installed(); }, { isOwner: () => owner });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 0);
  const broken = fixture(undefined, { journal: { load: () => { throw new Error("corrupt"); } } });
  await broken.sync.refresh(broken.client, broken.send, "local-token", "e");
  assert.equal(broken.sync.issue, "journal_unavailable");
  assert.equal(broken.calls.length, 0);
});

test("an already materialized matching cache takes over without reinstalling", async () => {
  let starts = 0;
  const f = fixture(method => { assert.equal(method, "plugin/installed"); return installed(); }, {
    installedForHandoff: () => ({ version: newVersion, entry: "/validated/cache/entry.mjs" }),
    startCompanion: async () => { starts++; return true; }
  });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(starts, 1);
  assert.equal(f.sync.report().installed_version, newVersion);
  assert.equal(f.sync.report().plugin_version, oldVersion);
  assert.equal(f.sync.report().install_receipt, "verified");
  for (let i = 0; i < 5; i++) { f.advance(90_000); await f.sync.refresh(f.client, f.send, "local-token", `e${i}`); }
  assert.equal(starts, 3, "handoff launch attempts are bounded across epochs");
  assert.ok(!f.calls.some(c => c.method === "plugin/install"));
});

test("owned tasks defer updates without spending the retry budget", async () => {
  let busy = true;
  const f = fixture(undefined, { hasOwnedTasks: () => busy });
  for (let i = 0; i < 6; i++) { await f.sync.refresh(f.client, f.send, "local-token", "e"); f.advance(); }
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.issue, "active_tasks");
  busy = false;
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("a lost install receipt can recover from verified native files without repeating install", async () => {
  let cached = false, starts = 0;
  const f = fixture(method => {
    if (method === "plugin/installed") return installed();
    cached = true;
    throw new Error("transport lost after native install");
  }, {
    installedForHandoff: () => cached ? { version: newVersion, entry: "/validated/cache/entry.mjs" } : undefined,
    startCompanion: async () => { starts++; return true; }
  });
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(f.sync.report().issue, "install_uncertain");
  f.advance(61_000);
  await f.sync.refresh(f.client, f.send, "local-token", "e");
  assert.equal(starts, 1);
  assert.equal(f.sync.report().installed_version, newVersion);
  assert.equal(f.sync.report().plugin_version, oldVersion);
  assert.equal(f.calls.filter(c => c.method === "plugin/install").length, 1);
});

test("materialized cache never bypasses disablement, policy, or a pending auth review", async () => {
  for (const deny of ["disabled", "policy", "review"]) {
    let starts = 0, cached = false;
    const f = fixture(method => {
      if (method === "plugin/installed") {
        const value = installed(), plugin = value.marketplaces[0].plugins[0];
        if (deny === "disabled") plugin.enabled = false;
        if (deny === "policy") plugin.installPolicy = "NOT_AVAILABLE";
        return value;
      }
      cached = true;
      return { appsNeedingAuth: [{ id: "private" }] };
    }, {
      installedForHandoff: () => cached ? { version: newVersion, entry: "/validated/cache/entry.mjs" } : undefined,
      startCompanion: async () => { starts++; }
    });
    await f.sync.refresh(f.client, f.send, "local-token", "e");
    cached = true;
    f.advance(61_000);
    await f.sync.refresh(f.client, f.send, "local-token", "e");
    assert.equal(starts, 0, deny);
    assert.equal(f.sync.state, "manual_required");
  }
});
