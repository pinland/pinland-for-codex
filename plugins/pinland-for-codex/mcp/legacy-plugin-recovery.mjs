import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PluginUpdateSync, pluginIdentity, comparePluginVersions } from "./plugin-update.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";
import { verifyPinlandMarketplace } from "./plugin-source-migration.mjs";
import { installedPluginForHandoff, startInstalledCompanion } from "./plugin-handoff.mjs";
import { pairedPluginToken, previousPluginDataDirectory } from "./plugin-data.mjs";
import { detachedDaemonEnvironment } from "./daemon-runtime-policy.mjs";

export const RECOVERY_PLUGIN_ID = "pinland-recovery@pinland-recovery";
export function mainPluginPairing(environment = process.env) {
  const home = environment.CODEX_HOME || path.join(environment.HOME || "", ".codex");
  if (!path.isAbsolute(home)) return undefined;
  const directories = [path.join(home, "plugins/data/pinland-for-codex-pinland"), previousPluginDataDirectory(environment)];
  for (const directory of directories) {
    const token = pairedPluginToken(directory);
    if (token) return { directory, token, cacheFamily: path.join(home, "plugins/cache/pinland/pinland-for-codex") };
  }
}

export function cachedMainIdentity(family, runningVersion, targetVersion) {
  family = fs.realpathSync(family);
  const values = fs.readdirSync(family).slice(0, 256).flatMap(name => {
    try {
      const root = path.join(family, name);
      if (fs.realpathSync(root) !== root) return [];
      const identity = pluginIdentity(root);
      return identity.cacheFamily === fs.realpathSync(family) ? [identity] : [];
    } catch { return []; }
  });
  values.sort((a, b) => comparePluginVersions(a.version, b.version) || 0);
  const newest = values.at(-1);
  if (targetVersion && comparePluginVersions(newest?.version, targetVersion) === 1) return newest;
  return values.find(value => value.version === runningVersion) || values[0];
}

// Runs only after Codex has reviewed and loaded the separate recovery plugin.
// Its receipts are not the main plugin's runtime receipts. The signed App still
// requires the real replacement's own versioned pin sync before declaring ready.
export class LegacyPluginRecovery {
  constructor({ client, send, identity, pairing, helperVersion, runtimeID, journal,
    now = Date.now, verifyTarget = verifyPinlandMarketplace, readIdentity = pluginIdentity,
    installedForHandoff = installedPluginForHandoff, startCompanion = startInstalledCompanion,
    environment = process.env, isOwner = () => true }) {
    Object.assign(this, { client, send, identity, pairing, helperVersion, runtimeID, now, verifyTarget, isOwner });
    this.journal = journal || new PluginUpdateJournal();
    this.sync = new PluginUpdateSync({ identity, protocolVersion: 37, runtimeID, journal: this.journal, now,
      sourceMigrationEnabled: true, verifyMigrationTarget: verifyTarget, readIdentity, installedForHandoff, isOwner,
      hasOwnedTasks: () => this.target?.active_tasks === true,
      startCompanion: installed => startCompanion(installed, { environment: detachedDaemonEnvironment({
        ...environment, PLUGIN_DATA: pairing.directory,
        PLUGIN_ROOT: path.resolve(path.dirname(installed.entry), "..")
      }) }) });
  }

  async report(state, issue) {
    const response = await this.send({ schema_version: 1, helper_version: this.helperVersion,
      recovery_id: this.runtimeID, state, ...(issue ? { issue } : {}) });
    if (response?.status !== 200) throw Error("bridge unavailable");
    this.target = response.json;
    return response;
  }

  async run() {
    if (this.complete || !this.isOwner()) return;
    await this.report("checking");
    if (!await this.verifyTarget(this.target)) {
      await this.report("blocked", "source_changed"); return;
    }
    if (this.target.main_ready === true) return this.finish();
    if (comparePluginVersions(this.identity.version, this.target.version) === 1) {
      await this.report("blocked", "update_failed"); return;
    }
    const send = async (route, token, report) => {
      let state = report.issue === "review_required" ? "review_required"
        : report.update_state === "manual_required" ? "blocked"
        : report.source_state === "migrating" ? "migrating" : "checking";
      return this.report(state, report.issue);
    };
    await this.sync.refresh(this.client, send, this.pairing.token, "recovery");
    if (this.target.main_ready === true) return this.finish();
    // The new files may already exist while an old daemon is still running.
    // Same-version migration itself deliberately avoids a reinstall/handoff;
    // this separately reviewed bootstrap may start that verified cached copy.
    if (this.sync.state === "current" && this.sync.sourceState === "ready" && !this.target.active_tasks) {
      const key = createHash("sha256").update(`${this.target.version}:${this.target.marketplace_path}`).digest("hex");
      await this.sync.handoff(this.journal.load(key), this.target);
    }
  }

  async finish() {
    if (!this.isOwner()) return;
    await this.report("complete");
    if (this.target.main_ready !== true) return;
    const installed = await this.client.request("plugin/installed", {}, 15_000);
    const own = installed?.marketplaces?.find(entry => entry.name === "pinland-recovery"
      && entry.path?.endsWith("/Contents/Resources/Integrations/Recovery/.agents/plugins/marketplace.json")
      && entry.plugins?.length === 1 && entry.plugins[0].id === RECOVERY_PLUGIN_ID
      && entry.plugins[0].source?.type === "local");
    if (!this.isOwner()) return;
    if (own) await this.client.request("marketplace/remove", { marketplaceName: "pinland-recovery" }, 15_000);
    // Disable only this one-shot component through Codex's native config API.
    // No trust grants, direct config edits, uninstall or main-plugin changes.
    const response = await this.client.request("config/value/write", {
      keyPath: `plugins."${RECOVERY_PLUGIN_ID}".enabled`, value: false, mergeStrategy: "replace"
    }, 15_000);
    if (response?.status !== "ok" && response?.status !== "okOverridden") throw Error("recovery disable not confirmed");
    const marketplacePath = this.target.recovery_marketplace_path || own?.path;
    if (!marketplacePath?.endsWith("/Contents/Resources/Integrations/Recovery/.agents/plugins/marketplace.json")) {
      throw Error("recovery catalog unavailable");
    }
    const detail = (await this.client.request("plugin/read", {
      pluginName: "pinland-recovery", marketplacePath
    }, 15_000))?.plugin?.summary;
    if (detail?.id !== RECOVERY_PLUGIN_ID || detail.enabled !== false) throw Error("recovery disable not effective");
    this.complete = true;
  }
}
