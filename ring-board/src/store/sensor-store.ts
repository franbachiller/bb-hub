import type {
  EntityStatePayload,
  ResolveEventPayload,
  SceneSnapshotPayload,
  SelectionStatePayload,
  SensorEnvelope
} from "../shared/protocol.js";

interface HistoryFrame {
  receivedAt: number;
  envelope: SensorEnvelope;
}

interface TrackedEntity {
  payload: EntityStatePayload;
  seenTs: number;
  seenWall: number;
}

export interface TimedEntityState {
  payload: EntityStatePayload;
  seenTs: number;
  seenWall: number;
}

export class SensorStore {
  private readonly bufferMs: number;

  private scene: SceneSnapshotPayload | null = null;

  private readonly entities = new Map<number, TrackedEntity>();

  private selection: SelectionStatePayload | null = null;

  private lastResolve: ResolveEventPayload | null = null;
  // Every 211 of the ring, not only the last one: two can land between evaluations.
  private recentResolves: ResolveEventPayload[] = [];

  private readonly history: HistoryFrame[] = [];

  private lastSensorTs = 0;

  private readonly entityTtlMs = 900;

  public constructor(bufferMs = 3000) {
    this.bufferMs = bufferMs;
  }

  public ingest(envelope: SensorEnvelope): void {
    const receivedAt = Date.now();
    this.lastSensorTs = envelope.ts;
    switch (envelope.type) {
      case "scene_snapshot":
        if (!this.scene || this.scene.sceneHash !== envelope.payload.sceneHash) {
          this.entities.clear();
          this.selection = null;
          this.lastResolve = null;
          this.recentResolves = [];
        }
        this.scene = envelope.payload;
        break;
      case "entity_state":
        this.entities.set(envelope.payload.id, {
          payload: envelope.payload,
          seenTs: envelope.ts,
          seenWall: receivedAt
        });
        break;
      case "selection_state":
        this.selection = envelope.payload;
        break;
      case "resolve_event":
        this.lastResolve = envelope.payload;
        this.recentResolves.push(envelope.payload);
        if (this.recentResolves.length > 32) this.recentResolves.shift();
        break;
      default:
        break;
    }
    this.history.push({ receivedAt, envelope });
    this.pruneHistory(receivedAt);
  }

  public getScene(): SceneSnapshotPayload | null {
    return this.scene;
  }

  public getSelection(): SelectionStatePayload | null {
    return this.selection;
  }

  public getLastResolve(): ResolveEventPayload | null {
    return this.lastResolve;
  }

  public getRecentResolves(): ResolveEventPayload[] {
    return [...this.recentResolves];
  }

  public getEntities(): EntityStatePayload[] {
    this.pruneEntities(Date.now(), this.lastSensorTs);
    return [...this.entities.values()]
      .map((tracked) => tracked.payload)
      .filter((entity) => !isPlaceholderEntity(entity))
      .sort((left, right) => left.id - right.id);
  }

  public getTimedEntities(): TimedEntityState[] {
    this.pruneEntities(Date.now(), this.lastSensorTs);
    return [...this.entities.values()]
      .filter((tracked) => !isPlaceholderEntity(tracked.payload))
      .map((tracked) => ({
        payload: tracked.payload,
        seenTs: tracked.seenTs,
        seenWall: tracked.seenWall
      }))
      .sort((left, right) => left.payload.id - right.payload.id);
  }

  public getLastSensorTs(): number {
    return this.lastSensorTs;
  }

  public getRecentHistory(): HistoryFrame[] {
    return [...this.history];
  }

  public reset(): void {
    this.scene = null;
    this.entities.clear();
    this.selection = null;
    this.lastResolve = null;
    this.recentResolves = [];
    this.history.length = 0;
    this.lastSensorTs = 0;
  }

  private pruneHistory(now: number): void {
    while (this.history.length > 0 && now - this.history[0].receivedAt > this.bufferMs) {
      this.history.shift();
    }
  }

  private pruneEntities(nowWall: number, nowTs: number): void {
    for (const [id, tracked] of this.entities) {
      const staleBySensorTs = nowTs > 0 && tracked.seenTs > 0 && nowTs - tracked.seenTs > this.entityTtlMs;
      const staleByWall = nowWall - tracked.seenWall > this.entityTtlMs;
      if (staleBySensorTs || staleByWall) {
        this.entities.delete(id);
      }
    }
  }
}

function isPlaceholderEntity(entity: EntityStatePayload): boolean {
  if (entity.isSelf) {
    return false;
  }
  return (
    Math.round(entity.x) === 0 &&
    Math.round(entity.y) === 0 &&
    entity.fromX === 0 &&
    entity.fromY === 0 &&
    entity.toX === 0 &&
    entity.toY === 0
  );
}
