import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/pinland-hook.zsh", import.meta.url));
const payload = { hook_event_name: "UserPromptSubmit", session_id: "qa-task", prompt: "Pin this task to Pinland." };

// Test a private copy of the real hook against a fake transport. Never contacts
// the user's Pinland, opens Codex, starts a companion, or accesses real credentials.
function run({ mode = "manual-pin", prompt = payload.prompt, paired = true,
  health = "204", pair = "204", reply = "200", body = '{"decision":"block","reason":"Pinned to Pinland."}',
  badToken = false, missingStorage = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-hook-feedback-"));
  try {
    const data = path.join(root, "data"), transport = path.join(root, "transport"), script = path.join(root, "hook.zsh");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "bridge-token"), badToken ? "invalid" : "a".repeat(64));
    if (paired) fs.writeFileSync(path.join(data, "paired"), "");
    fs.writeFileSync(transport, `#!/bin/zsh
      output=""; route="";
      while (( $# )); do
        if [[ "$1" == "--output" ]]; then output="$2"; shift 2;
        else route="$1"; shift; fi
      done
      print -rn -- "$QA_BODY" > "$output"
      case "$route" in
        */v1/health) print -rn -- "$QA_HEALTH" ;;
        */v1/pair) print -rn -- "$QA_PAIR" ;;
        *) print -rn -- "$QA_REPLY" ;;
      esac
    `, { mode: 0o700 });
    fs.writeFileSync(script, fs.readFileSync(hookPath, "utf8")
      .replaceAll("/usr/bin/curl", JSON.stringify(transport))
      .replaceAll("/usr/bin/open", "/usr/bin/true")
      .replaceAll("/bin/sleep", "/usr/bin/true"));
    if (missingStorage) fs.writeFileSync(path.join(root, "not-a-directory"), "");
    const result = spawnSync("/bin/zsh", [script, mode], { encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ ...payload, prompt }), env: { ...process.env, PLUGIN_ROOT: "",
        PLUGIN_DATA: missingStorage ? path.join(root, "not-a-directory", "child") : data,
        QA_HEALTH: health, QA_PAIR: pair, QA_REPLY: reply, QA_BODY: body } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("manual pin only acknowledges a confirmed successful pin", () => {
  assert.deepEqual(run(), { decision: "block", reason: "Pinned to Pinland." });
  for (const options of [{ reply: "000", body: "" }, { reply: "204", body: "" },
    { reply: "400", body: "private error" }, { body: "private error" }]) {
    const result = run(options);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /CX-PIN-UNCONFIRMED/);
    assert.doesNotMatch(result.reason, /private error|Pinned to Pinland/);
  }
});

test("manual pin failures identify storage, pairing, authentication and bridge stages", () => {
  for (const [options, code] of [
    [{ badToken: true }, "CX-PIN-STATE"], [{ missingStorage: true }, "CX-PIN-STATE"],
    [{ paired: false, pair: "403" }, "CX-PIN-PAIRING"],
    [{ health: "401" }, "CX-PIN-AUTH"], [{ health: "000" }, "CX-PIN-BRIDGE"],
    [{ reply: "401" }, "CX-PIN-AUTH"]
  ]) {
    const result = run(options);
    assert.equal(result.decision, "block");
    assert.ok(result.reason.includes(code));
    assert.doesNotMatch(result.reason, /qa-task|bridge-token|\/Users\/|a{64}/);
  }
});

test("ordinary prompts and lifecycle failures still fail open without a decision", () => {
  assert.equal(run({ prompt: "Continue my task", health: "000" }), undefined);
  assert.equal(run({ mode: "lifecycle" }), undefined, "default action must never be duplicated");
  for (const options of [{ badToken: true }, { missingStorage: true },
    { paired: false, pair: "403" }, { health: "000", reply: "000", body: "" },
    { reply: "401" }, { reply: "204", body: "" }]) {
    assert.equal(run({ ...options, mode: "lifecycle", prompt: "Continue my task" }), undefined);
  }
});
