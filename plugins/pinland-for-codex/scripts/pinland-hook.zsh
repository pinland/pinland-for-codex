#!/bin/zsh

# Pinland never edits Codex configuration. Codex runs this trusted plugin hook,
# whose private state lives under Codex's plugin-data directory and which talks
# only to Pinland's loopback listener. Any failure exits without a decision so
# Codex keeps its native behavior.

set -u
set -o pipefail

readonly bridge_url="http://127.0.0.1:53631"
readonly mode="${1:-lifecycle}"
readonly manual_pin_prompt="Pin this task to Pinland."
readonly payload="$(/bin/cat)"
readonly event_name="$(
  /usr/bin/printf '%s' "$payload" \
    | /usr/bin/plutil -extract hook_event_name raw -o - - 2>/dev/null
)"

if [[ -z "$payload" || -z "$event_name" ]]; then
  exit 0
fi

prompt=""
if [[ "$event_name" == "UserPromptSubmit" ]]; then
  prompt="$(
    /usr/bin/printf '%s' "$payload" \
      | /usr/bin/plutil -extract prompt raw -o - - 2>/dev/null
  )"
fi
readonly prompt

# The synchronous handler exists only to turn Pinland's default plugin action
# into a local pin operation without spending an AI turn. Lifecycle hooks skip
# the same marker so it is never delivered twice.
case "$mode" in
  manual-pin)
    if [[ "$event_name" != "UserPromptSubmit" || "$prompt" != "$manual_pin_prompt" ]]; then
      exit 0
    fi
    ;;
  lifecycle)
    if [[ "$event_name" == "UserPromptSubmit" && "$prompt" == "$manual_pin_prompt" ]]; then
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

if [[ -n "${PLUGIN_DATA:-}" ]]; then
  data_dir="$PLUGIN_DATA"
else
  readonly user_home="${HOME:-}"
  if [[ -z "$user_home" ]]; then
    exit 0
  fi
  readonly codex_home="${CODEX_HOME:-$user_home/.codex}"
  data_dir="$codex_home/plugin-data/pinland-for-codex"
fi
readonly data_dir
/bin/mkdir -p "$data_dir" 2>/dev/null || exit 0
/bin/chmod 700 "$data_dir" 2>/dev/null || true

# Native pin changes do not emit a lifecycle hook. Keep one detached,
# plugin-owned companion alive after this hook returns so sidebar Pin/Unpin and
# reorder operations continue to sync without a prompt or open MCP task. The
# Node companion owns the atomic lease and safely deduplicates concurrent hooks.
if [[ -n "${PLUGIN_ROOT:-}" \
   && -x "$PLUGIN_ROOT/scripts/launch-pinland-mcp" \
   && -f "$PLUGIN_ROOT/mcp/pins-sync-server.mjs" ]]; then
  PLUGIN_DATA="$data_dir" "$PLUGIN_ROOT/scripts/launch-pinland-mcp" \
    "$PLUGIN_ROOT/mcp/pins-sync-server.mjs" \
    --migrate-data </dev/null >/dev/null 2>&1 || true
  PLUGIN_DATA="$data_dir" "$PLUGIN_ROOT/scripts/launch-pinland-mcp" \
    "$PLUGIN_ROOT/mcp/pins-sync-server.mjs" \
    --ensure-daemon </dev/null >/dev/null 2>&1 &!
fi

readonly token_file="$data_dir/bridge-token"
if [[ ! -s "$token_file" ]]; then
  readonly generated_token="$(/usr/bin/openssl rand -hex 32 2>/dev/null)"
  if [[ ${#generated_token} -ne 64 ]]; then
    exit 0
  fi
  (
    set -o noclobber
    umask 077
    /usr/bin/printf '%s' "$generated_token" > "$token_file"
  ) 2>/dev/null || true
fi

readonly token="$(/bin/cat "$token_file" 2>/dev/null)"
if [[ ${#token} -ne 64 ]]; then
  exit 0
fi

function wake_pinland() {
  /usr/bin/open -gj 'pinland://codex/wake' >/dev/null 2>&1 || true
}

function curl_status() {
  local path="$1"
  local body="$2"
  local output_file="$3"
  local max_time="$4"
  /usr/bin/curl \
    --silent \
    --output "$output_file" \
    --write-out '%{http_code}' \
    --connect-timeout 0.35 \
    --max-time "$max_time" \
    --request POST \
    --header "Authorization: Bearer $token" \
    --header 'Content-Type: application/json' \
    --data-binary "$body" \
    "$bridge_url$path" 2>/dev/null
}

readonly response_file="$(/usr/bin/mktemp "$data_dir/response.XXXXXX" 2>/dev/null)"
if [[ -z "$response_file" ]]; then
  exit 0
fi
trap '/bin/rm -f "$response_file"' EXIT

# Once paired, SessionStart, approvals, and completion wake a closed App Store
# build. An unpaired plugin never launches Pinland on its own: first-time setup
# already begins from Pinland Settings, and failures keep Codex's native UI.
did_wake=0
if [[ -f "$data_dir/paired" ]] \
   && [[ "$mode" == "manual-pin" \
      || "$event_name" == "SessionStart" \
      || "$event_name" == "PermissionRequest" \
      || "$event_name" == "Stop" ]]; then
  wake_pinland
  did_wake=1
fi

if [[ ! -f "$data_dir/paired" ]]; then
  # SessionEnd is advisory and never cold-starts Pinland. Avoid making Codex
  # wait for a pairing flow that the user did not initiate.
  if [[ "$event_name" == "SessionEnd" ]]; then
    exit 0
  fi
  pair_status="000"
  for _ in 1 2 3 4 5 6; do
    pair_status="$(curl_status '/v1/pair' '{}' "$response_file" 1)"
    [[ "$pair_status" == "204" ]] && break
    /bin/sleep 0.15
  done
  if [[ "$pair_status" != "204" ]]; then
    exit 0
  fi
  umask 077
  : > "$data_dir/paired"
fi

# A URL wake can return before the sandboxed app has opened its loopback
# listener. Wait for an authenticated, side-effect-free health response before
# sending the one real event. This is especially important for approvals,
# which must not be replayed just because the app was still launching.
if [[ "$did_wake" -eq 1 ]]; then
  health_status="000"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    health_status="$(curl_status '/v1/health' '{}' "$response_file" 0.25)"
    [[ "$health_status" == "204" ]] && break
    if [[ "$health_status" == "401" ]]; then
      /bin/rm -f "$data_dir/paired"
      exit 0
    fi
    /bin/sleep 0.1
  done
  if [[ "$health_status" != "204" ]]; then
    exit 0
  fi
fi

max_time=4
if [[ "$mode" == "manual-pin" ]]; then
  max_time=2
elif [[ "$event_name" == "PermissionRequest" ]]; then
  # Codex grants a synchronous hook up to 600 seconds by default. Keep the
  # bridge just inside that boundary so the approval can remain actionable in
  # Pinland instead of disappearing after a few seconds.
  max_time=590
elif [[ "$event_name" == "SessionEnd" ]]; then
  max_time=0.75
fi

http_status="000"
retry_count=4
# Reissuing a permission request after a lost response could create a second
# approval prompt. One safe attempt is enough: failure falls back to Codex's
# native approval UI. Stop is idempotent in the Pinland bridge and may retry so
# its terminal lifecycle update is not lost to a transient response failure.
if [[ "$mode" == "manual-pin" ]]; then
  retry_count=1
elif [[ "$event_name" == "PermissionRequest" ]]; then
  retry_count=1
elif [[ "$event_name" == "SessionEnd" ]]; then
  retry_count=1
fi
for ((attempt = 1; attempt <= retry_count; attempt++)); do
  http_status="$(curl_status '/v1/hooks' "$payload" "$response_file" "$max_time")"
  [[ "$http_status" == "200" || "$http_status" == "204" ]] && break
  /bin/sleep 0.12
done

if [[ "$http_status" == "401" ]]; then
  /bin/rm -f "$data_dir/paired"
  exit 0
fi

if [[ "$http_status" == "200" && -s "$response_file" ]]; then
  /bin/cat "$response_file"
fi

exit 0
