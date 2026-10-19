import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const OPENAI_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';
const validPath = value => typeof value === "string" && value.length <= 4096
  && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

function resourceRoot(value) {
  if (!validPath(value)) return undefined;
  const match = path.normalize(value).match(/^(.*\.app\/Contents\/Resources)(?:\/|$)/);
  return match?.[1];
}

// Bounded known layouts, no recursive disk search, PATH execution or config
// edits. Prefer the current host over another independently installed copy.
export function executableCandidates({ env = process.env, home = os.homedir(), appPath } = {}) {
  const candidates = [];
  const add = (file, source, layout) => {
    if (validPath(file) && !candidates.some(c => c.file === path.normalize(file))) {
      candidates.push({ file: path.normalize(file), source, layout });
    }
  };
  const resources = (root, source) => {
    if (!validPath(root)) return;
    // Current desktop packages use a signed nested app. Invoke the native
    // executable, not an unverified shell wrapper from codex-cli/bin.
    add(path.join(root, "codex-cli/CodexCLI.app/Contents/MacOS/codex"), source, "packaged");
    add(path.join(root, "codex"), source, "legacy");
  };
  if (validPath(env.CODEX_CLI_PATH)) {
    if (env.CODEX_CLI_PATH.endsWith("/codex-cli/bin/codex")) {
      resources(resourceRoot(env.CODEX_CLI_PATH), "host_cli");
    } else {
      add(env.CODEX_CLI_PATH, "host_cli", "explicit");
      resources(resourceRoot(env.CODEX_CLI_PATH), "host_cli");
    }
  }
  resources(resourceRoot(env.CODEX_ELECTRON_RESOURCES_PATH), "host_resources");
  resources(resourceRoot(env.CODEX_MCP_NODE_PATH), "host_node");
  if (validPath(appPath) && appPath.endsWith(".app")) resources(path.join(appPath, "Contents/Resources"), "bridge_app");
  for (const name of ["ChatGPT.app", "Codex.app"]) {
    resources(`/Applications/${name}/Contents/Resources`, "standard_app");
    if (validPath(home)) resources(path.join(home, "Applications", name, "Contents/Resources"), "user_app");
  }
  return candidates;
}

async function verifyExecutable(file) {
  const options = { timeout: 5000, maxBuffer: 16_384 };
  try {
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", OPENAI_REQUIREMENT, file], options);
    const { stderr } = await run("/usr/bin/codesign", ["--display", "--verbose=2", file], options);
    return /^Identifier=codex(?:[-.][A-Za-z0-9_.-]+)?$/m.test(stderr);
  } catch { return false; }
}

function fingerprint(file) {
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error("not_file");
  fs.accessSync(real, fs.constants.X_OK);
  return { real, stamp: `${real}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
}

export class CodexExecutableResolver {
  constructor({ env = process.env, home = os.homedir(), verify = verifyExecutable, inspect = fingerprint, now = Date.now } = {}) {
    Object.assign(this, { env, home, verify, inspect, now });
    this.reset();
  }

  reset() { this.cached = undefined; this.lastFailure = -Infinity; this.checks = []; }

  setApplicationPath(value) {
    const next = validPath(value) && value.endsWith(".app") ? value : undefined;
    if (next !== this.appPath) { this.appPath = next; this.reset(); }
  }

  async resolve() {
    if (this.cached) {
      try {
        if (this.inspect(this.cached.file).stamp === this.cached.stamp) return this.cached.file;
      } catch { /* A moved/replaced app invalidates the cached executable. */ }
      this.reset();
    }
    if (this.now() - this.lastFailure < 15_000) return undefined;
    this.checks = [];
    for (const candidate of executableCandidates(this)) {
      const { source, layout } = candidate;
      let inspected;
      try { inspected = this.inspect(candidate.file); }
      catch (error) {
        this.checks.push({ source, layout, result: error.code === "EACCES" ? "not_executable" : "missing" });
        continue;
      }
      if (!await this.verify(inspected.real)) {
        this.checks.push({ source, layout, result: "untrusted" });
        continue;
      }
      // Never reuse a signature result if an update replaced the file meanwhile.
      try { if (this.inspect(candidate.file).stamp !== inspected.stamp) continue; }
      catch { continue; }
      this.checks.push({ source, layout, result: "ready" });
      this.cached = { ...candidate, ...inspected };
      return candidate.file;
    }
    this.lastFailure = this.now();
    return undefined;
  }

  report(state) {
    return { state, ...(this.cached ? { source: this.cached.source, layout: this.cached.layout } : {}),
      checks: this.checks.slice(0, 16) };
  }
}
