import assert from "node:assert/strict";
import test from "node:test";

import {
  desktopToolsPipeForInvocation,
  detachedDaemonEnvironment
} from "./daemon-runtime-policy.mjs";

test("a detached daemon never inherits a task-scoped Desktop pipe", () => {
  const environment = {
    CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-task.sock",
    PLUGIN_DATA: "/tmp/pinland-data"
  };
  assert.equal(
    desktopToolsPipeForInvocation("--daemon", environment),
    undefined
  );
  assert.deepEqual(detachedDaemonEnvironment(environment), {
    PLUGIN_DATA: "/tmp/pinland-data"
  });
  assert.deepEqual(environment, {
    CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-task.sock",
    PLUGIN_DATA: "/tmp/pinland-data"
  });
});

test("only a Codex-hosted MCP invocation keeps its Desktop pipe", () => {
  const environment = {
    CODEX_APP_TOOLS_PIPE_PATH: " /tmp/codex-task.sock "
  };
  assert.equal(
    desktopToolsPipeForInvocation("--mcp", environment),
    "/tmp/codex-task.sock"
  );
  assert.equal(
    desktopToolsPipeForInvocation("--ensure-daemon", environment),
    "/tmp/codex-task.sock"
  );
});
