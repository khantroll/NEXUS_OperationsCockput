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
  public constructor(private readonly enrollment: HostEnrollmentRegistry, private readonly ttlMs = 5 * 60_000) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new RangeError("companion grant TTL is too short");
  }

  public authorize(request: CompanionRequest, now: string, nowMs = Date.parse(now)): CompanionAuthorization {
    if (!request.hostId.trim() || !request.clientId.trim() || !request.enrollmentToken.trim()) {
      return { accepted: false, reason: "invalid-request" };
    }
    if (!isCompanionCapability(request.capability)) return { accepted: false, reason: "invalid-request" };
    if (request.network !== "private") return { accepted: false, reason: "public-network" };
    if (!this.enrollment.authenticate(request.hostId, request.enrollmentToken)) {
      return { accepted: false, reason: "invalid-credentials" };
    }
    if (!Number.isFinite(nowMs)) return { accepted: false, reason: "invalid-request" };
    return {
      accepted: true,
      grant: {
        grantId: crypto.randomUUID(),
        hostId: request.hostId,
        clientId: request.clientId,
        capability: request.capability,
        issuedAt: now,
        expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      },
    };
  }
}

function isCompanionCapability(value: unknown): value is CompanionCapability {
  return value === "read-workspace" || value === "attach-read";
}
