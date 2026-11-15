import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../contracts/src/index.js";
import { SessionRegistry } from "../src/session.js";

const session: SessionRecord = {
  sessionId: "session-1",
  hostId: "host-1",
  hostBootEpoch: "boot-1",
  kind: "local-pty",
  transport: "connected",
  process: "running",
  recovery: "reconnectable",
  createdAt: "2026-11-15T00:00:00.000Z",
  lastObservedAt: "2026-11-15T00:00:00.000Z",
  pid: 42,
};

test("attachments reference a registered session and detach revokes its lease", () => {
  const registry = new SessionRegistry();
  registry.register(session);
  const attachment = registry.attach(session.sessionId, "operator", "write", "2026-11-15T00:00:00.000Z", "a-1");
  assert.equal(attachment.accepted, true);
  const lease = registry.acquireInputLease(
    session.sessionId,
    "a-1",
    "2026-11-15T00:05:00.000Z",
    1,
    "2026-11-15T00:01:00.000Z",
  );
  assert.equal(lease.accepted, true);
  assert.equal(registry.detach("a-1").accepted, true);
  assert.equal(registry.snapshot().leases.length, 0);
});

test("only one unexpired writer lease is granted", () => {
  const registry = new SessionRegistry();
  registry.register(session);
  registry.attach(session.sessionId, "one", "write", "2026-11-15T00:00:00.000Z", "a-1");
  registry.attach(session.sessionId, "two", "write", "2026-11-15T00:00:00.000Z", "a-2");
  assert.equal(registry.acquireInputLease(session.sessionId, "a-1", "2026-11-15T01:00:00.000Z", 1, "2026-11-15T00:00:00.000Z").accepted, true);
  const denied = registry.acquireInputLease(session.sessionId, "a-2", "2026-11-15T01:00:00.000Z", 1, "2026-11-15T00:00:00.000Z");
  assert.equal(denied.accepted, false);
  assert.equal(denied.reason, "lease-held");
});

test("read attachments cannot acquire input", () => {
  const registry = new SessionRegistry();
  registry.register(session);
  registry.attach(session.sessionId, "observer", "read", "2026-11-15T00:00:00.000Z", "a-1");
  const result = registry.acquireInputLease(session.sessionId, "a-1", "2026-11-15T01:00:00.000Z", 1, "2026-11-15T00:00:00.000Z");
  assert.equal(result.reason, "write-access-required");
});

test("expired leases are reclaimable", () => {
  const registry = new SessionRegistry();
  registry.register(session);
  registry.attach(session.sessionId, "one", "write", "2026-11-15T00:00:00.000Z", "a-1");
  registry.attach(session.sessionId, "two", "write", "2026-11-15T00:00:00.000Z", "a-2");
  registry.acquireInputLease(session.sessionId, "a-1", "2026-11-15T01:00:00.000Z", 1, "2026-11-15T00:30:00.000Z");
  registry.reapExpiredLeases("2026-11-15T01:00:00.000Z");
  assert.equal(registry.acquireInputLease(session.sessionId, "a-2", "2026-11-15T02:00:00.000Z", 2, "2026-11-15T01:00:00.000Z").accepted, true);
});
