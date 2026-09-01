# Distribution checklist

`pinland-for-codex` is the package namespace, not a public installation URL.
OpenAI assigns the actual listing URL only after directory review. Until that
URL exists, this GitHub repository is the supported fallback marketplace:

```bash
codex plugin marketplace add pinland/pinland-for-codex
codex plugin add pinland-for-codex@pinland
```

Pinland's **Install & Connect** button opens Codex's standard plugin screen for
the signed snapshot bundled with the app. The user must still review and
confirm once; Pinland must not claim installation completed before that Codex
confirmation.

Before enabling the feature in an App Store release:

1. Create the public terms page required by the listing form.
2. Submit the skill bundle and plugin metadata through the OpenAI Platform
   plugin portal using a verified publisher with Apps Management write access.
3. After approval, set `AppLinks.codexPluginInstallURL` to the exact public URL
   returned by OpenAI; do not derive one from the package namespace.
4. On a clean Mac user account, install Pinland from the App Store.
5. Choose **Install & Connect** in Pinland Settings and accept Codex's required
   hook trust review. Verify there is no Terminal command, copied token, or
   configuration-file edit in the end-user flow.
6. Start an unpinned control task and verify that it never appears in Pinland.
7. Pin one Codex App task with Codex's native sidebar action. Without sending a
   prompt, verify it appears in Pinland, then verify native reorder and unpin
   are mirrored. Hover the card and verify its recent user messages and final
   answers appear in chronological order. While a turn runs, verify its latest
   public commentary appears as temporary progress, then disappears when the
   final answer replaces it. The temporary update must not enter saved history,
   and reasoning, tool calls, commands, tool output, and diffs must never appear.
   Close the task that first loaded the plugin, pin another task without sending
   a prompt, and verify sync continues. Repeat with a Codex CLI task where native
   sections are available.
8. From a pinned card, send a short instruction once while its Codex Desktop
   task is active and once while the task is idle and unloaded. Verify the same
   composer and **Send** action are used in every state, delivery feedback
   appears immediately, and the exact task receives the message once in both
   cases. A Codex Desktop task must receive the message through its registered
   authoritative Desktop owner without competing for its writer. A headless,
   unloaded task may use one bounded app-server owner. Verify a definite rejection offers retry, while a
   simulated lost host-tool response shows an uncertain state with no retry and a
   direct **Open in Codex** action. Neither state may expose raw paths, prompts
   in the command ledger, or app-server errors. Pinland must not show its own
   queued-follow-up state, cancellation control, or Stop-hook continuation.
9. Verify the legacy plugin action on an older supported Codex build, then
   verify completion, approval, active-task sending, app cold start, local hide,
   native unpin/re-pin, and reconnect after reinstalling the plugin.

The App Store app listens only on `127.0.0.1:53631`. The plugin creates a random
per-install bearer token and pairs only while the user has explicitly opened a
short pairing window from Pinland Settings. The Codex-managed companion reads
the native Pinned section and a bounded recent-turn preview through app-server;
after the user submits from a card, the companion makes one synchronous
dispatch through the task's authoritative same-user Desktop owner. Only a
headless environment without that owner may own a bounded app-server turn.
Pinland itself has no prompt
outbox or follow-up queue: every click is one live request, and old state is
never replayed after launch. Codex alone
decides how an instruction sent to an already-running task is scheduled.
The sandboxed Pinland app never receives direct filesystem or process access to
Codex data.
