import type {
  FireControlOptions,
  FireCommandMessage,
  MoveCommandMessage,
  MovePlanCommandMessage,
  ServerStateSnapshot
} from "../shared/protocol.js";

export interface BrainWorkerEvaluateMessage {
  type: "evaluate";
  seq: number;
  epoch: number;
  snapshot: ServerStateSnapshot;
  fireOptions: FireControlOptions;
}

export interface BrainWorkerResetMessage {
  type: "reset";
  epoch: number;
  clearSessionMemory?: boolean;
}

export type BrainWorkerRequest = BrainWorkerEvaluateMessage | BrainWorkerResetMessage;

export interface BrainWorkerResultMessage {
  type: "result";
  seq: number;
  epoch: number;
  snapshot: ServerStateSnapshot;
  move: MoveCommandMessage | MovePlanCommandMessage | null;
  fire: FireCommandMessage | null;
}

export type BrainWorkerResponse = BrainWorkerResultMessage;
