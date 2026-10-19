// Version 37 fences sync by runtime identity and compares package versions for
// same-protocol handovers. Replaced daemons drain owned tasks before exiting.
// Version 36 discovers packaged Codex executables and reports before bootstrap.
// Version 35 adds runtime identity, targeted plugin updates and account usage.
// Usage must also advance the lease: otherwise an old daemon can keep the sync
// channel forever even after Codex has loaded the newly installed package.
// Version 34 tightens question schemas and native receipt gating.
// Version 33 also supports asynchronous Desktop questions and native steer receipts.
// Version 32 relays native Desktop questions to the pinned-task question card.
// Version 31 reports native-pin sync health and allowlisted failures to settings.
// Version 30 adds a Codex-hosted cross-task provider between Desktop owner
// routing and the temporary app-server fallback. Idle tasks whose stale owner
// does not answer discovery can now receive a message without colliding with
// Desktop's existing writer, while active tasks still use their exact owner.
// Version 29 keeps native pinned-task titles authoritative across reconnects:
// it refreshes names from the ordinary task list, retries transiently empty
// task reads, and marks preview/cwd fallbacks so Pinland cannot overwrite a
// previously resolved user-visible title.
// Version 28 routes every Desktop-backed instruction to the task's
// authoritative same-user Desktop owner. The owner performs the turn/start on
// its existing app-server connection, so active and idle tasks share one
// direct, single-attempt path without a Pinland queue or competing writer.
// Version 27 gives the detached daemon a stable public composer listener and
// lets a Codex-hosted MCP process expose its task-messaging channel through a
// separate authenticated provider endpoint. The daemon is no longer tied to
// the host pipe of whichever task happened to spawn it.
// Version 26 keeps the composer listener inside the Codex-hosted MCP process.
// The detached daemon remains read-only: inheriting the pipe path is not the
// same as retaining the host authority required to call Desktop task tools.
// Version 25 restored Codex Desktop's supported task-messaging channel but
// incorrectly tried to use it after detaching the daemon from its MCP parent.
// Version 24 restores the stable daemon-owned composer listener and the
// synchronous temporary-owner fallback used by the last verified working
// release. Each click is still one direct attempt: prompts are never queued or
// retried by Pinland.
// Version 23 moved the composer listener into a Codex-hosted MCP process and
// left the detached daemon read-only. In personal plugins the required host
// channel is filtered, so that change removed the working send endpoint.
// Version 22 validates Desktop's task-messaging channel with a read-only
// handshake and keeps that verified connection alive across composer sends.
// Version 21 uses Desktop's supported task-messaging channel directly whenever
// it is available, allowing the trusted PermissionRequest hook to return
// approvals to Pinland without first contending for Desktop's task writer. A
// standalone app-server owner is used only when the Desktop channel is absent.
// Version 20 made Pinland-started idle turns prefer a Pinland-owned app-server
// connection, with Desktop as the active-writer fallback.
// Version 19 replaces the polled persistent instruction outbox with one
// authenticated direct-send request per composer click. Version 18 makes
// legacy Desktop rollout lifecycle authoritative for live
// progress because a separate app-server reports those tasks as notLoaded.
// Version 17 restores legacy-task previews with a bounded, incremental rollout
// tail reader while keeping full app-server history scans disabled. Version 16
// removes background legacy-history scans entirely. Version 15
// stopped rescanning active legacy rollouts after their initial bounded
// summary. Version 14 added incremental paginated items and owner
// concurrency protection. Version 13
// separates the long-lived read-only sync connection from
// short-lived instruction owner connections and guarantees bounded child
// teardown. Version 12 tightened request_permissions detection against
// source-search lookalikes. Version 11 added Desktop-owned approvals;
// version 10 added the privacy-bounded Desktop-owned approval alert snapshot.
// Leadership remains monotonic because multiple Codex tasks can retain
// an older plugin process after an update; those followers must never steal
// the lease back from a newer daemon and revive stale snapshot semantics.
export const DAEMON_PROTOCOL_VERSION = 37;

// Versioned ownership handles ordinary package updates too, without requiring a
// protocol bump for every release. Older (unversioned) readers still respect the
// protocol high-water mark and cannot steal a healthy newer lease back.
import { comparePluginVersions } from "./plugin-update.mjs";

export function daemonLeaseDisposition(owner, options) {
  const age = options.age;
  const staleMilliseconds = options.staleMilliseconds;
  const ownerIsHealthy = Number.isSafeInteger(owner?.protocol_version)
      && typeof owner?.token === "string"
      && options.processIsAlive(owner?.pid)
      && age <= staleMilliseconds;
  if (ownerIsHealthy && owner.protocol_version > DAEMON_PROTOCOL_VERSION) {
    return "keep";
  }
  if (ownerIsHealthy && owner.protocol_version === DAEMON_PROTOCOL_VERSION) {
    if (options.pluginVersion && comparePluginVersions(owner.plugin_version, options.pluginVersion) === -1) return "replace";
    if (options.pluginVersion && !owner.plugin_version) return "replace";
    return "keep";
  }
  if (!owner && age <= staleMilliseconds) return "wait";
  return "replace";
}
