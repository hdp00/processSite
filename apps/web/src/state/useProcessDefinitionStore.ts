import { create } from "zustand";
import type { ProcessInstance } from "../data/types";
import type { CompleteDesignerSnapshot } from "../utils/designerStorage";

export type DefinitionType = "approval" | "free";
export type DefinitionStatus = "未发布" | "已发布" | "已停用";
export type VersionStatus = "校验未通过" | "可发布" | "已发布";
export type VersionValidationStatus = "通过" | "未通过";

export interface ProcessBasicConfig {
  name: string;
  code: string;
  instancePrefix: string;
  type: DefinitionType;
  description: string;
  starterGroups: string[];
  closeGroups: string[];
  assigneeGroups?: string[];
  emailNotificationEnabled: boolean;
  visibleRoles: string[];
  visibleUsers: string[];
}

export interface VersionValidation {
  status: VersionValidationStatus;
  checkedAt: string;
  issues: string[];
}

export interface ProcessVersion {
  id: string;
  version: string;
  basedOn?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  firstPublishedAt?: string;
  firstPublishedBy?: string;
  publishedAt?: string;
  lastUnpublishedAt?: string;
  lastUnpublishedBy?: string;
  lastUnpublishReason?: string;
  changeNote: string;
  instanceCount: number;
  formFieldCount: number;
  nodeCount: number;
  starterGroups: string[];
  checksum: string;
  basic: ProcessBasicConfig;
  snapshot: CompleteDesignerSnapshot;
  validation: VersionValidation;
}

export interface ProcessDefinition {
  id: string;
  code: string;
  name: string;
  description: string;
  type: DefinitionType;
  disabled: boolean;
  publishedVersionId?: string;
  nextVersionNumber: number;
  versions: ProcessVersion[];
  updatedAt: string;
  updatedBy: string;
  instanceCount: number;
  versionCount?: number;
  publishedVersionLabel?: string;
  publishedInstancePrefix?: string;
}

interface ProcessDefinitionState {
  definitions: ProcessDefinition[];
  resetDefinitions: () => void;
  synchronizeInstanceCounts: (instances: Pick<ProcessInstance, "definitionId" | "versionId">[]) => void;
}

export const useProcessDefinitionStore = create<ProcessDefinitionState>()((set) => ({
  definitions: [],
  resetDefinitions: () => set({ definitions: [] }),
  synchronizeInstanceCounts: (instances) => set((state) => ({
    definitions: state.definitions.map((definition) => {
      const versionCounts = new Map<string, number>();
      let instanceCount = 0;
      instances.forEach((instance) => {
        if (instance.definitionId !== definition.id) return;
        instanceCount += 1;
        versionCounts.set(instance.versionId, (versionCounts.get(instance.versionId) ?? 0) + 1);
      });
      return {
        ...definition,
        instanceCount,
        versions: definition.versions.map((version) => ({
          ...version,
          instanceCount: versionCounts.get(version.id) ?? 0,
        })),
      };
    }),
  })),
}));

export const getProcessDefinition = (definitionId?: string) =>
  useProcessDefinitionStore.getState().definitions.find((definition) => definition.id === definitionId);

export const getPublishedVersion = (definition?: ProcessDefinition) =>
  definition?.versions.find((version) => version.id === definition.publishedVersionId);

export const getVersionStatus = (definition: ProcessDefinition, versionId: string): VersionStatus => {
  if (definition.publishedVersionId === versionId) return "已发布";
  return definition.versions.find((version) => version.id === versionId)?.validation.status === "通过"
    ? "可发布"
    : "校验未通过";
};

export const canEditVersion = (definition: ProcessDefinition, version: ProcessVersion) =>
  definition.publishedVersionId !== version.id && version.instanceCount === 0;

export const definitionStatus = (definition: ProcessDefinition): DefinitionStatus =>
  definition.disabled ? "已停用" : definition.publishedVersionId ? "已发布" : "未发布";
