# Pinland for Codex

This plugin connects Codex App and Codex CLI tasks to the local Pinland Mac app.

The normal setup takes two actions:

1. Open Pinland Settings and choose **Install & Connect**.
2. Review and confirm the standard Codex plugin screen once.

Pinland opens the signed plugin snapshot included in the app bundle. Pairing
then finishes automatically, with no Terminal command, copied token, or
configuration-file edit. Use Codex's normal sidebar **Pin** action on any task
worth keeping.

Pinland mirrors only Codex's native Pinned section, including unpinning and
manual ordering. Other new tasks stay out of the notch. Removing a card only
hides that native pin from Pinland; unpinning and pinning it again in Codex
restores it. The older **Pin this task to Pinland** action remains available as
a compatibility fallback. Native section sync requires Codex 0.147 or later;
older versions can keep using that action without Terminal setup.

Each mirrored task also carries a small, bounded preview of its three newest
turns. Its saved history contains only user messages and Codex's final answers.
While the newest turn is running, Pinland may additionally show Codex's latest
public commentary as a temporary progress update; that update is cleared when
the final answer arrives and is never added to saved history. Reasoning, tool
calls, commands, tool output, and diffs are never included. The companion
refreshes when Codex reports that the task changed, then keeps the six newest
saved messages available across Pinland relaunches.

Every mirrored task that can accept input uses the same compact composer,
whether it is idle or currently running. Pinland presents one **Send** action;
one click creates one authenticated live request and one Codex task-messaging
call. Pinland has no prompt outbox, does not replay messages after relaunch,
does not retry in the background, and does not alter Stop hooks to manufacture
another turn. The authenticated companion resolves that exact task's
authoritative same-user Codex Desktop owner and hands the instruction to its
existing app-server connection, whether the task is idle or currently running.
A headless environment without a Desktop owner may open one bounded app-server
owner for an unloaded task and
keeps it only until the turn finishes. Pinland never creates a private queue or
silently sends later. Before dispatch, a local
command-id receipt records only bounded delivery state, never
the prompt, task title, path, or raw error. The receipt cannot initiate work; it
only prevents the same live request from starting twice after an ambiguous
acknowledgement. If delivery cannot be known with certainty, Pinland asks the
user to check Codex and intentionally disables one-click retry.

The Codex-managed companion reads native pins through Codex app-server, while
trusted hooks send lifecycle details. One detached companion keeps native pin
sync and the authenticated composer listener alive after an individual task
closes; each instruction follows Codex Desktop's authoritative task owner.
Atomic heartbeat leases deduplicate them, repair stale owners, and let the
detached process stop after Codex exits or an idle CLI grace period. No
LaunchAgent or login item is installed.

### Question cards

Pinned native Desktop tasks can show questions, choices and custom answers in
Pinland's blue Codex card, in Chinese or English. The companion handles both
`item/tool/requestUserInput` and asynchronous question messages. Blocking
answers go to the original request ID; asynchronous answers use Desktop's
structured question-reply envelope through its existing owner (steer while
running, start a follow-up when idle). No permission policy is changed.

The relay subscribes only to known pins (up to 64), verifies the local owner,
protocol version and stream revision, and retains a bounded in-memory
projection of questions and receipts, not raw history. Only the latest turn's
asynchronous questions are presented. Secret questions, unsupported schemas,
and connector/tool authorizations stay in Codex. Answering in Codex, unpinning,
or losing the owner invalidates the local form. One click sends once: a router
`ok` is not treated as answer acceptance; a matching native answer receipt is
required. Uncertain delivery falls back to Codex without automatic retry.
The App's short relay lease expires if the companion goes away.

Desktop follower routing is version-checked against the installed Desktop
build, not a guaranteed public compatibility API. Unknown versions safely
fall back to answering in Codex. New plugin tools/skills require a new Codex
task to load; the elected companion can refresh independently.

### Sync diagnostics

Pinland Settings separates **Paired** (credentials exist) from native pin sync.
It shows the last successful sync, the number of native Codex pins received,
and localized recovery guidance. A received empty list is distinct from no
list yet; locally hidden cards do not change the received native count.

The companion sends an authenticated `/v1/pins/status` report from its existing
loop, at most once per 30 seconds for an unchanged state, immediately on error
or recovery. Ready reports refer to an accepted snapshot's source and revision.
Only allowlisted error categories are sent, never raw exceptions, paths,
credentials, or conversation text. `/v1/health` alone never proves sync success.
Older Pinland versions can ignore the new endpoint. With an older companion,
Pinland distinguishes an unconfirmed idle snapshot from an interrupted sync.
No new background timer or shelf-wide UI publisher is introduced.

Both paths use a random per-install token and talk only to an authenticated
listener bound to `127.0.0.1`. Pinland never reads `~/.codex`; the companion
requests the bounded task preview and dispatches explicit user-submitted
instructions through Codex's supported task interfaces.
Pairing state, sync cursors, and the bounded
command ledger live in the plugin's private data directory so they survive a
normal app or Mac restart. If Pinland is unavailable, the plugin makes no
decision and Codex keeps its native completion and approval behavior.

The public Plugins Directory remains the intended hosted install path. While
that listing is under review, Pinland's signed bundled snapshot is the normal
end-user path and the public GitHub marketplace is the transparent source and
manual developer fallback.
