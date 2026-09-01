# Pinland for Codex

Pinland for Codex mirrors only the Codex tasks you deliberately keep in
Codex's native **Pinned** section. Those tasks become cards in the Pinland
notch, with bounded recent conversation previews, status updates, completion
alerts, explicit message sending, and supported approval prompts.

## Requirements

- Pinland for macOS
- Codex 0.147 or later for native pinned-section synchronization

Older Codex versions can still use the plugin's **Pin this task to Pinland**
compatibility action.

## Install from Pinland

Current Pinland builds include a signed snapshot of this public plugin. Open
**Pinland Settings**, choose **Install & Connect**, then review and confirm the
standard Codex plugin screen once. Pairing and pinned-task synchronization
finish automatically; there is no token to copy and no configuration file to
edit.

After setup, use Codex's normal sidebar **Pin** action to choose the tasks that
should appear in Pinland.

## Manual GitHub install

Developers can instead add this repository as a Codex plugin marketplace:

```bash
codex plugin marketplace add pinland/pinland-for-codex
codex plugin add pinland-for-codex@pinland
```

Restart the ChatGPT desktop app, open Pinland Settings, and choose **Connect**
beside Codex. Codex will ask you to review and trust the plugin's local hooks.

## Privacy and security

Pinland and this plugin communicate only through an authenticated listener on
`127.0.0.1`. The plugin stores a random per-install token and bounded sync state
in Codex's private plugin-data directory. Saved previews contain only recent
user messages and Codex final answers; reasoning, commands, arbitrary tool
output, and diffs are not included.

If Pinland is unavailable, the plugin makes no decision and Codex keeps its
native task and approval behavior.

See the [Pinland privacy policy](https://memex-api.xyz/pinland/privacy/) for
product-level data handling details.

Copyright © Pinland. All rights reserved.
