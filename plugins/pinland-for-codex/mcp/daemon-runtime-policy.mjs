import { codexAppToolsPipePath } from "./codex-app-tools-client.mjs";

const DESKTOP_PIPE_KEY = "CODEX_APP_TOOLS_PIPE_PATH";

export function desktopToolsPipeForInvocation(
  invocationMode,
  environment = process.env
) {
  return invocationMode === "--daemon"
    ? undefined
    : codexAppToolsPipePath(environment);
}

export function detachedDaemonEnvironment(environment = process.env) {
  const daemonEnvironment = { ...environment };
  delete daemonEnvironment[DESKTOP_PIPE_KEY];
  return daemonEnvironment;
}
