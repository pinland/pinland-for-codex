import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";
import { migratePluginSource, sourceRecordIssue, verifyPinlandMarketplace } from "./plugin-source-migration.mjs";

export const PLUGIN_NAME = "pinland-for-codex";
export const PLUGIN_CAPABILITIES = ["account_usage_v1", "plugin_update_v1", "runtime_sync_v1", "plugin_handoff_v1", "source_migration_v1"];
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:\+codex\.\d{14})?$/;
const DECLARATIONS = [".mcp.json", ".app.json", "hooks/hooks.json"];
const HOOK_REVIEW_UNAVAILABLE = "PINLAND_HOOK_REVIEW_UNAVAILABLE";
const unavailableHookState = () => Object.assign(new Error("hook review state unavailable"), { code: HOOK_REVIEW_UNAVAILABLE });

export function comparePluginVersions(a, b) {
  if (!VERSION.test(a ?? "") || !VERSION.test(b ?? "")) return undefined;
  const parts = value => value.split(/[.+]/).filter(v => v !== "codex").map(Number);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

function readSmallFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error("invalid file");
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Capture at process start. Reading the manifest again after a cache refresh
// would incorrectly claim the old in-memory daemon is already the new version.
export function pluginIdentity(root) {
  const manifest = JSON.parse(readSmallFile(path.join(root, ".codex-plugin/plugin.json")));
  if (manifest?.name !== PLUGIN_NAME || !VERSION.test(manifest.version)) throw new Error("invalid plugin identity");
  const family = path.dirname(root);
  let cacheFamily;
  if (path.basename(family) === PLUGIN_NAME && path.basename(path.dirname(family)) === "pinland"
      && path.basename(path.dirname(path.dirname(family))) === "cache") cacheFamily = fs.realpathSync(family);
  return { version: manifest.version,
    ...(cacheFamily ? { cacheFamily } : {}),
    declarations: DECLARATIONS.map(file => readSmallFile(path.join(root, file))) };
}

export function updateEligibility(installed, target, identity, readIdentity = pluginIdentity) {
  if (!VERSION.test(target?.version ?? "") || !path.isAbsolute(target?.marketplace_path ?? "")) return "source_changed";
  const marketplacePath = path.normalize(target.marketplace_path);
  if (!marketplacePath.endsWith("/.agents/plugins/marketplace.json")) return "source_changed";
  const marketplace = installed?.marketplaces?.find(m => m.name === "pinland" && m.path === marketplacePath);
  const plugin = marketplace?.plugins?.find(p => p.id === `${PLUGIN_NAME}@pinland` && p.name === PLUGIN_NAME);
  const recordIssue = sourceRecordIssue(marketplace, plugin);
  if (recordIssue) return recordIssue;
  const root = path.resolve(path.dirname(marketplacePath), "../..", "plugins", PLUGIN_NAME);
  try {
    const source = readIdentity(root);
    if (source.version !== target.version) return "source_changed";
    // Codex owns permission review. A local declaration comparison cannot tell
    // whether Codex has already approved the new package.
  } catch { return "source_changed"; }
  return undefined;
}

// Absence from default discovery is not evidence of a different source. Only
// absence permits a directed read; an explicit conflicting/disabled record wins.
export async function discoverUpdateEligibility(client, target, identity, readIdentity = pluginIdentity, migration) {
  const installed = await client.request("plugin/installed", {}, 15_000);
  if (!Array.isArray(installed?.marketplaces)) throw new Error("invalid discovery");
  const candidates = installed.marketplaces.flatMap(m => (m.plugins || [])
    .filter(p => p.name === PLUGIN_NAME || p.id === `${PLUGIN_NAME}@pinland`)
    .map(p => ({ marketplace: m, plugin: p })));
  for (const { marketplace, plugin } of candidates) {
    const issue = updateEligibility({ marketplaces: [{ ...marketplace, plugins: [plugin] }] }, target, identity, readIdentity);
    if (issue) {
      if (issue === "source_changed" && migration) {
        return migratePluginSource({ client, installed, target, ...migration,
          validateDetail: detail => validateDirectedDetail(detail, target, identity, readIdentity) });
      }
      return issue;
    }
  }
  if (candidates.length) return undefined;
  // Load errors cannot be interpreted as an empty discovery scope.
  if (installed.marketplaceLoadErrors?.length) {
    if (migration) return migratePluginSource({ client, installed, target, ...migration,
      validateDetail: detail => validateDirectedDetail(detail, target, identity, readIdentity) });
    throw new Error("marketplace unavailable");
  }
  const detail = (await client.request("plugin/read", {
    pluginName: PLUGIN_NAME, marketplacePath: target.marketplace_path
  }, 15_000))?.plugin;
  const issue = validateDirectedDetail(detail, target, identity, readIdentity);
  if (issue || !migration) return issue;
  return migratePluginSource({ client, installed, target, ...migration,
    validateDetail: value => validateDirectedDetail(value, target, identity, readIdentity) });
}

function validateDirectedDetail(detail, target, identity, readIdentity) {
  if (!detail || !detail.summary) throw new Error("invalid directed discovery");
  return updateEligibility({ marketplaces: [{ name: detail.marketplaceName,
    path: detail.marketplacePath, plugins: [detail.summary] }] }, target, identity, readIdentity);
}

// Only Codex's targeted plugin/install API writes the installed package.
// No cache/config edits, marketplace-wide reconciliation, trust grants, process
// restarts. A separately verified installed-cache handoff can start our own
// replacement companion, never a marketplace source or changed declaration.
export class PluginUpdateSync {
  constructor({ identity, protocolVersion, runtimeID, now = Date.now, readIdentity = pluginIdentity,
    journal = new PluginUpdateJournal(), isOwner = () => true, hasOwnedTasks = () => false,
    installedForHandoff = () => undefined, startCompanion = async () => false,
    verifyMigrationTarget = verifyPinlandMarketplace, sourceMigrationEnabled = Boolean(identity.cacheFamily) }) {
    this.identity = identity;
    this.protocolVersion = protocolVersion;
    this.now = now;
    this.readIdentity = readIdentity;
    this.lastAttempt = -Infinity;
    this.journal = journal;
    this.runtimeID = runtimeID;
    this.isOwner = isOwner;
    this.hasOwnedTasks = hasOwnedTasks;
    this.installedForHandoff = installedForHandoff;
    this.startCompanion = startCompanion;
    this.verifyMigrationTarget = verifyMigrationTarget;
    this.sourceMigrationEnabled = sourceMigrationEnabled;
    this.installedVersion = identity.cacheFamily ? identity.version : undefined;
    this.state = "current";
    this.pending = undefined;
  }

  report() {
    return { schema_version: 1, plugin_version: this.identity.version,
      runtime_protocol: this.protocolVersion, capabilities: this.sourceMigrationEnabled
        ? PLUGIN_CAPABILITIES : PLUGIN_CAPABILITIES.filter(value => value !== "source_migration_v1"),
      update_state: this.state, ...(this.issue ? { issue: this.issue } : {}),
      ...(this.runtimeID ? { runtime_id: this.runtimeID } : {}),
      ...(this.installTarget ? { install_target_version: this.installTarget } : {}),
      ...(this.installReceipt ? { install_receipt: this.installReceipt } : {}),
      ...(this.installedVersion ? { installed_version: this.installedVersion } : {}),
      ...(this.sourceState ? { source_state: this.sourceState } : {}),
      ...(this.host ? { host: this.host } : {}) };
  }

  setHost(host) {
    if (JSON.stringify(host) !== JSON.stringify(this.host)) this.lastAttempt = -Infinity;
    this.host = host;
  }

  refresh(client, send, token, epoch) {
    if (!this.isOwner()) return;
    if (this.pending) return this.pending;
    if (this.epoch === epoch && this.clientReady === Boolean(client) && this.now() - this.lastAttempt < 30_000) return;
    this.epoch = epoch;
    this.clientReady = Boolean(client);
    this.lastAttempt = this.now();
    this.pending = this.run(client, send, token).catch(() => {
      // Losing Pinland must not break task sync or turn a lost install receipt
      // into an unbounded reinstall loop.
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async run(client, send, token) {
    const response = await send("/v1/plugin/status", token, this.report());
    if (response?.status !== 200) return; // Older Pinland keeps working.
    const target = response.json;
    this.target = target;
    // A broken Codex bootstrap must not hide the running plugin's identity.
    // Do not spend an update attempt until its native API actually exists.
    if (!client) return;
    const comparison = comparePluginVersions(this.identity.version, target?.version);
    if (comparison === 1) {
      // A rollback must not leave a previous target's migration/review state
      // attached to the newer running package, or install an older package.
      this.state = "current";
      this.issue = undefined;
      this.sourceState = undefined;
      this.installTarget = undefined;
      this.installReceipt = undefined;
      await this.publish(send, token);
      return;
    }
    if (comparison !== -1 && (comparison !== 0 || !this.sourceMigrationEnabled
        || this.confirmedSource === target?.marketplace_path)) return;
    // Validate before making any native query with a path from the bridge.
    if (!path.isAbsolute(target?.marketplace_path ?? "")
        || !path.normalize(target.marketplace_path).endsWith("/.agents/plugins/marketplace.json")) return;
    const key = createHash("sha256").update(`${target.version}:${target.marketplace_path}`).digest("hex");
    let attempt;
    try { attempt = this.journal.load(key); }
    catch {
      this.state = "manual_required"; this.issue = "journal_unavailable";
      await this.publish(send, token); return;
    }
    const submitted = ["submitted", "acknowledged", "verified"].includes(attempt.phase);
    // Older companions permanently stopped at a path mismatch or exhausted
    // their queries after the old App disappeared. The first migration-capable
    // process gets one automatic, durable eligibility recheck.
    if (!submitted && this.sourceMigrationEnabled && attempt.phase === "manual"
        && ["source_changed", "query_failed"].includes(attempt.issue) && !attempt.sourceMigrationChecked) {
      attempt.sourceMigrationChecked = true;
      attempt.phase = "checking";
      attempt.attempts = Math.min(attempt.attempts, 4);
      attempt.nextAt = 0;
    }
    if (!submitted && this.hasOwnedTasks()) {
      this.state = "checking"; this.issue = "active_tasks";
      await this.publish(send, token); return;
    }
    this.installTarget = submitted ? target.version : undefined;
    this.installReceipt = submitted ? (attempt.phase === "submitted" ? "uncertain" : attempt.phase) : undefined;
    // This nonce changes ONLY for an explicit reconnect. A bridge/process epoch
    // changes on app launch too and must never reset the durable install guard.
    const recovery = /^[0-9a-f-]{36}$/i.test(target.recovery_request ?? "") ? target.recovery_request : "";
    const manualRetry = recovery && recovery !== attempt.recoveryRequest && this.now() >= attempt.nextAt;
    if (manualRetry) {
      attempt.recoveryRequest = recovery;
      if (!submitted) { attempt.attempts = Math.min(attempt.attempts, 4); attempt.phase = "checking"; }
    }
    const awaitingReview = attempt.phase === "manual" && attempt.issue === "review_required";
    if (!submitted && (attempt.phase === "manual" || attempt.attempts >= 5) && !manualRetry && !awaitingReview) {
      this.state = "manual_required"; this.issue = attempt.issue || "query_failed";
      await this.publish(send, token); return;
    }
    if (this.now() < attempt.nextAt) return;
    this.state = "checking";
    this.issue = undefined;
    try {
      if (!submitted && !awaitingReview) attempt.attempts++;
      attempt.recoveryRequest = recovery;
      this.save(attempt);
      const migration = this.sourceMigrationEnabled ? {
        attempt, save: () => this.save(attempt), isOwner: this.isOwner,
        verifyTarget: this.verifyMigrationTarget,
        onProgress: async state => {
          this.sourceState = state;
          this.state = "updating";
          await this.publish(send, token);
        }
      } : undefined;
      const issue = await discoverUpdateEligibility(client, target, this.identity, this.readIdentity, migration);
      if (issue) {
        if (this.sourceMigrationEnabled) this.sourceState = "checking";
        this.state = "manual_required";
        this.issue = issue;
        if (!submitted) attempt.phase = "manual";
        attempt.issue = issue;
        attempt.nextAt = this.now() + 30_000;
        this.save(attempt);
      } else if (!await this.reviewInstalledHooks(client, attempt, target)) {
        // Only an explicit Codex hook trust state pauses for user confirmation.
      } else if (comparison === 0) {
        // An App move also needs registration migration when the installed
        // package already has the desired version. It must not reinstall it.
        this.confirmedSource = target.marketplace_path;
        this.sourceState = "ready";
        this.state = "current";
        this.issue = undefined;
        this.installedVersion = this.identity.version;
        attempt.phase = "verified";
        attempt.attempts = 0;
        attempt.issue = undefined;
        attempt.nextAt = this.now() + 30_000;
        this.save(attempt);
      } else if (submitted || this.installedForHandoff(this.identity, target.version)) {
        this.sourceState = this.sourceMigrationEnabled ? "ready" : undefined;
        if (!submitted) {
          attempt.phase = "verified";
          attempt.submittedAt = this.now();
          this.installTarget = target.version;
          this.installReceipt = "verified";
        }
        // plugin/read.localVersion can describe the *source*, not the running
        // or installed copy. Recheck eligibility but NEVER treat it as a lost
        // install receipt, and never resubmit an installation of unknown fate.
        this.state = attempt.issue === "review_required" ? "manual_required" : "reload_required";
        this.issue = attempt.issue === "review_required" ? "review_required" : attempt.phase === "submitted" ? "install_uncertain"
          : this.now() - attempt.submittedAt > 120_000 ? "reload_timeout" : undefined;
        attempt.nextAt = this.now() + 60_000;
        this.save(attempt);
        if (attempt.issue !== "review_required") await this.handoff(attempt, target);
      } else {
        this.sourceState = this.sourceMigrationEnabled ? "ready" : undefined;
        this.state = "updating";
        await this.publish(send, token);
        if (!this.isOwner()) return;
        attempt.phase = "submitted";
        attempt.submittedAt = this.now();
        attempt.nextAt = this.now() + 30_000;
        this.save(attempt); // A durable guard is required before side effects.
        this.installTarget = target.version;
        this.installReceipt = "uncertain";
        const result = await client.request("plugin/install", {
          pluginName: PLUGIN_NAME, marketplacePath: target.marketplace_path
        }, 15_000);
        if (!Array.isArray(result?.appsNeedingAuth)) throw new Error("invalid install reply");
        attempt.phase = "acknowledged";
        attempt.issue = result.appsNeedingAuth.length ? "review_required" : undefined;
        attempt.needsAppAuth = result.appsNeedingAuth.length > 0;
        this.save(attempt);
        this.installReceipt = "acknowledged";
        this.state = attempt.issue ? "manual_required" : "reload_required";
        this.issue = attempt.issue;
        // An install response only acknowledges files, not the running daemon.
        if (!attempt.issue && await this.reviewInstalledHooks(client, attempt, target)) await this.handoff(attempt, target);
      }
    } catch (error) {
      if (!this.isOwner()) return;
      if (this.sourceMigrationEnabled) this.sourceState = "checking";
      const waitingForHooks = error?.code === HOOK_REVIEW_UNAVAILABLE;
      // A native method-not-found response is a definite rejection, unlike a
      // timeout or transport loss. It must not masquerade as an installed copy.
      if (error?.code === -32601 && attempt.phase === "submitted") {
        attempt.phase = "manual";
        this.installReceipt = undefined;
        this.installTarget = undefined;
      }
      const uncertain = ["submitted", "acknowledged", "verified"].includes(attempt.phase);
      this.state = waitingForHooks ? "checking" : uncertain ? "reload_required"
        : error?.code === -32601 || attempt.attempts >= 5 ? "manual_required" : "checking";
      this.issue = waitingForHooks ? "query_failed" : uncertain ? "install_uncertain"
        : error?.code === -32601 ? "host_unsupported" : "query_failed";
      if (!uncertain) attempt.phase = this.state === "manual_required" ? "manual" : "retry";
      // Reading trust state has no side effect. A temporary hook-load failure
      // must not exhaust the install budget or require a user confirmation.
      if (waitingForHooks && !submitted) attempt.attempts = Math.max(0, attempt.attempts - 1);
      attempt.issue = this.issue;
      attempt.nextAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.max(0, attempt.attempts - 1));
      try { this.save(attempt); }
      catch { this.state = "manual_required"; this.issue = "journal_unavailable"; }
    }
    await this.publish(send, token);
  }

  save(attempt) {
    if (!this.isOwner()) throw new Error("lost leadership");
    this.journal.save(attempt);
  }

  async reviewInstalledHooks(client, attempt, target) {
    if (!this.sourceMigrationEnabled) return true;
    this.handoffIdentity = undefined;
    let result;
    try { result = await client.request("hooks/list", {}, 15_000); }
    catch (error) { throw error?.code === -32601 ? error : unavailableHookState(); }
    if (!Array.isArray(result?.data)) throw unavailableHookState();
    // A failed/partial native load is not a receipt that no review is needed.
    // Retry automatically without granting trust or adopting new declarations.
    if (result.data.some(entry => !Array.isArray(entry?.hooks)
        || (entry.errors != null && (!Array.isArray(entry.errors) || entry.errors.length)))) {
      throw unavailableHookState();
    }
    const ownHooks = result.data.flatMap(entry => entry.hooks)
      .filter(hook => hook.pluginId === `${PLUGIN_NAME}@pinland`);
    const root = path.resolve(path.dirname(target.marketplace_path), "../..", "plugins", PLUGIN_NAME);
    const declarations = this.readIdentity(root).declarations;
    if (declarations[2] != null && ownHooks.length === 0) {
      throw unavailableHookState();
    }
    const hooks = ownHooks.filter(hook => hook.enabled !== false);
    if (hooks.some(hook => !["trusted", "managed", "untrusted", "modified"].includes(hook.trustStatus))) {
      throw unavailableHookState();
    }
    if (hooks.some(hook => ["untrusted", "modified"].includes(hook.trustStatus))) {
      this.state = "manual_required";
      this.issue = "review_required";
      attempt.issue = "review_required";
      if (!["submitted", "acknowledged", "verified"].includes(attempt.phase)) attempt.phase = "manual";
      attempt.nextAt = this.now() + 30_000;
      this.save(attempt);
      return false;
    }
    if (attempt.issue === "review_required" && !attempt.needsAppAuth) attempt.issue = undefined;
    // The native install/read and hook trust receipts authorize this package's
    // declarations. Cache handoff still verifies an exact match against them.
    this.handoffIdentity = { ...this.identity, declarations };
    return true;
  }

  async handoff(attempt, target) {
    if (!this.isOwner() || this.hasOwnedTasks()) return;
    const installed = this.installedForHandoff(this.handoffIdentity || this.identity, target.version);
    if (!installed) return;
    this.installedVersion = installed.version;
    if ((attempt.handoffs ?? 0) >= 3) return;
    attempt.handoffs = (attempt.handoffs ?? 0) + 1;
    this.save(attempt);
    await this.startCompanion(installed);
  }

  async publish(send, token) {
    if (this.isOwner()) return send("/v1/plugin/status", token, this.report());
  }
}
