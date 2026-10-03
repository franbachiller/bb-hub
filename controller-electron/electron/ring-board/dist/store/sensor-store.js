export class SensorStore {
    constructor(bufferMs = 3000) {
        this.scene = null;
        this.entities = new Map();
        this.selection = null;
        this.lastResolve = null;
        // Every 211 of the ring, not only the last one: two can land between evaluations.
        this.recentResolves = [];
        this.history = [];
        this.lastSensorTs = 0;
        this.entityTtlMs = 900;
        this.bufferMs = bufferMs;
    }
    ingest(envelope) {
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
                if (this.recentResolves.length > 32)
                    this.recentResolves.shift();
                break;
            default:
                break;
        }
        this.history.push({ receivedAt, envelope });
        this.pruneHistory(receivedAt);
    }
    getScene() {
        return this.scene;
    }
    getSelection() {
        return this.selection;
    }
    getLastResolve() {
        return this.lastResolve;
    }
    getRecentResolves() {
        return [...this.recentResolves];
    }
    getEntities() {
        this.pruneEntities(Date.now(), this.lastSensorTs);
        return [...this.entities.values()]
            .map((tracked) => tracked.payload)
            .filter((entity) => !isPlaceholderEntity(entity))
            .sort((left, right) => left.id - right.id);
    }
    getTimedEntities() {
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
    getLastSensorTs() {
        return this.lastSensorTs;
    }
    getRecentHistory() {
        return [...this.history];
    }
    reset() {
        this.scene = null;
        this.entities.clear();
        this.selection = null;
        this.lastResolve = null;
        this.recentResolves = [];
        this.history.length = 0;
        this.lastSensorTs = 0;
    }
    pruneHistory(now) {
        while (this.history.length > 0 && now - this.history[0].receivedAt > this.bufferMs) {
            this.history.shift();
        }
    }
    pruneEntities(nowWall, nowTs) {
        for (const [id, tracked] of this.entities) {
            const staleBySensorTs = nowTs > 0 && tracked.seenTs > 0 && nowTs - tracked.seenTs > this.entityTtlMs;
            const staleByWall = nowWall - tracked.seenWall > this.entityTtlMs;
            if (staleBySensorTs || staleByWall) {
                this.entities.delete(id);
            }
        }
    }
}
function isPlaceholderEntity(entity) {
    if (entity.isSelf) {
        return false;
    }
    return (Math.round(entity.x) === 0 &&
        Math.round(entity.y) === 0 &&
        entity.fromX === 0 &&
        entity.fromY === 0 &&
        entity.toX === 0 &&
        entity.toY === 0);
}
