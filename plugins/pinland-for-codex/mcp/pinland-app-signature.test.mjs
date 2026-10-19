import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { PINLAND_APP_REQUIREMENT } from "./plugin-source-migration.mjs";

const macOS = process.platform === "darwin";

test("Pinland's source identity requirement compiles with macOS Security", { skip: !macOS }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-signature-syntax-"));
  try {
    execFileSync("/usr/bin/csreq", ["-r", PINLAND_APP_REQUIREMENT, "-b", path.join(root, "requirement")]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an ad-hoc lookalike cannot claim Pinland's signed team and bundle identity", { skip: !macOS }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-signature-lookalike-"));
  try {
    const executable = path.join(root, "Pinland-lookalike");
    const entitlements = path.join(root, "entitlements.plist");
    fs.copyFileSync("/usr/bin/true", executable);
    fs.writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict>'
      + '<key>com.apple.developer.team-identifier</key><string>KDG9SYMY48</string></dict></plist>');
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "com.zeenzhao.pinland",
      "--entitlements", entitlements, executable], { stdio: "pipe" });
    const result = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "-R", PINLAND_APP_REQUIREMENT, executable]);
    assert.notEqual(result.status, 0, "a self-asserted entitlement must not replace the Apple signing anchor");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Opt in with an already installed same-team Mac App Store application. The
// fixture is read-only, never launched, modified or used to access user data.
const storeApp = process.env.PINLAND_QA_MAC_APP_STORE_APP;
test("Apple-resigned same-team code is accepted while wrong team and bundle identity are rejected", {
  skip: !macOS || !storeApp
}, () => {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R",
    "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.9] exists", storeApp]);
  const metadata = spawnSync("/usr/bin/codesign", ["-dvv", storeApp], { encoding: "utf8" }).stderr;
  const identifier = /^Identifier=([A-Za-z0-9.-]+)$/m.exec(metadata)?.[1];
  assert.ok(identifier, "the fixture must have a native code-signing identifier");
  const requirement = PINLAND_APP_REQUIREMENT.replace('"com.zeenzhao.pinland"', JSON.stringify(identifier));
  const verify = value => spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", value, storeApp]);
  const accepted = verify(requirement);
  assert.equal(accepted.status, 0, accepted.stderr.toString());
  assert.notEqual(verify(requirement.replaceAll("KDG9SYMY48", "XXXXXXXXXX")).status, 0);
  assert.notEqual(verify(requirement.replace(JSON.stringify(identifier), '"com.zeenzhao.pinland.invalid"')).status, 0);
});
