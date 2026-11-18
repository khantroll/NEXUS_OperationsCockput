import type { SessionRecord } from "../../contracts/src/index.js";
import type { CompanionReadModel, CompanionSessionView } from "./companion-http.js";

/** Minimal read-only view of the metadata store; keeps this adapter free of a storage dependency. */
export interface SessionRecordSource {
  listSessions(): readonly SessionRecord[];
}

/**
 * Adapts persisted session metadata to the companion read model. It exposes only
 * the four state fields the companion contract allows (no PID, exit code, epoch,
 * timestamps, or recovery detail) and only for the requested host, so a grant for
 * one host cannot enumerate another host's sessions.
 *
 * This serves persisted metadata, not live supervisor state. Callers must run
 * `MetadataStore.reconcileSupervisorRestart(currentBootEpoch)` before serving, or sessions left
 * over from a previous run would still read as running/connected.
 */
export function createMetadataReadModel(source: SessionRecordSource): CompanionReadModel {
  return {
    listSessions(hostId: string): readonly CompanionSessionView[] {
      return source.listSessions()
        .filter((session) => session.hostId === hostId)
        .map((session) => ({
          sessionId: session.sessionId,
          kind: session.kind,
          process: session.process,
          transport: session.transport,
        }));
    },
  };
}
