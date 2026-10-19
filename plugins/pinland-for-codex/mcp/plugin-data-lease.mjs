import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pluginDataHasSamePairing } from "./plugin-data.mjs";
import { comparePluginVersions } from "./plugin-update.mjs";

const LEASES = new Set(["native-pins-sync-daemon", "native-pins-sync-leader"]);
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (!process.getuid || stat.uid === process.getuid());
}
function ownerAt(directory) {
  if (!privateDirectory(directory)) throw Error("unsafe lease directory");
  const file = path.join(directory, "owner.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe lease owner");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Only our own private coordination records are written. A matching proven
// pairing is required before an old-directory daemon can be displaced. Its
// normal lease-loss handler stops syncing, then drains any task owners; no
// process is killed and Codex configuration/cache/trust are never modified.
export function mirrorLegacyPluginLease(dataDir, legacyDir, lease) {
  let temporary;
  try {
    if (!LEASES.has(lease) || fs.realpathSync(dataDir) === fs.realpathSync(legacyDir)
        || !pluginDataHasSamePairing(dataDir, legacyDir)) return false;
    const current = ownerAt(path.join(dataDir, lease));
    if (current.pid !== process.pid || !Number.isSafeInteger(current.protocol_version)
        || current.protocol_version <= 0 || !/^[0-9a-f-]{36}$/i.test(current.token ?? "")
        || comparePluginVersions(current.plugin_version, current.plugin_version) !== 0) return false;
    const directory = path.join(legacyDir, lease);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!privateDirectory(directory)) return false;
    let previous;
    try { previous = ownerAt(directory); }
    catch (error) { if (error.code !== "ENOENT") return false; }
    if (previous?.protocol_version > current.protocol_version
        || comparePluginVersions(previous?.plugin_version, current.plugin_version) === 1) return false;
    if (previous?.token === current.token && previous?.pid === current.pid) {
      const now = new Date();
      fs.utimesSync(path.join(directory, "owner.json"), now, now);
      return true;
    }
    temporary = path.join(directory, `owner.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ protocol_version: current.protocol_version,
      plugin_version: current.plugin_version, token: current.token, pid: current.pid }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, path.join(directory, "owner.json"));
    return true;
  } catch { return false; }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}
