import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[1-9][0-9]{0,15}$/;

export function resolvePluginDataDirectory(environment = process.env, options = {}) {
  if (typeof environment.PLUGIN_DATA === "string"
      && environment.PLUGIN_DATA.trim()) {
    return environment.PLUGIN_DATA;
  }
  const homeDirectory = typeof environment.HOME === "string"
    && environment.HOME.trim()
    ? environment.HOME
    : (options.homeDirectory || os.homedir());
  const codexHome = typeof environment.CODEX_HOME === "string"
    && environment.CODEX_HOME.trim()
    ? environment.CODEX_HOME
    : path.join(homeDirectory, ".codex");
  return path.join(codexHome, "plugin-data", "pinland-for-codex");
}

export function legacyPluginDataDirectory(options = {}) {
  const temporaryDirectory = options.temporaryDirectory || os.tmpdir();
  const uid = options.uid ?? process.getuid?.() ?? "user";
  return path.join(temporaryDirectory, `pinland-for-codex-${uid}`);
}

export function previousPluginDataDirectory(environment = process.env, options = {}) {
  const homeDirectory = typeof environment.HOME === "string"
    && environment.HOME.trim()
    ? environment.HOME
    : (options.homeDirectory || os.homedir());
  const codexHome = typeof environment.CODEX_HOME === "string"
    && environment.CODEX_HOME.trim()
    ? environment.CODEX_HOME
    : path.join(homeDirectory, ".codex");
  return path.join(codexHome, "plugin-data", "pinland-for-codex");
}

export function preparePluginDataDirectory(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // Best effort on filesystems that do not expose POSIX permissions.
  }
}

function readSecureLegacyFile(legacyDir, name, maximumBytes) {
  const filePath = path.join(legacyDir, name);
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
      return undefined;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function writeIfMissing(filePath, value) {
  try {
    fs.writeFileSync(filePath, value, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function tightenRecognizedFilePermissions(dataDir) {
  for (const name of ["bridge-token", "paired", "pins-revision", "pins-source-id"]) {
    const filePath = path.join(dataDir, name);
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isFile() && !stats.isSymbolicLink()) fs.chmodSync(filePath, 0o600);
    } catch {
      // Missing or unsupported files are left untouched.
    }
  }
}

function migrateLegacyDirectory(dataDir, legacyDir, options = {}) {
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return;
  let legacyStats;
  try {
    legacyStats = fs.lstatSync(legacyDir);
  } catch {
    return;
  }
  const currentUID = options.uid ?? process.getuid?.();
  if (!legacyStats.isDirectory()
      || legacyStats.isSymbolicLink()
      || (Number.isInteger(currentUID) && legacyStats.uid !== currentUID)
      || (legacyStats.mode & 0o077) !== 0) {
    return;
  }

  const legacyToken = readSecureLegacyFile(legacyDir, "bridge-token", 1_024)?.trim();
  const pairedMarker = readSecureLegacyFile(legacyDir, "paired", 16);
  const destinationPaired = readSecureLegacyFile(dataDir, "paired", 16) !== undefined;
  const mayAdoptPairedToken = options.adoptPairedToken === true
    && !destinationPaired
    && pairedMarker !== undefined
    && TOKEN_PATTERN.test(legacyToken || "");
  if (mayAdoptPairedToken) {
    // Codex's marketplace-backed plugin data path replaced the earlier
    // ~/.codex/plugin-data location. A proven pairing in that secure,
    // same-user directory should survive the move even when the new host
    // eagerly generated an unused token before migration ran.
    try {
      fs.writeFileSync(path.join(dataDir, "bridge-token"), legacyToken, { mode: 0o600 });
      fs.chmodSync(path.join(dataDir, "bridge-token"), 0o600);
    } catch {
      // A partial migration must never claim the destination is paired.
      return;
    }
  } else if (TOKEN_PATTERN.test(legacyToken || "")) {
    writeIfMissing(path.join(dataDir, "bridge-token"), legacyToken);
  }

  const legacyRevision = readSecureLegacyFile(legacyDir, "pins-revision", 128)?.trim();
  if (REVISION_PATTERN.test(legacyRevision || "")
      && Number.isSafeInteger(Number(legacyRevision))) {
    writeIfMissing(path.join(dataDir, "pins-revision"), legacyRevision);
  }

  const legacySourceID = readSecureLegacyFile(legacyDir, "pins-source-id", 128)?.trim();
  if (UUID_PATTERN.test(legacySourceID || "")) {
    writeIfMissing(path.join(dataDir, "pins-source-id"), legacySourceID);
  }

  let destinationToken;
  try {
    destinationToken = fs.readFileSync(path.join(dataDir, "bridge-token"), "utf8").trim();
  } catch {
    // A pairing marker without its matching secret must never be migrated.
  }
  if (pairedMarker !== undefined
      && TOKEN_PATTERN.test(legacyToken || "")
      && destinationToken === legacyToken) {
    writeIfMissing(path.join(dataDir, "paired"), "");
  }
}

export function migrateLegacyPluginData(dataDir, options = {}) {
  preparePluginDataDirectory(dataDir);
  if (options.legacyDir) {
    migrateLegacyDirectory(dataDir, options.legacyDir, options);
  } else {
    const environment = options.environment || process.env;
    migrateLegacyDirectory(
      dataDir,
      previousPluginDataDirectory(environment, options),
      { ...options, adoptPairedToken: true }
    );
    migrateLegacyDirectory(dataDir, legacyPluginDataDirectory(options), options);
  }
  tightenRecognizedFilePermissions(dataDir);
}
