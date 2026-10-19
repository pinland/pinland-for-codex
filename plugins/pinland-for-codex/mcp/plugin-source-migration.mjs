import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLUGIN = "pinland-for-codex";
const ID = `${PLUGIN}@pinland`;
const SUFFIX = "/Contents/Resources/Integrations/.agents/plugins/marketplace.json";
// App Store deliveries are re-signed by Apple, so the leaf certificate's OU
// is no longer the publisher's team. Keep the Apple anchor and exact bundle
// identity; the Store branch must also prove the publisher's signed entitlement.
export const PINLAND_APP_REQUIREMENT = '=anchor apple generic and identifier "com.zeenzhao.pinland" and (certificate leaf[subject.OU] = "KDG9SYMY48" or (certificate leaf[field.1.2.840.113635.100.6.1.9] exists and entitlement["com.apple.developer.team-identifier"] = "KDG9SYMY48"))';

export function validMarketplacePath(value) {
  return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value)
    && !/[\x00-\x1f\x7f]/.test(value) && path.normalize(value).endsWith("/.agents/plugins/marketplace.json");
}

export function marketplaceRoot(value) {
  return path.resolve(path.dirname(value), "../..");
}

export function sourceRecordIssue(marketplace, plugin) {
  if (marketplace?.name !== "pinland" || !validMarketplacePath(marketplace?.path)
      || plugin?.id !== ID || plugin?.name !== PLUGIN) return "source_changed";
  if (plugin.installed === false) return "not_installed";
  if (plugin.availability === "DISABLED_BY_ADMIN" || plugin.installPolicy === "NOT_AVAILABLE") return "admin_blocked";
  if (plugin.enabled === false) return "disabled";
  if (plugin.mustShowInstallationInterstitial === true) return "review_required";
  if (plugin.installed !== true || plugin.enabled !== true || plugin.source?.type !== "local"
      || plugin.source.path !== path.join(marketplaceRoot(marketplace.path), "plugins", PLUGIN)
      || !["AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(plugin.installPolicy)
      || (plugin.availability != null && plugin.availability !== "AVAILABLE")) return "source_changed";
  return undefined;
}

function readJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error("invalid source");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sealedPluginTree(directory, budget = { remaining: 2048 }) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (--budget.remaining < 0 || entry.isSymbolicLink()) return false;
    if (entry.isDirectory()) {
      if (!sealedPluginTree(path.join(directory, entry.name), budget)) return false;
    } else if (!entry.isFile()) { return false; }
  }
  return true;
}

// The new source must be the sealed resources of the same signed Pinland app.
// A path change alone never authorizes replacing an arbitrary local/Git plugin.
export async function verifyPinlandMarketplace(target, options = {}) {
  if (!validMarketplacePath(target?.marketplace_path)) return false;
  const file = path.normalize(target.marketplace_path);
  if (!file.endsWith(SUFFIX)) return false;
  const app = file.slice(0, -SUFFIX.length);
  if (!app.endsWith(".app")) return false;
  try {
    const catalog = readJSON(file);
    if (catalog.name !== "pinland" || catalog.plugins?.length !== 1) return false;
    const plugin = catalog.plugins[0];
    if (plugin.name !== PLUGIN || plugin.source?.source !== "local"
        || path.resolve(marketplaceRoot(file), plugin.source.path ?? "")
          !== path.join(marketplaceRoot(file), "plugins", PLUGIN)) return false;
    const manifest = readJSON(path.join(marketplaceRoot(file), "plugins", PLUGIN, ".codex-plugin/plugin.json"));
    if (manifest.name !== PLUGIN || manifest.version !== target.version) return false;
    const realApp = fs.realpathSync(app);
    if (fs.realpathSync(marketplaceRoot(file)) !== path.join(realApp, "Contents/Resources/Integrations")
        || !sealedPluginTree(path.join(marketplaceRoot(file), "plugins", PLUGIN))) return false;
    const inspect = options.verifySignature || (async appPath => {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", PINLAND_APP_REQUIREMENT, appPath],
        { timeout: 10_000, maxBuffer: 16_384 });
      return true;
    });
    return await inspect(app) === true;
  } catch { return false; }
}

function matches(installed) {
  return installed.marketplaces.flatMap(marketplace => (marketplace.plugins || [])
    .filter(plugin => plugin.name === PLUGIN || plugin.id === ID)
    .map(plugin => ({ marketplace, plugin })));
}

function isOwnAppSource(file) {
  return validMarketplacePath(file) && file.endsWith(SUFFIX) && file.slice(0, -SUFFIX.length).endsWith(".app");
}

// Registration and package installation are different native operations. Merely
// installing from a new path leaves Codex tracking the old marketplace forever.
// Only our single-plugin catalog is relocated; install/enabled/trust state stays
// in Codex. Every interrupted phase is reconciled from Codex before retrying.
export async function migratePluginSource({ client, installed, target, verifyTarget = verifyPinlandMarketplace,
  validateDetail, attempt, save, isOwner = () => true, onProgress = async () => {} }) {
  const candidates = matches(installed);
  if (candidates.length > 1) return "source_changed";
  const old = candidates[0];
  if (old) {
    const issue = sourceRecordIssue(old.marketplace, old.plugin);
    if (issue) return issue;
    if (old.marketplace.plugins.some(plugin => plugin.id !== ID || plugin.name !== PLUGIN)) return "source_changed";
  }
  // An App move can make the previous catalog unreadable. Only a single own-App
  // load error (or our durable interrupted migration) can use that recovery path.
  // A previously disabled one-shot recovery component can leave a stale
  // catalog path after an App move. It cannot prevent migration of the main
  // plugin, and its unrelated registration is never changed by this path.
  const errors = (installed.marketplaceLoadErrors || []).filter(error =>
    !error.marketplacePath?.endsWith("/Contents/Resources/Integrations/Recovery/.agents/plugins/marketplace.json"));
  if (errors.length && !old && !attempt.sourceMigration
      && !(errors.length === 1 && isOwnAppSource(errors[0].marketplacePath))) throw new Error("marketplace unavailable");
  if (!await verifyTarget(target)) return "source_changed";
  const detail = (await client.request("plugin/read", {
    pluginName: PLUGIN, marketplacePath: target.marketplace_path
  }, 15_000))?.plugin;
  const issue = validateDetail(detail);
  if (issue) return issue;
  if (!isOwner()) throw new Error("lost leadership");
  const previousPath = old?.marketplace.path ?? attempt.sourceMigration?.from ?? errors[0]?.marketplacePath;
  attempt.sourceMigration = { to: target.marketplace_path,
    ...(previousPath ? { from: previousPath } : {}), phase: "prepared" };
  save();
  await onProgress("migrating");
  const ensureOwner = () => { if (!isOwner()) throw new Error("lost leadership"); };
  if (old && old.marketplace.path !== target.marketplace_path) {
    ensureOwner();
    await client.request("marketplace/remove", { marketplaceName: "pinland" }, 15_000);
    attempt.sourceMigration.phase = "detached";
    save();
  }
  ensureOwner();
  try {
    await client.request("marketplace/add", { source: marketplaceRoot(target.marketplace_path) }, 15_000);
  } catch (error) {
    // If an old App disappeared, discovery may omit its registered catalog.
    // Codex's exact same-name conflict is the evidence required to remove it.
    if (!old && previousPath && /marketplace 'pinland' is already added from a different source/.test(String(error?.message))) {
      ensureOwner();
      await client.request("marketplace/remove", { marketplaceName: "pinland" }, 15_000);
      attempt.sourceMigration.phase = "detached";
      save();
      ensureOwner();
      await client.request("marketplace/add", { source: marketplaceRoot(target.marketplace_path) }, 15_000);
    } else { throw error; }
  }
  ensureOwner();
  const confirmed = await client.request("plugin/installed", {}, 15_000);
  const active = matches(confirmed).find(entry => entry.marketplace.path === target.marketplace_path);
  if (!active || sourceRecordIssue(active.marketplace, active.plugin)) throw new Error("migration not confirmed");
  attempt.sourceMigration.phase = "registered";
  save();
  await onProgress("ready");
  return undefined;
}
