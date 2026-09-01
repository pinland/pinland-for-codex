# Pinland for Codex

This plugin connects Codex App and Codex CLI tasks to the local Pinland Mac app.

## Install from Pinland

Current Pinland builds provide the normal setup in two actions:

1. Open Pinland Settings and choose **Install & Connect**.
2. Review and confirm the standard Codex plugin screen once.

Pinland opens the signed plugin snapshot included in the app bundle. Pairing
then finishes automatically, with no Terminal command, copied token, or
configuration-file edit. Use Codex's normal sidebar **Pin** action on any task
worth keeping.

## Manual GitHub marketplace installation

Developers can install the same public package directly from GitHub:

```bash
codex plugin marketplace add pinland/pinland-for-codex
codex plugin add pinland-for-codex@pinland
```

Restart the ChatGPT desktop app after installation, then open Pinland Settings
and choose **Connect** beside Codex.

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
end-user path and this GitHub marketplace is the transparent source and manual
developer fallback.
