import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEMON_PROTOCOL_VERSION,
  daemonLeaseDisposition
} from "./daemon-lease-policy.mjs";

const options = {
  age: 10,
  staleMilliseconds: 15_000,
  processIsAlive: () => true
};

test("the current daemon protocol is version thirty", () => {
  assert.equal(DAEMON_PROTOCOL_VERSION, 30);
});

test("a live older daemon lease is replaced during upgrade", () => {
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION - 1,
    token: "old-owner",
    pid: 123
  }, options), "replace");
});

test("an older process never steals leadership back from a newer protocol", () => {
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION + 1,
    token: "future-owner",
    pid: 123
  }, options), "keep");
});

test("a live legacy unversioned leader lease is replaced during upgrade", () => {
  assert.equal(daemonLeaseDisposition({
    token: "legacy-leader",
    pid: 123
  }, options), "replace");
});

test("only a healthy current owner is kept", () => {
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION,
    token: "current-owner",
    pid: 123
  }, options), "keep");
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION,
    token: "dead-owner",
    pid: 123
  }, {
    ...options,
    processIsAlive: () => false
  }), "replace");
  assert.equal(daemonLeaseDisposition(undefined, options), "wait");
});

test("the stable daemon lease is independent of a Desktop host channel", () => {
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION,
    token: "owner",
    pid: 44,
    host_channel_id: "old-channel"
  }, {
    ...options,
    expectedHostChannelID: "new-channel"
  }), "keep");

  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION,
    token: "owner",
    pid: 44,
    host_channel_id: "same-channel"
  }, {
    ...options,
    expectedHostChannelID: "same-channel"
  }), "keep");
});

test("an older caller cannot replace a newer daemon", () => {
  assert.equal(daemonLeaseDisposition({
    protocol_version: DAEMON_PROTOCOL_VERSION + 1,
    token: "newer-owner",
    pid: 44,
    host_channel_id: "old-channel"
  }, {
    ...options,
    expectedHostChannelID: "new-channel"
  }), "keep");
});
