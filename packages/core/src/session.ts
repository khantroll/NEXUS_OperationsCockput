import type { AttachmentRecord, InputLease, SessionRecord } from "../../contracts/src/index.js";

export type SessionFailure = "unknown-session" | "unknown-attachment" | "write-access-required" | "lease-held";

export interface SessionOperation<T> {
  value?: T;
  accepted: boolean;
  reason?: SessionFailure;
}

export interface SessionRegistrySnapshot {
  sessions: readonly SessionRecord[];
  attachments: readonly AttachmentRecord[];
  leases: readonly InputLease[];
}

/** In-memory control-plane primitive; it does not create, kill, or inspect OS processes. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly leases = new Map<string, InputLease>();

  public register(session: SessionRecord): void {
    this.sessions.set(session.sessionId, session);
  }

  public attach(
    sessionId: string,
    clientId: string,
    mode: AttachmentRecord["mode"],
    now: string,
    id: string = crypto.randomUUID(),
  ): SessionOperation<AttachmentRecord> {
    if (!this.sessions.has(sessionId)) return { accepted: false, reason: "unknown-session" };
    const attachment: AttachmentRecord = { attachmentId: id, sessionId, clientId, mode, createdAt: now };
    this.attachments.set(id, attachment);
    return { accepted: true, value: attachment };
  }

  public detach(attachmentId: string): SessionOperation<undefined> {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) return { accepted: false, reason: "unknown-attachment" };
    this.attachments.delete(attachmentId);
    const lease = this.leases.get(attachment.sessionId);
    if (lease?.attachmentId === attachmentId) this.leases.delete(attachment.sessionId);
    return { accepted: true };
  }

  public acquireInputLease(
    sessionId: string,
    attachmentId: string,
    expiresAt: string,
    revision: number,
    now: string,
  ): SessionOperation<InputLease> {
    const attachment = this.attachments.get(attachmentId);
    if (!this.sessions.has(sessionId)) return { accepted: false, reason: "unknown-session" };
    if (!attachment || attachment.sessionId !== sessionId) return { accepted: false, reason: "unknown-attachment" };
    if (attachment.mode !== "write") return { accepted: false, reason: "write-access-required" };
    const existing = this.leases.get(sessionId);
    if (existing && existing.expiresAt > now && existing.attachmentId !== attachmentId) {
      return { accepted: false, reason: "lease-held" };
    }
    const lease: InputLease = { sessionId, attachmentId, expiresAt, revision };
    this.leases.set(sessionId, lease);
    return { accepted: true, value: lease };
  }

  public reapExpiredLeases(now: string): void {
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(sessionId);
    }
  }

  public snapshot(): SessionRegistrySnapshot {
    return {
      sessions: [...this.sessions.values()],
      attachments: [...this.attachments.values()],
      leases: [...this.leases.values()],
    };
  }
}
