import assert from "node:assert/strict";
import test from "node:test";
import { CodexExecutableResolver, executableCandidates } from "./codex-executable.mjs";

const packaged = root => `${root}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
function fixture(env = {}, appPath) {
  const files = new Map(), verifications = [], inspections = [];
  let now = 100_000;
  const resolver = new CodexExecutableResolver({ env, home: "/Users/test", now: () => now,
    inspect: file => {
      inspections.push(file);
      if (!files.has(file)) throw Object.assign(Error("private path"), { code: "ENOENT" });
      return { real: file, stamp: files.get(file) };
    },
    verify: async file => { verifications.push(file); return !file.includes("untrusted"); }
  });
  resolver.setApplicationPath(appPath);
  return { resolver, files, verifications, inspections, advance: () => now += 16_000 };
}

test("new packaged CLI and legacy layouts work without extra configuration", async () => {
  for (const file of [packaged("/Applications/ChatGPT.app"), "/Applications/Codex.app/Contents/Resources/codex"]) {
    const f = fixture(); f.files.set(file, "1");
    assert.equal(await f.resolver.resolve(), file);
    assert.equal(f.resolver.report("ready").source, "standard_app");
  }
});

test("host node and resource locations survive app moves and renames, preferring the active host", async () => {
  for (const env of [
    { CODEX_MCP_NODE_PATH: "/Custom/My Agent.app/Contents/Resources/cua_node/bin/node" },
    { CODEX_ELECTRON_RESOURCES_PATH: "/Custom/My Agent.app/Contents/Resources" },
    { CODEX_CLI_PATH: "/Custom/My Agent.app/Contents/Resources/codex-cli/bin/codex" }
  ]) {
    const f = fixture(env); const actual = packaged("/Custom/My Agent.app");
    f.files.set(actual, "1"); f.files.set(packaged("/Applications/ChatGPT.app"), "2");
    assert.equal(await f.resolver.resolve(), actual);
    assert.equal(f.verifications.length, 1);
  }
});

test("registered app hint and user Applications are automatic bounded fallbacks", async () => {
  for (const actual of [packaged("/Moved/Agent.app"), packaged("/Users/test/Applications/Codex.app")]) {
    const f = fixture({}, "/Moved/Agent.app"); f.files.set(actual, "1");
    assert.equal(await f.resolver.resolve(), actual);
  }
  assert.ok(executableCandidates({ env: { PATH: "/private" }, home: "/Users/test", appPath: "relative.app" })
    .every(c => !c.file.includes("relative") && !c.file.includes("/private")));
});

test("cached executable skips signature verification, replacement and reconnect invalidate it", async () => {
  const f = fixture(); const file = packaged("/Applications/ChatGPT.app"); f.files.set(file, "1");
  await f.resolver.resolve(); await f.resolver.resolve();
  assert.equal(f.verifications.length, 1);
  f.files.set(file, "2"); await f.resolver.resolve();
  assert.equal(f.verifications.length, 2);
  f.resolver.reset(); await f.resolver.resolve();
  assert.equal(f.verifications.length, 3);
});

test("untrusted executables never run, failures are throttled and diagnostic reports contain no paths", async () => {
  const f = fixture({ CODEX_CLI_PATH: "/private/untrusted/codex" }); f.files.set("/private/untrusted/codex", "1");
  assert.equal(await f.resolver.resolve(), undefined);
  const count = f.inspections.length; await f.resolver.resolve();
  assert.equal(f.inspections.length, count);
  f.advance(); await f.resolver.resolve(); assert.ok(f.inspections.length > count);
  const report = f.resolver.report("executable_missing");
  assert.equal(report.checks[0].result, "untrusted");
  assert.ok(!JSON.stringify(report).includes("/private"));
  assert.ok(report.checks.length <= 16);
});
