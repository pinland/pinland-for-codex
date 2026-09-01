import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createDirectInstructionServer } from "./direct-instruction-server.mjs";

const token = "a".repeat(64);
const command = {
  schema_version: 1,
  command_id: "123e4567-e89b-42d3-a456-426614174000",
  session_id: "01a0585f-67de-7b01-bc71-f8aab309c65a",
  prompt: "Send exactly once"
};

function request(address, { authorization = token, body = command } = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/instructions/send",
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorization}`,
        "Content-Type": "application/json",
        "Content-Length": payload.length
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        json: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

test("one authenticated HTTP request dispatches exactly one Codex message", async () => {
  const calls = [];
  const endpoint = createDirectInstructionServer({
    port: 0,
    tokenProvider: () => token,
    dispatch: async (value) => {
      calls.push(value);
      return { accepted: true };
    }
  });
  const address = await endpoint.start();
  try {
    const response = await request(address);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      schema_version: 1,
      command_id: command.command_id,
      accepted: true
    });
    assert.deepEqual(calls, [{
      schema_version: 1,
      command_id: command.command_id,
      session_id: command.session_id,
      prompt: command.prompt
    }]);
  } finally {
    await endpoint.close();
  }
});

test("authentication and malformed requests fail before dispatch", async () => {
  let callCount = 0;
  const endpoint = createDirectInstructionServer({
    port: 0,
    tokenProvider: () => token,
    dispatch: async () => {
      callCount += 1;
      return { accepted: true };
    }
  });
  const address = await endpoint.start();
  try {
    assert.equal((await request(address, { authorization: "b".repeat(64) })).status, 401);
    assert.equal((await request(address, {
      body: { ...command, session_id: "not a task id" }
    })).status, 400);
    assert.equal(callCount, 0);
  } finally {
    await endpoint.close();
  }
});

test("definite and uncertain host results return without local retry", async () => {
  const results = [
    { accepted: false, error_code: "thread_unavailable" },
    { accepted: false, error_code: "delivery_uncertain" }
  ];
  const endpoint = createDirectInstructionServer({
    port: 0,
    tokenProvider: () => token,
    dispatch: async () => results.shift()
  });
  const address = await endpoint.start();
  try {
    assert.deepEqual((await request(address)).json, {
      schema_version: 1,
      command_id: command.command_id,
      accepted: false,
      error_code: "thread_unavailable"
    });
    assert.deepEqual((await request(address)).json, {
      schema_version: 1,
      command_id: command.command_id,
      accepted: false,
      error_code: "delivery_uncertain"
    });
  } finally {
    await endpoint.close();
  }
});

test("daemon handoff waits briefly for the previous owner to release its port", async (t) => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  const endpoint = createDirectInstructionServer({
    port,
    tokenProvider: () => token,
    dispatch: async () => ({ accepted: true })
  });
  t.after(async () => {
    if (blocker.listening) {
      await new Promise((resolve) => blocker.close(resolve));
    }
    await endpoint.close();
  });

  setTimeout(() => blocker.close(), 25);
  const address = await endpoint.start({
    addressInUseRetryCount: 10,
    retryDelayMilliseconds: 10
  });
  assert.equal(address.port, port);
});
