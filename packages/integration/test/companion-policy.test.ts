import assert from "node:assert/strict";
import test from "node:test";
import { CompanionPolicy } from "../src/companion-policy.js";
import { HostEnrollmentRegistry } from "../src/host-enrollment.js";

test("companion policy grants bounded private read capabilities", () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const policy = new CompanionPolicy(enrollment, 60_000);
  const result = policy.authorize({
    hostId: issued.host.hostId,
    clientId: "browser-client",
    enrollmentToken: issued.enrollmentToken,
    network: "private",
    capability: "attach-read",
  }, "2026-11-16T01:00:00.000Z");
  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.equal(result.grant.capability, "attach-read");
    assert.equal(result.grant.expiresAt, "2026-11-16T01:01:00.000Z");
    assert.equal("enrollmentToken" in result.grant, false);
  }
});

test("companion policy rejects public, invalid, and malformed requests", () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const policy = new CompanionPolicy(enrollment);
  assert.deepEqual(policy.authorize({ hostId: issued.host.hostId, clientId: "client", enrollmentToken: issued.enrollmentToken, network: "public", capability: "read-workspace" }, "2026-11-16T01:00:00.000Z"), { accepted: false, reason: "public-network" });
  assert.deepEqual(policy.authorize({ hostId: issued.host.hostId, clientId: "client", enrollmentToken: "wrong", network: "private", capability: "read-workspace" }, "2026-11-16T01:00:00.000Z"), { accepted: false, reason: "invalid-credentials" });
  assert.deepEqual(policy.authorize({ hostId: "", clientId: "client", enrollmentToken: issued.enrollmentToken, network: "private", capability: "read-workspace" }, "2026-11-16T01:00:00.000Z"), { accepted: false, reason: "invalid-request" });
  assert.deepEqual(policy.authorize({ hostId: issued.host.hostId, clientId: "client", enrollmentToken: issued.enrollmentToken, network: "private", capability: "exec" } as unknown as Parameters<CompanionPolicy["authorize"]>[0], "2026-11-16T01:00:00.000Z"), { accepted: false, reason: "invalid-request" });
});
