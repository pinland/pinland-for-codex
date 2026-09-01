import { timingSafeEqual } from "node:crypto";
import http from "node:http";

import { normalizeInstructionCommand } from "./outbound-instructions.mjs";

export const DIRECT_INSTRUCTION_HOST = "127.0.0.1";
export const DIRECT_INSTRUCTION_PORT = 53_632;

const MAX_REQUEST_BYTES = 32 * 1_024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function writeResponse(response, statusCode, payload) {
  const body = payload === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Connection": "close",
    "Content-Length": body.length,
    ...(body.length ? { "Content-Type": "application/json; charset=utf-8" } : {})
  });
  response.end(body);
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length);
}

function tokensMatch(received, expected) {
  if (!TOKEN_PATTERN.test(received || "") || !TOKEN_PATTERN.test(expected || "")) {
    return false;
  }
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes);
}

function normalizedResult(command, result) {
  if (result?.accepted === true) {
    return {
      schema_version: 1,
      command_id: command.command_id,
      accepted: true
    };
  }
  const errorCode = typeof result?.error_code === "string"
    && result.error_code.length <= 128
    ? result.error_code
    : "request_failed";
  return {
    schema_version: 1,
    command_id: command.command_id,
    accepted: false,
    error_code: errorCode
  };
}

async function readJSONBody(request) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(contentLength)
      || contentLength <= 0
      || contentLength > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("invalid body size"), { statusCode: 413 });
  }
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (byteCount !== contentLength) {
    throw Object.assign(new Error("incomplete request body"), { statusCode: 400 });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

export function createDirectInstructionServer({
  host = DIRECT_INSTRUCTION_HOST,
  port = DIRECT_INSTRUCTION_PORT,
  tokenProvider,
  dispatch
}) {
  if (typeof tokenProvider !== "function" || typeof dispatch !== "function") {
    throw new TypeError("tokenProvider and dispatch are required");
  }
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/instructions/send") {
      writeResponse(response, 404);
      return;
    }
    if (!tokensMatch(bearerToken(request), tokenProvider())) {
      writeResponse(response, 401);
      return;
    }

    let command;
    try {
      command = normalizeInstructionCommand(await readJSONBody(request));
    } catch (error) {
      writeResponse(response, error?.statusCode === 413 ? 413 : 400);
      return;
    }
    if (!command) {
      writeResponse(response, 400);
      return;
    }

    let result;
    try {
      result = await dispatch(command);
    } catch {
      result = { accepted: false, error_code: "request_failed" };
    }
    writeResponse(response, 200, normalizedResult(command, result));
  });
  // The one-shot listener below reports startup failures. Keep a permanent
  // handler as well so a later socket error cannot terminate the companion.
  server.on("error", () => {});

  return {
    server,
    async start(options = {}) {
      const addressInUseRetryCount = Number.isSafeInteger(
        options.addressInUseRetryCount
      )
        ? Math.max(0, options.addressInUseRetryCount)
        : 0;
      const retryDelayMilliseconds = Number.isFinite(
        options.retryDelayMilliseconds
      )
        ? Math.max(1, options.retryDelayMilliseconds)
        : 250;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => {
              server.off("listening", onListening);
              reject(error);
            };
            const onListening = () => {
              server.off("error", onError);
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, host);
          });
          return server.address();
        } catch (error) {
          if (error?.code !== "EADDRINUSE"
              || attempt >= addressInUseRetryCount) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(
            resolve,
            retryDelayMilliseconds
          ));
        }
      }
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
