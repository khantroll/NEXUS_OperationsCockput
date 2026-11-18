import type { CompanionOutputSource } from "@nexus/integration/companion-http";

/** The slice of PtySupervisor this adapter needs; structural so it can be tested without node-pty. */
export interface OutputAttachable {
  attach(sessionId: string, mode: "read"): { readonly replay: string; detach(): void };
}

/**
 * Read-only terminal output for one host's supervisor. It only ever opens a `read` attachment, always
 * detaches, returns null for another host or an unknown/disposed session, and does not distinguish the
 * two (so the caller cannot use it as a host oracle). Output size is bounded by the supervisor's replay
 * buffer and again by the HTTP layer.
 */
export function createSupervisorOutputSource(supervisor: OutputAttachable, hostId: string): CompanionOutputSource {
  return {
    readOutput(requestedHostId: string, sessionId: string): string | null {
      if (requestedHostId !== hostId) return null;
      let handle: { readonly replay: string; detach(): void };
      try {
        handle = supervisor.attach(sessionId, "read");
      } catch {
        return null;
      }
      try {
        return handle.replay;
      } finally {
        handle.detach();
      }
    },
  };
}
