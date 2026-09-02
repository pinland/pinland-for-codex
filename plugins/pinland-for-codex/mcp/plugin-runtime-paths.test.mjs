import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hooksConfig = JSON.parse(readFileSync(path.join(pluginRoot, "hooks/hooks.json"), "utf8"));
const mcpConfig = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));

function makeCachedPlugin(root, marker) {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "mcp"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/pinland-hook.zsh"),
    `#!/bin/zsh\n/usr/bin/printf '%s\\n%s\\n%s\\n' \"$PLUGIN_ROOT\" \"$1\" '${marker}' > \"$PINLAND_TEST_CAPTURE\"\n`
  );
  writeFileSync(
    path.join(root, "scripts/launch-pinland-mcp"),
    `#!/bin/zsh\n/usr/bin/printf '%s\\n%s\\n%s\\n' \"$PLUGIN_ROOT\" \"$1\" '${marker}' > \"$PINLAND_TEST_CAPTURE\"\n`
  );
  chmodSync(path.join(root, "scripts/launch-pinland-mcp"), 0o755);
  writeFileSync(path.join(root, "mcp/pins-sync-server.mjs"), "// fixture\n");
}

function makeUpgradeFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "pinland-plugin-paths-"));
  const codexHome = path.join(home, ".codex");
  const versionParent = path.join(
    codexHome,
    "plugins/cache/personal/pinland-for-codex"
  );
  const oldRoot = path.join(versionParent, "0.1.0+codex.old");
  const currentRoot = path.join(versionParent, "0.1.0+codex.current");
  makeCachedPlugin(oldRoot, "old");
  makeCachedPlugin(currentRoot, "current");
  utimesSync(oldRoot, new Date(1_000), new Date(1_000));
  utimesSync(currentRoot, new Date(2_000), new Date(2_000));
  return { codexHome, currentRoot, oldRoot, home };
}

test("every hook resolves the newest sibling cache before launching", () => {
  const { codexHome, currentRoot, oldRoot, home } = makeUpgradeFixture();
  const capture = path.join(home, "hook-capture");
  const commands = Object.values(hooksConfig.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command))
  );

  assert.equal(commands.length, 7);
  for (const command of commands) {
    const result = spawnSync("/bin/zsh", ["-c", command], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PINLAND_TEST_CAPTURE: capture,
        PLUGIN_ROOT: oldRoot
      }
    });
    assert.equal(result.status, 0, result.stderr.toString());
    const [resolvedRoot, mode, marker] = readFileSync(capture, "utf8").trim().split("\n");
    assert.equal(resolvedRoot, currentRoot);
    assert.match(mode, /^(lifecycle|manual-pin)$/);
    assert.equal(marker, "current");
  }
});

test("MCP launcher survives an old cached cwd and root", () => {
  const { codexHome, currentRoot, oldRoot, home } = makeUpgradeFixture();
  const capture = path.join(home, "mcp-capture");
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["pinland"]);
  const server = mcpConfig.mcpServers.pinland;

  assert.equal(server.command, "/bin/zsh");
  assert.equal(Object.hasOwn(server, "cwd"), false);
  const result = spawnSync(server.command, server.args, {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PINLAND_TEST_CAPTURE: capture,
      PLUGIN_ROOT: oldRoot
    }
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const [resolvedRoot, serverPath, marker] = readFileSync(capture, "utf8").trim().split("\n");
  assert.equal(resolvedRoot, currentRoot);
  assert.equal(serverPath, path.join(currentRoot, "mcp/pins-sync-server.mjs"));
  assert.equal(marker, "current");
});

test("MCP accepts the host-provided Codex Desktop task-messaging pipe", () => {
  const server = mcpConfig.mcpServers.pinland;
  assert.equal(server.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH"), true);
});
