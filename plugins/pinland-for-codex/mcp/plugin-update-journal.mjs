import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { validMarketplacePath } from "./plugin-source-migration.mjs";

const ISSUES = new Set(["source_changed", "review_required", "host_unsupported", "query_failed", "install_uncertain",
  "not_installed", "disabled", "admin_blocked", "reload_timeout"]);

// This is our own plugin-data journal, never Codex's installation/configuration.
// Persist BEFORE submitting an install. A crash or lost reply must not replay it.
export class PluginUpdateJournal {
  constructor(file) { this.file = file; this.memory = undefined; }

  load(key) {
    let value = this.memory;
    if (this.file) {
      try {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("invalid journal");
        value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (value && (value.schema !== 1 || typeof value.key !== "string"
        || !["checking", "retry", "manual", "submitted", "acknowledged", "verified"].includes(value.phase)
        || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 6
        || !Number.isFinite(value.nextAt) || !Number.isFinite(value.submittedAt)
        || (value.handoffs != null && (!Number.isSafeInteger(value.handoffs) || value.handoffs < 0 || value.handoffs > 3))
        || (value.issue != null && !ISSUES.has(value.issue))
        || (value.sourceMigrationChecked != null && typeof value.sourceMigrationChecked !== "boolean")
        || (value.needsAppAuth != null && typeof value.needsAppAuth !== "boolean")
        || (value.sourceMigration != null && (!validMarketplacePath(value.sourceMigration.to)
          || (value.sourceMigration.from != null && !validMarketplacePath(value.sourceMigration.from))
          || !["prepared", "detached", "registered"].includes(value.sourceMigration.phase)))
        || typeof value.recoveryRequest !== "string")) throw new Error("invalid journal");
    return value?.key === key ? { ...value } : { schema: 1, key, phase: "checking", attempts: 0,
      nextAt: 0, submittedAt: 0, recoveryRequest: "" };
  }

  save(value) {
    if (this.file) {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, this.file);
      } finally {
        try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ }
      }
    }
    this.memory = { ...value };
  }
}
