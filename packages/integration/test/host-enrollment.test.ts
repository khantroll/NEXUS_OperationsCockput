import assert from "node:assert/strict";
import test from "node:test";
import { HostEnrollmentRegistry } from "../src/host-enrollment.js";

test("host enrollment authenticates and revocation fails closed", () => {
  const registry = new HostEnrollmentRegistry();
  const enrollment = registry.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  assert.deepEqual(enrollment.host, { hostId: "host-xenos", displayName: "Windows Xenos", createdAt: "2026-11-16T00:00:00.000Z" });
  assert.equal(enrollment.enrollmentToken.length, 43);
  assert.equal(registry.authenticate("host-xenos", enrollment.enrollmentToken), true);
  assert.equal(registry.authenticate("host-xenos", "wrong-token"), false);
  assert.equal(registry.revoke("host-xenos", "2026-11-16T01:00:00.000Z"), true);
  assert.equal(registry.authenticate("host-xenos", enrollment.enrollmentToken), false);
  assert.deepEqual(registry.get("host-xenos"), { ...enrollment.host, revokedAt: "2026-11-16T01:00:00.000Z" });
});

test("enrollment generates tokens and rejects duplicate hosts", () => {
  const registry = new HostEnrollmentRegistry();
  registry.enroll("host", "Host", "2026-11-16T00:00:00.000Z");
  assert.throws(() => registry.enroll("host", "Host", "2026-11-16T00:00:00.000Z"), /already enrolled/);
  assert.throws(() => registry.enroll("bad host", "Host", "2026-11-16T00:00:00.000Z"), /identity/);
  assert.throws(() => registry.enroll("host-two", "Host", "not-a-time"), /timestamp/);
});
