import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface EnrolledHost {
  hostId: string;
  displayName: string;
  createdAt: string;
  revokedAt?: string;
}

export interface EnrollmentResult {
  host: EnrolledHost;
  /** Returned only at enrollment time; never retained by the registry. */
  enrollmentToken: string;
}

interface StoredHost extends EnrolledHost {
  tokenSalt: Buffer;
  tokenHash: Buffer;
}

/** In-memory enrollment policy; it stores token hashes, never raw enrollment tokens. */
export class HostEnrollmentRegistry {
  private readonly hosts = new Map<string, StoredHost>();

  public enroll(hostId: string, displayName: string, now: string): EnrollmentResult {
    if (!hostId.trim() || !displayName.trim()) throw new Error("host identity is required");
    if (this.hosts.has(hostId)) throw new Error(`host already enrolled: ${hostId}`);
    const enrollmentToken = randomBytes(32).toString("base64url");
    const tokenSalt = randomBytes(16);
    const host: StoredHost = { hostId, displayName, createdAt: now, tokenSalt, tokenHash: hashToken(enrollmentToken, tokenSalt) };
    this.hosts.set(hostId, host);
    return { host: publicHost(host), enrollmentToken };
  }

  public authenticate(hostId: string, enrollmentToken: string): boolean {
    const host = this.hosts.get(hostId);
    if (!host || host.revokedAt) return false;
    const candidate = hashToken(enrollmentToken, host.tokenSalt);
    return candidate.length === host.tokenHash.length && timingSafeEqual(candidate, host.tokenHash);
  }

  public revoke(hostId: string, now: string): boolean {
    const host = this.hosts.get(hostId);
    if (!host || host.revokedAt) return false;
    host.revokedAt = now;
    return true;
  }

  public get(hostId: string): EnrolledHost | undefined {
    const host = this.hosts.get(hostId);
    return host ? publicHost(host) : undefined;
  }
}

function hashToken(token: string, salt: Buffer): Buffer {
  return scryptSync(token, salt, 32, { N: 16_384, r: 8, p: 1 });
}

function publicHost(host: StoredHost): EnrolledHost {
  return {
    hostId: host.hostId,
    displayName: host.displayName,
    createdAt: host.createdAt,
    ...(host.revokedAt === undefined ? {} : { revokedAt: host.revokedAt }),
  };
}
