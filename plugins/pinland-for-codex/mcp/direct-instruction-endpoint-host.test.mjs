import assert from "node:assert/strict";
import test from "node:test";

import { DirectInstructionEndpointHost } from "./direct-instruction-endpoint-host.mjs";

test("a detached process never binds without a verified Desktop channel", async () => {
  let created = 0;
  const host = new DirectInstructionEndpointHost({
    async warmHostChannel() { return false; },
    createEndpoint() {
      created += 1;
      return { async start() {}, async close() {} };
    }
  });

  assert.equal(await host.acquire(), false);
  assert.equal(created, 0);
  await host.close();
});

test("concurrent MCP followers elect one loopback endpoint owner", async () => {
  let created = 0;
  let started = 0;
  let closed = 0;
  const host = new DirectInstructionEndpointHost({
    async warmHostChannel() { return true; },
    createEndpoint() {
      created += 1;
      return {
        async start() { started += 1; },
        async close() { closed += 1; }
      };
    }
  });

  assert.deepEqual(await Promise.all([
    host.acquire(), host.acquire(), host.acquire()
  ]), [true, true, true]);
  assert.equal(created, 1);
  assert.equal(started, 1);
  await host.close();
  assert.equal(closed, 1);
});

test("a follower can retry after another process owns the port", async () => {
  let attempts = 0;
  const host = new DirectInstructionEndpointHost({
    async warmHostChannel() { return true; },
    createEndpoint() {
      attempts += 1;
      return {
        async start() {
          if (attempts === 1) {
            throw Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
          }
        },
        async close() {}
      };
    }
  });

  assert.equal(await host.acquire(), false);
  assert.equal(await host.acquire(), true);
  assert.equal(attempts, 2);
  await host.close();
});
