import type {
  EntityStatePayload,
  ScenePolicyState,
  SceneSnapshotPayload,
  SelectionStatePayload,
  ServerSceneState
} from "../shared/protocol.js";
import type { ScenePolicyStore } from "./scene-policy.js";
import type { SensorStore } from "./sensor-store.js";

export interface BoardModel {
  scene: ServerSceneState | null;
  entities: EntityStatePayload[];
  selection: SelectionStatePayload | null;
  targetId: number;
  self: EntityStatePayload | null;
  target: EntityStatePayload | null;
}

export function buildBoardModel(
  sensors: SensorStore,
  policy: ScenePolicyStore
): BoardModel {
  const scene = sensors.getScene();
  const entities = sensors.getEntities();
  const selection = sensors.getSelection();
  const self = entities.find((entity) => entity.isSelf) ?? null;
  const targetId = resolveTargetId(selection, entities, self);
  const target =
    targetId >= 0 ? entities.find((entity) => entity.id === targetId) ?? null : null;

  return {
    scene: buildServerScene(scene, policy),
    entities,
    selection,
    targetId,
    self,
    target
  };
}

function buildServerScene(
  scene: SceneSnapshotPayload | null,
  policy: ScenePolicyStore
): ServerSceneState | null {
  if (!scene) {
    return null;
  }
  const policyState: ScenePolicyState = policy.policyState(scene.sceneHash);
  return {
    ...scene,
    policy: policyState
  };
}

export function resolveTargetId(
  selection: SelectionStatePayload | null,
  entities: EntityStatePayload[] = [],
  self: EntityStatePayload | null = null
): number {
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
