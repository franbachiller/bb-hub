import type { EntityStatePayload, ServerStateSnapshot } from "../shared/protocol.js";

interface StandbyEntry {
  role: "ATTACKER" | "DEFENDER";
  untilTs: number;
  targetId: number;
  resolveTs: number;
}

const ATTACKER_STANDBY_MS = 260;
const DEFENDER_STANDBY_MS = 340;

export class ResolveStandbyTracker {
  private lastResolveTs = -1;

  private readonly entries = new Map<number, StandbyEntry>();

  public reset(): void {
    this.lastResolveTs = -1;
    this.entries.clear();
  }

  public decorate(snapshot: ServerStateSnapshot): ServerStateSnapshot {
    this.applyResolve(snapshot);
    this.gc(snapshot.nowTs);

    if (this.entries.size === 0) {
      return snapshot;
    }

    const entities = snapshot.entities.map((entity) => decorateEntity(entity, this.entries.get(entity.id), snapshot.nowTs));
    return {
      ...snapshot,
      entities
    };
  }

  private applyResolve(snapshot: ServerStateSnapshot): void {
    const resolve = snapshot.lastResolve;
    if (!resolve || resolve.timestamp <= 0 || resolve.timestamp === this.lastResolveTs) {
      return;
    }
    this.lastResolveTs = resolve.timestamp;

    if (resolve.attackerId >= 0) {
      this.entries.set(resolve.attackerId, {
        role: "ATTACKER",
        untilTs: resolve.timestamp + ATTACKER_STANDBY_MS,
        targetId: resolve.defenderId,
        resolveTs: resolve.timestamp
      });
    }
    if (resolve.defenderId >= 0) {
      this.entries.set(resolve.defenderId, {
        role: "DEFENDER",
        untilTs: resolve.timestamp + DEFENDER_STANDBY_MS,
        targetId: resolve.attackerId,
        resolveTs: resolve.timestamp
      });
    }
  }

  private gc(nowTs: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.untilTs <= nowTs) {
        this.entries.delete(id);
      }
    }
  }
}

function decorateEntity(
  entity: EntityStatePayload,
  entry: StandbyEntry | undefined,
  nowTs: number
): EntityStatePayload {
  if (!entry || entry.untilTs <= nowTs) {
    if (
      entity.standbyRole ||
      entity.standbyUntilTs != null ||
      entity.standbyRemainingMs != null ||
      entity.standbyTargetId != null
    ) {
      return {
        ...entity,
        standbyRole: undefined,
        standbyUntilTs: undefined,
        standbyRemainingMs: undefined,
        standbyTargetId: undefined
      };
    }
    return entity;
  }

  return {
    ...entity,
    standbyRole: entry.role,
    standbyUntilTs: entry.untilTs,
    standbyRemainingMs: Math.max(0, entry.untilTs - nowTs),
    standbyTargetId: entry.targetId
  };
}
