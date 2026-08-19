import type { ProcessInstance } from "../data/types";
import type { ProcessDefinition, ProcessVersion } from "./useProcessDefinitionStore";

const normalizedVersionLabel = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toUpperCase().startsWith("V") ? trimmed.toUpperCase() : `V${trimmed}`;
};

/**
 * 解析实例创建时锁定的完整版本。已有 versionId 时只允许精确命中，
 * 绝不回退到当前发布版本；版本文本匹配仅用于迁移旧原型数据。
 */
export const resolveLockedProcessVersion = (
  definition: ProcessDefinition | undefined,
  instance: Pick<ProcessInstance, "versionId" | "templateVersion">,
): ProcessVersion | undefined => {
  if (!definition) return undefined;
  if (instance.versionId) return definition.versions.find((version) => version.id === instance.versionId);
  const legacyLabel = normalizedVersionLabel(instance.templateVersion);
  return definition.versions.find((version) => normalizedVersionLabel(version.version) === legacyLabel);
};
