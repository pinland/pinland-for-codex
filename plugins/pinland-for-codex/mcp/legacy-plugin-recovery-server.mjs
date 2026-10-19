import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LegacyPluginRecovery, mainPluginPairing, cachedMainIdentity } from "./legacy-plugin-recovery.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { CodexExecutableResolver } from "./codex-executable.mjs";
import { PluginUpdateJournal } from "./plugin-update-journal.mjs";
import { preparePluginDataDirectory, pairedPluginToken, previousPluginDataDirectory } from "./plugin-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const family = path.dirname(root);
if (manifest.name !== "pinland-recovery" || path.basename(family) !== "pinland-recovery"
    || path.basename(path.dirname(family)) !== "pinland-recovery"
    || path.basename(path.dirname(path.dirname(family))) !== "cache" || fs.realpathSync(root) !== root) {
  throw Error("Recovery must be loaded from Codex's installed cache");
}
let stopped = false, initialized = false, client, runner, heartbeat;
const runtimeID = randomUUID();
const data = process.env.PLUGIN_DATA || path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"),
  "plugins/data/pinland-recovery-pinland-recovery");
preparePluginDataDirectory(data);
const lease = path.join(data, "recovery-owner");
const ownerPath = path.join(lease, "owner.json");
const readOwner = () => { try { return JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch { return undefined; } };
const ownsRecovery = () => !stopped && readOwner()?.token === runtimeID;
function acquireRecovery() {
  if (ownsRecovery()) return true;
  try { fs.mkdirSync(lease, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") return false;
    const stat = fs.lstatSync(lease);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return false;
    const owner = readOwner();
    let alive = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); alive = true; } catch {} }
    if (alive && Date.now() - fs.statSync(ownerPath).mtimeMs < 90_000) return false;
    const stale = lease + ".stale." + runtimeID;
    try { fs.renameSync(lease, stale); fs.rmSync(stale, { recursive: true }); } catch { return false; }
    return acquireRecovery();
  }
  fs.writeFileSync(ownerPath, JSON.stringify({ token: runtimeID, pid: process.pid }), { mode: 0o600 });
  heartbeat = setInterval(() => {
    if (!ownsRecovery()) { stopped = true; void client?.close(); return; }
    const now = new Date(); try { fs.utimesSync(ownerPath, now, now); } catch { stopped = true; }
  }, 5000);
  return true;
}
const request = (body, token) => new Promise(resolve => {
  const bytes = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: "127.0.0.1", port: 53631, path: "/v1/plugin/recovery", method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": bytes.length } }, res => {
    let buffer = "";
    res.on("data", chunk => { if (buffer.length < 65536) buffer += chunk; else res.destroy(); });
    res.on("end", () => { let json; try { json = JSON.parse(buffer); } catch {} resolve({ status: res.statusCode, json }); });
    res.on("error", () => resolve({ status: 0 }));
  });
  req.setTimeout(5000, () => req.destroy());
  req.on("error", () => resolve({ status: 0 }));
  req.end(bytes);
});
async function recover() {
  while (!stopped) {
    try {
      const pairing = mainPluginPairing();
      if (pairing && acquireRecovery()) {
        if (!runner) {
          const probe = await request({ schema_version: 1, helper_version: manifest.version,
            recovery_id: runtimeID, state: "checking" }, pairing.token);
          if (probe.status !== 200) throw Error("bridge unavailable");
          const resolver = new CodexExecutableResolver();
          resolver.setApplicationPath(probe.json?.codex_app_path);
          const executable = await resolver.resolve();
          if (!executable) throw Error("host unavailable");
          const identity = cachedMainIdentity(pairing.cacheFamily, probe.json?.running_version, probe.json?.version);
          if (!identity) throw Error("installed package unavailable");
          client = new CodexAppServerClient(executable, undefined, { clientName: "pinland_reviewed_recovery" });
          await client.start();
          // Share the main updater's durable install receipt. A separately
          // reviewed bootstrap must not repeat an older uncertain installation.
          let journalFile = path.join(pairing.directory, "plugin-update-state.json");
          const previous = previousPluginDataDirectory();
          if (!fs.existsSync(journalFile) && pairedPluginToken(previous) === pairing.token
              && fs.existsSync(path.join(previous, "plugin-update-state.json"))) {
            journalFile = path.join(previous, "plugin-update-state.json");
          }
          runner = new LegacyPluginRecovery({ client, identity, pairing, helperVersion: manifest.version,
            runtimeID, journal: new PluginUpdateJournal(journalFile),
            isOwner: ownsRecovery,
            send: body => request(body, pairing.token) });
        }
        await runner.run();
        if (runner.complete) { await client.close(); input.close(); return; }
      }
    } catch {
      if (client?.closed) { runner = undefined; client = undefined; }
      // No raw native errors, paths or credentials enter MCP output.
    }
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (line.length > 65536) return;
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === "notifications/initialized" && !initialized) { initialized = true; void recover(); }
  if (message.id == null) return;
  const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} }, serverInfo: { name: "pinland-recovery", version: manifest.version } }
    : message.method === "tools/list" ? { tools: [] } : message.method === "ping" ? {} : undefined;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result ? { result }
    : { error: { code: -32601, message: "Method not found" } }) }) + "\n");
});
input.on("close", () => {
  const owned = ownsRecovery(); stopped = true; clearInterval(heartbeat);
  if (owned) { try { fs.rmSync(lease, { recursive: true, force: true }); } catch {} }
  if (client) void client.close().finally(() => process.exit(0)); else process.exit(0);
});
