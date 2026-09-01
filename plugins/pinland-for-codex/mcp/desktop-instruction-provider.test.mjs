import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dispatchInstructionWithDesktopProvider,
  requestDesktopInstructionProvider
} from "./desktop-instruction-provider.mjs";
import { createDirectInstructionServer } from "./direct-instruction-server.mjs";
import { InstructionCommandLedger } from "./instruction-command-ledger.mjs";

const token = "a".repeat(64);
const command = {
  schema_version: 1,
  command_id: "123e4567-e89b-42d3-a456-426614174000",
  session_id: "01a0585f-67de-7b01-bc71-f8aab309c65a",
  prompt: "Continue exactly once"
};

function temporaryLedger(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinland-provider-ledger-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new InstructionCommandLedger(directory);
}

test("the daemon records one accepted Desktop delivery", async (t) => {
  const ledger = temporaryLedger(t);
  let calls = 0;
  const first = await dispatchInstructionWithDesktopProvider(
    command,
    token,
    ledger,
    {
      async dispatch() {
        calls += 1;
        return { accepted: true };
      }
    }
  );
  const replay = await dispatchInstructionWithDesktopProvider(
    command,
    token,
    ledger,
    {
      async dispatch() {
        calls += 1;
        return { accepted: true };
      }
    }
  );
  assert.deepEqual(first, { result: { accepted: true } });
  assert.deepEqual(replay, { result: { accepted: true } });
  assert.equal(calls, 1);
});

test("a definitely unavailable provider releases the fallback reservation", async (t) => {
  const ledger = temporaryLedger(t);
  const result = await dispatchInstructionWithDesktopProvider(
    command,
    token,
    ledger,
    {
      async dispatch() {
        return { accepted: false, error_code: "codex_unavailable" };
      }
    }
  );
  assert.deepEqual(result, {
    result: { accepted: false, error_code: "codex_unavailable" },
    fallbackToOwner: true
  });
  assert.equal(ledger.resultFor(command.command_id), undefined);
});

test("an uncertain provider result is tombstoned without fallback", async (t) => {
  const ledger = temporaryLedger(t);
  const result = await dispatchInstructionWithDesktopProvider(
    command,
    token,
    ledger,
    {
      async dispatch() {
        return { accepted: false, error_code: "delivery_uncertain" };
      }
    }
  );
  assert.deepEqual(result, {
    result: { accepted: false, error_code: "delivery_uncertain" }
  });
  assert.deepEqual(ledger.resultFor(command.command_id), {
    accepted: false,
    error_code: "delivery_uncertain"
  });
});

test("the authenticated provider client preserves the host result", async (t) => {
  const provider = createDirectInstructionServer({
    port: 0,
    tokenProvider: () => token,
    dispatch: async () => ({ accepted: true })
  });
  const address = await provider.start();
  t.after(() => provider.close());
  assert.deepEqual(await requestDesktopInstructionProvider(command, token, {
    port: address.port
  }), { accepted: true });
});

test("connection refusal is safe to fall back but a reset is uncertain", async (t) => {
  const unused = http.createServer();
  await new Promise((resolve, reject) => {
    unused.once("error", reject);
    unused.listen(0, "127.0.0.1", resolve);
  });
  const refusedPort = unused.address().port;
  await new Promise((resolve) => unused.close(resolve));
  assert.deepEqual(await requestDesktopInstructionProvider(command, token, {
    port: refusedPort,
    timeoutMilliseconds: 500
  }), { accepted: false, error_code: "codex_unavailable" });

  const reset = http.createServer((request) => request.socket.destroy());
  await new Promise((resolve, reject) => {
    reset.once("error", reject);
    reset.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => reset.close(resolve)));
  assert.deepEqual(await requestDesktopInstructionProvider(command, token, {
    port: reset.address().port,
    timeoutMilliseconds: 500
  }), { accepted: false, error_code: "delivery_uncertain" });
});
