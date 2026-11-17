import type { HostEnrollmentRegistry } from "./host-enrollment.js";

export type CompanionCapability = "read-workspace" | "attach-read";

export interface CompanionRequest {
  hostId: string;
  clientId: string;
  enrollmentToken: string;
  network: "private" | "public";
  capability: CompanionCapability;
}

export interface CompanionGrant {
  grantId: string;
  hostId: string;
  clientId: string;
  capability: CompanionCapability;
  issuedAt: string;
  expiresAt: string;
}

export type CompanionRejection = "public-network" | "invalid-credentials" | "invalid-request";

export type CompanionAuthorization =
  | { accepted: true; grant: CompanionGrant }
  | { accepted: false; reason: CompanionRejection };

/**
 * Policy-only boundary for the future private-network companion transport.
 * It deliberately exposes no generic exec, write-session, URL, or credential API.
 */
export class CompanionPolicy {
  private readonly grants = new Map<string, CompanionGrant>();
  private readonly enrollment: HostEnrollmentRegistry;
  private readonly ttlMs: number;

  // No parameter properties: the desktop host runs this file under Node's strip-only TypeScript mode.
  public constructor(enrollment: HostEnrollmentRegistry, ttlMs = 5 * 60_000) {
    this.enrollment = enrollment;
    this.ttlMs = ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new RangeError("companion grant TTL is too short");
  }

  public authorize(request: unknown, now: string, nowMs = Date.parse(now)): CompanionAuthorization {
    if (typeof request !== "object" || request === null) {
      return { accepted: false, reason: "invalid-request" };
    }
    const candidate = request as Partial<CompanionRequest>;
    if (typeof candidate.hostId !== "string" || typeof candidate.clientId !== "string" || typeof candidate.enrollmentToken !== "string" ||
      !candidate.hostId.trim() || !candidate.clientId.trim() || !candidate.enrollmentToken.trim() ||
      candidate.hostId.length > 128 || candidate.clientId.length > 128 || candidate.enrollmentToken.length > 128) {
      return { accepted: false, reason: "invalid-request" };
    }
    if (!isCompanionCapability(candidate.capability)) return { accepted: false, reason: "invalid-request" };
    if (candidate.network !== "private") return { accepted: false, reason: "public-network" };
    if (!this.enrollment.authenticate(candidate.hostId, candidate.enrollmentToken)) {
      return { accepted: false, reason: "invalid-credentials" };
    }
    if (!Number.isFinite(nowMs)) return { accepted: false, reason: "invalid-request" };
    const grant: CompanionGrant = {
      grantId: crypto.randomUUID(),
      hostId: candidate.hostId,
      clientId: candidate.clientId,
      capability: candidate.capability,
      issuedAt: now,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    this.grants.set(grant.grantId, grant);
    return {
      accepted: true,
      grant,
    };
  }

  public validateGrant(grantId: string, hostId: string, clientId: string, capability: CompanionCapability, now: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.hostId !== hostId || grant.clientId !== clientId || grant.capability !== capability) return false;
    if (this.enrollment.get(hostId)?.revokedAt !== undefined) {
      this.grants.delete(grantId);
      return false;
    }
    if (!Number.isFinite(Date.parse(now)) || Date.parse(grant.expiresAt) <= Date.parse(now)) {
      this.grants.delete(grantId);
      return false;
    }
    return true;
  }
}

function isCompanionCapability(value: unknown): value is CompanionCapability {
  return value === "read-workspace" || value === "attach-read";
}
