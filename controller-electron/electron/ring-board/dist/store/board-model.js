export function buildBoardModel(sensors, policy) {
    const scene = sensors.getScene();
    const entities = sensors.getEntities();
    const selection = sensors.getSelection();
    const self = entities.find((entity) => entity.isSelf) ?? null;
    const targetId = resolveTargetId(selection, entities, self);
    const target = targetId >= 0 ? entities.find((entity) => entity.id === targetId) ?? null : null;
    return {
        scene: buildServerScene(scene, policy),
        entities,
        selection,
        targetId,
        self,
        target
    };
}
function buildServerScene(scene, policy) {
    if (!scene) {
        return null;
    }
    const policyState = policy.policyState(scene.sceneHash);
    return {
        ...scene,
        policy: policyState
    };
}
export function resolveTargetId(selection, entities = [], self = null) {
    if (!selection) {
        return -1;
    }
    const ids = new Set(entities.map((entity) => entity.id));
    const selfId = self?.id ?? entities.find((entity) => entity.isSelf)?.id ?? -1;
    const candidates = [
        selection.lockedTarget,
        selection.punchTarget,
        selection.derivedTarget,
        selection.rawSelectedTarget,
        selection.pendingTarget
    ];
    for (const candidate of candidates) {
        if (candidate >= 0 && candidate !== selfId && (ids.size === 0 || ids.has(candidate))) {
            return candidate;
        }
    }
    return -1;
}
