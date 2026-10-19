import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pluginIdentity } from "./plugin-update.mjs";

// Only the already trusted companion may start its replacement, and only from
// its own native cache family after native installation and eligibility checks.
// Never execute the marketplace/source bundle, infer trust, or edit the cache.
export function installedPluginForHandoff(identity, version) {
  const family = identity.cacheFamily;
  if (!family || path.basename(family) !== "pinland-for-codex"
      || path.basename(path.dirname(family)) !== "pinland"
      || path.basename(path.dirname(path.dirname(family))) !== "cache") return undefined;
  for (const directory of [version, "local"]) {
    try {
      const root = path.join(family, directory);
      if (fs.realpathSync(root) !== root) continue;
      const installed = pluginIdentity(root);
      if (installed.version !== version
          || JSON.stringify(installed.declarations) !== JSON.stringify(identity.declarations)) continue;
      const entry = path.join(root, "mcp/pins-sync-server.mjs");
      const stat = fs.lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576 || fs.realpathSync(entry) !== entry) continue;
      return { version: installed.version, entry };
    } catch { /* Cache replacement can be in progress. Keep the old process. */ }
  }
  return undefined;
}

export function startInstalledCompanion(installed, options = {}) {
  return new Promise((resolve) => {
    const launch = options.spawnProcess || spawn;
    let child;
    const timer = setTimeout(() => { child?.kill(); resolve(false); }, 5_000);
    const finish = result => { clearTimeout(timer); resolve(result); };
    try {
      child = launch(process.execPath, [installed.entry, "--ensure-daemon"], {
        stdio: "ignore", env: options.environment || process.env
      });
      child.once("error", () => finish(false));
      child.once("exit", code => finish(code === 0));
    } catch { finish(false); }
  });
}
