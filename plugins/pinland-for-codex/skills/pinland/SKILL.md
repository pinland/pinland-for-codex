---
name: pinland
description: Connect Codex task lifecycle events to the local Pinland Mac app and troubleshoot notch alerts without asking the user to edit configuration files.
---

# Pinland

Pinland keeps only the Codex tasks a user deliberately puts in Codex's native
Pinned section. A Codex-managed companion mirrors that set and order to the
MacBook notch. Trusted lifecycle hooks add status, completion alerts, and
supported approval requests for those tasks.

## Connect

1. Ask the user to open Pinland Settings and click **Connect** under Codex.
2. In Codex, ask the user to install Pinland for Codex from the Plugins
   Directory if it is not already installed.
3. Explain that Codex requires one explicit review and trust confirmation for
   the plugin hooks and local companion. Do not suggest bypassing that review.
4. Ask the user to use Codex's normal sidebar **Pin** action on the tasks they
   want to keep. Pairing and synchronization happen automatically over an
   authenticated loopback connection. No message needs to be sent.

Never ask an App Store user to open Terminal, copy a token, edit `~/.codex`, or
move plugin files manually.

## Expected behavior

- Only tasks in Codex's native Pinned section appear.
- Native pin, unpin, and manual ordering sync automatically after the plugin
  loads, independently of any one task staying open.
- Unpinned new tasks remain absent from Pinland.
- Hovering a mirrored task shows bounded saved history made only from user
  messages and Codex final answers. While the latest turn runs, the preview may
  also show its latest public commentary as temporary progress; clear it when
  the final answer arrives and never append it to saved history. A strictly
  validated `codex_app/send_message_to_thread` delegation envelope represents
  the user's own cross-task instruction and may be normalized into a user
  message. Every other tool call and tool output remains private: never expose
  reasoning, commands, arbitrary tool output, or diffs.
- A mirrored task accepts a new instruction from the same preview composer when
  it is idle or running. Pinland exposes one **Send** action and never maintains
  its own follow-up queue or blocks a Stop hook to create another turn. The
  companion sends through Codex Desktop's authoritative same-user task owner
  whenever it is available, including for a currently loaded task. A
  headless environment may use one bounded app-server owner for an unloaded
  task. Pinland never creates a private queue or silently delivers later, never
  persists a prompt outbox or replays a message after relaunch. Merely inserting
  an internal queue record is never treated as delivery. Pinland never launches
  a CLI or reads Codex files itself.
  A local command-only ledger
  prevents daemon restarts and lost acknowledgements from dispatching the same
  turn twice; an uncertain result must be checked in Codex and cannot be retried
  from the card.
- A pinned task expands the notch when it completes without stealing focus.
- A permission request delivered through the trusted hook can be allowed or
  denied from its Pinland preview, including a turn owned by the companion.
  An older or not-yet-reloaded task
  that has not loaded the trusted hook falls back to an alert with **Open in
  Codex**.
- Removing a task card hides it locally. It returns only after the task is
  unpinned and pinned again in Codex.
- If Pinland is unavailable, hooks make no decision and Codex keeps its native
  approval and task UI.
- The default **Pin this task to Pinland** action is a compatibility fallback.
  Native section sync requires Codex 0.147 or later; older versions can keep
  using the action.

## Troubleshoot

If tasks do not appear, first confirm the Pinland app is installed and the
plugin is enabled and trusted. Then ask the user to click **Reconnect** in
Pinland Settings. If Codex has not loaded a newly installed plugin yet, reopen
Codex once; the companion starts with the plugin and does not require a prompt.
Then toggle the task's native pin if a refresh is needed. Keep all recovery
steps inside the two apps; do not ask the user to repair the local bridge by
hand.
