import type {
  CommandEnvelope,
  CommandResult,
  HomeAnchor,
  PanelCommand,
  PanelRecord,
} from "../../contracts/src/index.js";

export interface PanelTransition {
  record: PanelRecord;
  result: CommandResult;
}

export type AuthorizePanelCommand = (actorId: string, command: PanelCommand) => boolean;

function accepted(requestId: string, record: PanelRecord): PanelTransition {
  return {
    record,
    result: { requestId, accepted: true, revision: record.revision },
  };
}

function rejected(
  requestId: string,
  current: PanelRecord,
  reason: NonNullable<CommandResult["reason"]>,
): PanelTransition {
  return { record: current, result: { requestId, accepted: false, reason } };
}

function sameAnchor(left: HomeAnchor, right: HomeAnchor): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId &&
    left.tabIndex === right.tabIndex &&
    left.fallbackZone === right.fallbackZone &&
    left.displayId === right.displayId &&
    left.layoutRevision === right.layoutRevision &&
    left.splitPath.length === right.splitPath.length &&
    left.splitPath.every((part, index) => part === right.splitPath[index])
  );
}

/**
 * Applies a presentation-only panel command.
 *
 * This reducer deliberately has no session/process dependency: moving a panel
 * cannot spawn, kill, or otherwise mutate the host-owned session.
 */
export function applyPanelCommand(
  current: PanelRecord,
  envelope: CommandEnvelope<PanelCommand>,
): PanelTransition {
  if (envelope.expectedRevision !== current.revision) {
    return rejected(envelope.requestId, current, "stale-revision");
  }

  const command = envelope.payload;
  switch (command.op) {
    case "park":
      return command.panelId !== current.panelId
        ? rejected(envelope.requestId, current, "invalid-command")
        : current.placement === "parked"
          ? accepted(envelope.requestId, current)
          : (() => {
              const { surfaceId: _surfaceId, ...withoutSurface } = current;
              return accepted(envelope.requestId, {
                ...withoutSurface,
                placement: "parked",
                revision: current.revision + 1,
              });
            })();

    case "summon":
      return command.panelId !== current.panelId || command.targetSurface.length === 0
        ? rejected(envelope.requestId, current, "invalid-command")
        : current.placement === "focused" && current.surfaceId === command.targetSurface
          ? accepted(envelope.requestId, current)
          : accepted(envelope.requestId, {
              ...current,
              placement: "focused",
              surfaceId: command.targetSurface,
              revision: current.revision + 1,
            });

    case "snapBack":
      return command.panelId !== current.panelId
        ? rejected(envelope.requestId, current, "invalid-command")
        : current.placement === "docked"
          ? accepted(envelope.requestId, current)
          : (() => {
              const { surfaceId: _surfaceId, ...withoutSurface } = current;
              return accepted(envelope.requestId, {
                ...withoutSurface,
                placement: "docked",
                revision: current.revision + 1,
              });
            })();

    case "setHome":
      return command.panelId !== current.panelId
        ? rejected(envelope.requestId, current, "invalid-command")
        : sameAnchor(current.homeAnchor, command.anchor)
          ? accepted(envelope.requestId, current)
          : accepted(envelope.requestId, {
              ...current,
              homeAnchor: command.anchor,
              revision: current.revision + 1,
            });
  }
}

/**
 * Command-boundary concerns that a pure reducer cannot own: authorization and
 * replaying a completed request when a client retries after a lost response.
 * Anchor resolution still belongs to the layout/persistence adapter; this
 * processor only records the panel's presentation state transition.
 */
export class PanelCommandProcessor {
  private readonly completed = new Map<string, { fingerprint: string; transition: PanelTransition }>();

  /** Callers must provide policy; omission fails closed. */
  public constructor(private readonly authorize: AuthorizePanelCommand = () => false) {}

  public process(current: PanelRecord, envelope: CommandEnvelope<PanelCommand>): PanelTransition {
    const fingerprint = JSON.stringify([envelope.actorId, envelope.expectedRevision, envelope.payload]);
    const previous = this.completed.get(envelope.requestId);
    if (previous) {
      return previous.fingerprint === fingerprint
        ? previous.transition
        : rejected(envelope.requestId, current, "invalid-command");
    }

    const transition = this.authorize(envelope.actorId, envelope.payload)
      ? applyPanelCommand(current, envelope)
      : rejected(envelope.requestId, current, "unauthorized");
    this.completed.set(envelope.requestId, { fingerprint, transition });
    return transition;
  }
}
