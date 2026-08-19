import type { ProcessInstance } from "../data/types";

interface InstanceActorIdentity {
  id: string;
  name: string;
}

export const isProcessInstanceCreator = (
  instance: ProcessInstance,
  actor: InstanceActorIdentity,
) => instance.initiatorId
  ? instance.initiatorId === actor.id
  : instance.initiator === actor.name;

export const canEditProcessInstanceSubmission = (
  instance: ProcessInstance,
  actor: InstanceActorIdentity,
  hasSystemOverride = false,
) => hasSystemOverride || isProcessInstanceCreator(instance, actor);
