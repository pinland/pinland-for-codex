import http from "node:http";

export const DESKTOP_INSTRUCTION_PROVIDER_PORT = 53_633;

const DEFAULT_TIMEOUT_MS = 13_500;
const DEFINITELY_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH"
]);

function unavailableResult() {
  return { accepted: false, error_code: "codex_unavailable" };
}

function uncertainResult() {
  return { accepted: false, error_code: "delivery_uncertain" };
}

function normalizedProviderResult(command, response) {
  if (response?.schema_version !== 1
      || response?.command_id !== command.command_id
      || typeof response?.accepted !== "boolean") {
    return uncertainResult();
  }
  if (response.accepted) return { accepted: true };
  if (typeof response.error_code !== "string"
      || !response.error_code
      || response.error_code.length > 128) {
    return uncertainResult();
  }
  return { accepted: false, error_code: response.error_code };
}

/**
 * Makes one authenticated request to the currently elected Codex-hosted
 * Desktop provider. Connection refusal is known to precede delivery; every
 * other transport failure is outcome-unknown and must never trigger fallback.
 */
export function requestDesktopInstructionProvider(
  command,
  token,
  options = {}
) {
  const host = options.host || "127.0.0.1";
  const port = Number.isSafeInteger(options.port)
    ? options.port
    : DESKTOP_INSTRUCTION_PROVIDER_PORT;
  const timeoutMilliseconds = Number.isFinite(options.timeoutMilliseconds)
    ? Math.max(1, options.timeoutMilliseconds)
    : DEFAULT_TIMEOUT_MS;
  const payload = Buffer.from(JSON.stringify(command));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const outgoing = http.request({
      host,
      port,
      path: "/v1/instructions/send",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": payload.length
      }
    }, (response) => {
      const chunks = [];
      let byteCount = 0;
      response.on("data", (chunk) => {
        byteCount += chunk.length;
        if (byteCount <= 64 * 1_024) chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode === 401
            || response.statusCode === 404
            || response.statusCode === 503) {
          finish(unavailableResult());
          return;
        }
        if (response.statusCode !== 200 || byteCount > 64 * 1_024) {
          finish(uncertainResult());
          return;
        }
        try {
          finish(normalizedProviderResult(
            command,
            JSON.parse(Buffer.concat(chunks).toString("utf8"))
          ));
        } catch {
          finish(uncertainResult());
        }
      });
    });
    outgoing.setTimeout(timeoutMilliseconds, () => {
      const error = Object.assign(new Error("Desktop provider timed out"), {
        code: "ETIMEDOUT"
      });
      outgoing.destroy(error);
    });
    outgoing.on("error", (error) => finish(
      DEFINITELY_UNAVAILABLE_CODES.has(error?.code)
        ? unavailableResult()
        : uncertainResult()
    ));
    outgoing.end(payload);
  });
}

/**
 * Reserves the command id before crossing into a Codex-hosted provider. A
 * definitely unavailable provider releases that reservation so the caller may
 * make one synchronous app-server attempt. Accepted or uncertain outcomes are
 * tombstoned and never retried locally.
 */
export async function dispatchInstructionWithDesktopProvider(
  command,
  token,
  ledger,
  options = {}
) {
  let replay;
  try {
    replay = ledger.beginDispatch(command.command_id);
  } catch {
    return { result: { accepted: false, error_code: "request_failed" } };
  }
  if (replay) return { result: replay };

  const dispatch = typeof options.dispatch === "function"
    ? options.dispatch
    : requestDesktopInstructionProvider;
  let result;
  try {
    result = await dispatch(command, token, options);
  } catch {
    result = uncertainResult();
  }

  if (result?.accepted !== true && result?.error_code === "codex_unavailable") {
    try {
      if (ledger.releaseDispatch(command.command_id)) {
        return { result, fallbackToOwner: true };
      }
    } catch {
      // A lost reservation cannot safely fall through to another writer.
    }
    return { result: uncertainResult() };
  }

  try {
    ledger.recordResult(command.command_id, result);
    return { result };
  } catch {
    return {
      result: result?.accepted === true
        || result?.error_code === "delivery_uncertain"
        ? uncertainResult()
        : result
    };
  }
}
