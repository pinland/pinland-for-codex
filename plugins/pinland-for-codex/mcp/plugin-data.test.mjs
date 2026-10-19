import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  legacyPluginDataDirectory,
  migrateLegacyPluginData,
  previousPluginDataDirectory,
  resolvePluginDataDirectory
} from "./plugin-data.mjs";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-data-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("plugin data uses explicit, Codex-home, then home fallback paths", () => {
  assert.equal(resolvePluginDataDirectory({
    PLUGIN_DATA: "/private/plugin-state",
    CODEX_HOME: "/private/codex",
    HOME: "/Users/example"
  }), "/private/plugin-state");
  assert.equal(resolvePluginDataDirectory({
    CODEX_HOME: "/private/codex",
    HOME: "/Users/example"
  }), "/private/codex/plugin-data/pinland-for-codex");
  assert.equal(resolvePluginDataDirectory({
    HOME: "/Users/example"
  }), "/Users/example/.codex/plugin-data/pinland-for-codex");
  assert.equal(legacyPluginDataDirectory({
    temporaryDirectory: "/private/tmp",
    uid: 501
  }), "/private/tmp/pinland-for-codex-501");
  assert.equal(previousPluginDataDirectory({
    CODEX_HOME: "/private/codex",
    HOME: "/Users/example"
  }), "/private/codex/plugin-data/pinland-for-codex");
});

test("marketplace data adopts a proven pairing from the previous Codex path", (t) => {
  const root = temporaryDirectory(t);
  const codexHome = path.join(root, "codex");
  const previousDir = path.join(codexHome, "plugin-data", "pinland-for-codex");
  const dataDir = path.join(codexHome, "plugins", "data", "pinland-for-codex-personal");
  fs.mkdirSync(previousDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const previousToken = "ab".repeat(32);
  const unusedNewToken = "cd".repeat(32);
  fs.writeFileSync(path.join(previousDir, "bridge-token"), previousToken, { mode: 0o600 });
  fs.writeFileSync(path.join(previousDir, "paired"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "bridge-token"), unusedNewToken, { mode: 0o600 });

  migrateLegacyPluginData(dataDir, {
    environment: {
      PLUGIN_DATA: dataDir,
      CODEX_HOME: codexHome,
      HOME: root
    },
    temporaryDirectory: path.join(root, "tmp"),
    uid: process.getuid?.()
  });

  assert.equal(fs.readFileSync(path.join(dataDir, "bridge-token"), "utf8"), previousToken);
  assert.equal(fs.readFileSync(path.join(dataDir, "paired"), "utf8"), "");
  assert.equal(fs.statSync(path.join(dataDir, "bridge-token")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir, "paired")).mode & 0o777, 0o600);
});

test("invocations without PLUGIN_DATA reuse the securely paired native directory", t => {
  const root = temporaryDirectory(t);
  const codexHome = path.join(root, "codex");
  const native = path.join(codexHome, "plugins/data/pinland-for-codex-pinland");
  const legacy = path.join(codexHome, "plugin-data/pinland-for-codex");
  const env = { CODEX_HOME: codexHome, HOME: root };
  fs.mkdirSync(native, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(native, "bridge-token"), "ab".repeat(32), { mode: 0o600 });
  assert.equal(resolvePluginDataDirectory(env), legacy, "an unpaired directory cannot recreate a connection");
  fs.writeFileSync(path.join(native, "paired"), "", { mode: 0o600 });
  assert.equal(resolvePluginDataDirectory(env), native);
  assert.equal(resolvePluginDataDirectory({ ...env, PLUGIN_DATA: "/explicit" }), "/explicit");
  fs.chmodSync(path.join(native, "bridge-token"), 0o644);
  assert.equal(resolvePluginDataDirectory(env), legacy, "unsafe credentials cannot redirect a daemon");
  fs.chmodSync(path.join(native, "bridge-token"), 0o600);
  const alias = native + ".actual";
  fs.renameSync(native, alias);
  fs.symlinkSync(alias, native);
  assert.equal(resolvePluginDataDirectory(env), legacy);
});

test("an existing marketplace pairing is never replaced by previous data", (t) => {
  const root = temporaryDirectory(t);
  const codexHome = path.join(root, "codex");
  const previousDir = path.join(codexHome, "plugin-data", "pinland-for-codex");
  const dataDir = path.join(codexHome, "plugins", "data", "pinland-for-codex-personal");
  fs.mkdirSync(previousDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const previousToken = "ab".repeat(32);
  const currentToken = "cd".repeat(32);
  fs.writeFileSync(path.join(previousDir, "bridge-token"), previousToken, { mode: 0o600 });
  fs.writeFileSync(path.join(previousDir, "paired"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "bridge-token"), currentToken, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "paired"), "", { mode: 0o600 });

  migrateLegacyPluginData(dataDir, {
    environment: { CODEX_HOME: codexHome, HOME: root },
    temporaryDirectory: path.join(root, "tmp"),
    uid: process.getuid?.()
  });

  assert.equal(fs.readFileSync(path.join(dataDir, "bridge-token"), "utf8"), currentToken);
  assert.equal(fs.readFileSync(path.join(dataDir, "paired"), "utf8"), "");
});

test("valid legacy pairing and pin metadata migrate once with strict permissions", (t) => {
  const root = temporaryDirectory(t);
  const legacyDir = path.join(root, "legacy");
  const dataDir = path.join(root, "codex", "plugin-data", "pinland-for-codex");
  fs.mkdirSync(legacyDir, { mode: 0o700 });
  const token = "ab".repeat(32);
  const sourceID = "9eaa6a58-4db3-4ba2-91d0-3acb99d0ecf5";
  fs.writeFileSync(path.join(legacyDir, "bridge-token"), token, { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "paired"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "pins-revision"), "1750000000000000", { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "pins-source-id"), sourceID, { mode: 0o600 });

  migrateLegacyPluginData(dataDir, { legacyDir });

  assert.equal(fs.readFileSync(path.join(dataDir, "bridge-token"), "utf8"), token);
  assert.equal(fs.readFileSync(path.join(dataDir, "paired"), "utf8"), "");
  assert.equal(
    fs.readFileSync(path.join(dataDir, "pins-revision"), "utf8"),
    "1750000000000000"
  );
  assert.equal(fs.readFileSync(path.join(dataDir, "pins-source-id"), "utf8"), sourceID);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  for (const name of ["bridge-token", "paired", "pins-revision", "pins-source-id"]) {
    assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o777, 0o600);
  }
});

test("migration never overwrites new data or pairs a different destination token", (t) => {
  const root = temporaryDirectory(t);
  const legacyDir = path.join(root, "legacy");
  const dataDir = path.join(root, "current");
  fs.mkdirSync(legacyDir, { mode: 0o700 });
  fs.mkdirSync(dataDir, { mode: 0o755 });
  const legacyToken = "ab".repeat(32);
  const currentToken = "cd".repeat(32);
  fs.writeFileSync(path.join(legacyDir, "bridge-token"), legacyToken, { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "paired"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "pins-revision"), "123", { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "bridge-token"), currentToken, { mode: 0o644 });
  fs.writeFileSync(path.join(dataDir, "pins-revision"), "456", { mode: 0o644 });

  migrateLegacyPluginData(dataDir, { legacyDir });

  assert.equal(fs.readFileSync(path.join(dataDir, "bridge-token"), "utf8"), currentToken);
  assert.equal(fs.readFileSync(path.join(dataDir, "pins-revision"), "utf8"), "456");
  assert.equal(fs.existsSync(path.join(dataDir, "paired")), false);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, "bridge-token")).mode & 0o777, 0o600);
});

test("an insecure legacy directory is ignored", (t) => {
  const root = temporaryDirectory(t);
  const legacyDir = path.join(root, "legacy");
  const dataDir = path.join(root, "current");
  fs.mkdirSync(legacyDir, { mode: 0o755 });
  fs.chmodSync(legacyDir, 0o755);
  fs.writeFileSync(path.join(legacyDir, "bridge-token"), "ab".repeat(32));

  migrateLegacyPluginData(dataDir, { legacyDir });

  assert.equal(fs.existsSync(path.join(dataDir, "bridge-token")), false);
});
