import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  clearDefinitionDesignerArtifacts,
  DESIGNER_VERSION_SNAPSHOT_KEY_PREFIX,
  removeDesignerVersionSnapshot,
  restoreDesignerVersionSnapshot,
  saveDesignerVersionSnapshot,
} from "../utils/designerStorage";

export type DefinitionType = "approval" | "free";
export type DefinitionStatus = "草稿" | "已发布" | "已停用";
export type VersionStatus = "草稿" | "生效" | "失效";
export type DeleteVersionResult = "deleted" | "definition-deleted" | "needs-replacement" | "has-instances" | "not-found";
export type WithdrawVersionResult = "withdrawn" | "not-found" | "not-effective" | "has-instances" | "has-draft";

export interface ProcessBasicConfig {
  name: string;
  code: string;
  instancePrefix: string;
  type: DefinitionType;
  description: string;
  starterGroups: string[];
  assigneeGroups?: string[];
  visibleRoles: string[];
  visibleUsers: string[];
}

export interface ProcessDraft {
  id: string;
  version: string;
  basedOn?: string;
  withdrawnVersionId?: string;
  withdrawnWasDisabled?: boolean;
  withdrawnAt?: string;
  withdrawnBy?: string;
  basic: ProcessBasicConfig;
  formConfigured: boolean;
  formFieldCount: number;
  flowConfigured: boolean;
  nodeCount: number;
  updatedAt: string;
}

export interface ProcessVersion {
  id: string;
  version: string;
  firstPublishedAt: string;
  firstPublishedBy: string;
  publishedAt: string;
  lastWithdrawnAt?: string;
  lastWithdrawnBy?: string;
  createdBy: string;
  changeNote: string;
  instanceCount: number;
  formFieldCount: number;
  nodeCount: number;
  starterGroups: string[];
  checksum: string;
  basic: ProcessBasicConfig;
}

export interface ProcessDefinition {
  id: string;
  code: string;
  name: string;
  description: string;
  type: DefinitionType;
  disabled: boolean;
  effectiveVersionId?: string;
  nextVersionNumber: number;
  draft?: ProcessDraft;
  versions: ProcessVersion[];
  updatedAt: string;
  updatedBy: string;
  instanceCount: number;
}

interface CreateDefinitionInput {
  name: string;
  type: DefinitionType;
  description?: string;
}

interface ProcessDefinitionState {
  definitions: ProcessDefinition[];
  createDefinition: (input: CreateDefinitionInput) => string;
  copyDefinition: (definitionId: string) => string | null;
  ensureDraft: (definitionId: string, sourceVersion?: string) => boolean;
  resetDraftFromVersion: (definitionId: string, sourceVersion: string) => boolean;
  discardDraft: (definitionId: string) => boolean;
  updateDraftBasic: (definitionId: string, basic: ProcessBasicConfig) => void;
  markFormConfigured: (definitionId: string, fieldCount: number) => void;
  markFlowConfigured: (definitionId: string, nodeCount: number) => void;
  publishDraft: (definitionId: string, changeNote: string) => string | null;
  withdrawEffectiveVersion: (definitionId: string, versionId: string) => WithdrawVersionResult;
  activateVersion: (definitionId: string, versionId: string) => boolean;
  deleteVersion: (definitionId: string, versionId: string, replacementVersionId?: string) => DeleteVersionResult;
  deleteDefinition: (definitionId: string) => boolean;
  toggleDefinition: (definitionId: string) => void;
  resetDefinitions: () => void;
}

const nowText = () => "刚刚";

const basic = (
  name: string,
  code: string,
  type: DefinitionType,
  description: string,
  starterGroups: string[],
  extra: Partial<ProcessBasicConfig> = {},
): ProcessBasicConfig => ({
  name,
  code,
  instancePrefix: "",
  type,
  description,
  starterGroups,
  visibleRoles: [],
  visibleUsers: [],
  ...extra,
});

const version = (
  id: string,
  label: string,
  publishedAt: string,
  createdBy: string,
  changeNote: string,
  instanceCount: number,
  formFieldCount: number,
  nodeCount: number,
  config: ProcessBasicConfig,
  firstPublishedAt: string = publishedAt,
  firstPublishedBy: string = createdBy,
): ProcessVersion => ({
  id,
  version: label,
  firstPublishedAt,
  firstPublishedBy,
  publishedAt,
  createdBy,
  changeNote,
  instanceCount,
  formFieldCount,
  nodeCount,
  starterGroups: [...config.starterGroups],
  checksum: `${id.slice(-4).toUpperCase()}-${formFieldCount}F-${nodeCount}N`,
  basic: config,
});

const pdfBasic = basic(
  "PDF 文件审核",
  "PROC-PDF-001",
  "approval",
  "受控 PDF 文件由研发、质量、生产并行审核。",
  ["PDF审核_文控_流程权限组"],
  { instancePrefix: "DOC", visibleRoles: ["部门查看员"], visibleUsers: ["linxiao"] },
);
const testBasic = basic(
  "测试报告审核",
  "PROC-TR-002",
  "approval",
  "产品测试报告会签与发布流程。",
  ["测试报告_发起_流程权限组"],
  { instancePrefix: "DOC", visibleRoles: ["研发经理", "质量经理"] },
);
const freeBasic = basic(
  "异常协作事项",
  "PROC-FREE-003",
  "free",
  "按受理人连续流转，可回复、关闭并填写理由后重新打开。",
  ["自由协作_发起_流程权限组"],
  { instancePrefix: "ISSUE", assigneeGroups: ["自由协作_受理_流程权限组"], visibleRoles: ["部门查看员"] },
);
const supplierBasic = basic(
  "供应商变更评审",
  "PROC-SC-004",
  "approval",
  "供应商材料或制程变更的跨部门审批流程。",
  ["供应商变更_发起_流程权限组"],
  { instancePrefix: "SC" },
);

const initialDefinitions: ProcessDefinition[] = [
  {
    id: "pdf-review", code: pdfBasic.code, name: pdfBasic.name, description: pdfBasic.description, type: "approval", disabled: false,
    effectiveVersionId: "pdf-v3", nextVersionNumber: 4, updatedAt: "2026-08-12 16:42", updatedBy: "王敏", instanceCount: 128,
    versions: [
      version("pdf-v3", "V3", "2026-08-02 14:30", "王敏", "增加质量节点可修改字段并优化并行提醒。", 42, 9, 5, pdfBasic),
      version("pdf-v2", "V2", "2026-05-16 10:05", "刘燕", "研发、质量和生产改为同起点并行审核。", 71, 8, 5, pdfBasic),
      version("pdf-v1", "V1", "2026-02-12 09:20", "系统管理员", "首次发布。", 15, 7, 5, pdfBasic),
    ],
  },
  {
    id: "test-report-review", code: testBasic.code, name: testBasic.name, description: testBasic.description, type: "approval", disabled: false,
    nextVersionNumber: 2, updatedAt: "2026-08-13 09:18", updatedBy: "林晓", instanceCount: 0, versions: [],
    draft: { id: "test-report-v1-draft", version: "V1", basic: testBasic, formConfigured: true, formFieldCount: 5, flowConfigured: false, nodeCount: 4, updatedAt: "2026-08-13 09:18" },
  },
  {
    id: "free-collaboration", code: freeBasic.code, name: freeBasic.name, description: freeBasic.description, type: "free", disabled: false,
    effectiveVersionId: "free-v2", nextVersionNumber: 3, updatedAt: "2026-08-10 14:06", updatedBy: "系统管理员", instanceCount: 67,
    versions: [
      version("free-v2", "V2", "2026-07-30 16:18", "王敏", "增加异常改派；重新打开时恢复初始表单编辑。", 39, 5, 0, freeBasic),
      version("free-v1", "V1", "2026-04-08 11:42", "系统管理员", "首次发布自由协作流程。", 28, 4, 0, freeBasic),
    ],
  },
  {
    id: "supplier-change-review", code: supplierBasic.code, name: "供应商变更会签", description: supplierBasic.description, type: "approval", disabled: true,
    effectiveVersionId: "supplier-v2", nextVersionNumber: 3, updatedAt: "2026-07-28 11:25", updatedBy: "赵磊", instanceCount: 21,
    versions: [
      version("supplier-v2", "V2", "2026-07-28 11:25", "赵磊", "调整评审说明和发起范围，当前没有实例。", 0, 7, 4, { ...supplierBasic, name: "供应商变更会签" }),
      version("supplier-v1", "V1", "2026-07-20 11:25", "赵磊", "首次发布供应商变更评审。", 21, 6, 4, supplierBasic),
    ],
  },
];

const nextSequence = (definitions: ProcessDefinition[]) => Math.max(
  0,
  ...definitions.map((definition) => Number(definition.code.match(/(\d+)$/)?.[1] ?? 0)),
) + 1;

const versionLabel = (number: number) => `V${number}`;

export const getEffectiveVersion = (definition?: ProcessDefinition) =>
  definition?.versions.find((item) => item.id === definition.effectiveVersionId);

export const getVersionStatus = (definition: ProcessDefinition, versionId: string): Exclude<VersionStatus, "草稿"> =>
  definition.effectiveVersionId === versionId ? "生效" : "失效";

const sourceBasic = (definition: ProcessDefinition, sourceVersion?: string) => {
  if (sourceVersion) return definition.versions.find((item) => item.version === sourceVersion)?.basic;
  const effective = getEffectiveVersion(definition);
  if (effective) return effective.basic;
  return definition.draft?.basic;
};

export const definitionStatus = (definition: ProcessDefinition): DefinitionStatus => {
  if (definition.disabled) return "已停用";
  return definition.effectiveVersionId ? "已发布" : "草稿";
};

const discardDraftSnapshot = (definition: ProcessDefinition): ProcessDefinition => {
  const withdrawn = definition.draft?.withdrawnVersionId
    ? definition.versions.find((item) => item.id === definition.draft?.withdrawnVersionId)
    : undefined;
  return {
    ...definition,
    effectiveVersionId: withdrawn?.id ?? definition.effectiveVersionId,
    disabled: withdrawn ? Boolean(definition.draft?.withdrawnWasDisabled) : definition.disabled,
    name: withdrawn?.basic.name ?? definition.name,
    description: withdrawn?.basic.description ?? definition.description,
    draft: undefined,
    updatedAt: nowText(),
    updatedBy: "当前用户",
  };
};

export const useProcessDefinitionStore = create<ProcessDefinitionState>()(
  persist(
    (set, get) => ({
      definitions: initialDefinitions,
      createDefinition: ({ name, type, description }) => {
        const definitions = get().definitions;
        const sequence = nextSequence(definitions);
        const id = `process-${Date.now()}`;
        const code = `PROC-${type === "approval" ? "AP" : "FREE"}-${String(sequence).padStart(3, "0")}`;
        const config = basic(name.trim(), code, type, description?.trim() || "尚未填写流程说明。", []);
        const created: ProcessDefinition = {
          id, code, name: config.name, description: config.description, type, disabled: false,
          nextVersionNumber: 2, updatedAt: nowText(), updatedBy: "当前用户", instanceCount: 0, versions: [],
          draft: { id: `${id}-v1-draft`, version: "V1", basic: config, formConfigured: false, formFieldCount: 0, flowConfigured: type === "free", nodeCount: 0, updatedAt: nowText() },
        };
        set({ definitions: [created, ...definitions] });
        return id;
      },
      copyDefinition: (definitionId) => {
        const definitions = get().definitions;
        const source = definitions.find((item) => item.id === definitionId);
        if (!source) return null;
        const sequence = nextSequence(definitions);
        const id = `process-${Date.now()}`;
        const code = `PROC-${source.type === "approval" ? "AP" : "FREE"}-${String(sequence).padStart(3, "0")}`;
        const sourceConfig = sourceBasic(source) ?? source.draft?.basic;
        if (!sourceConfig) return null;
        const config = { ...sourceConfig, name: `${source.name}（副本）`, code, starterGroups: [...sourceConfig.starterGroups], assigneeGroups: sourceConfig.assigneeGroups ? [...sourceConfig.assigneeGroups] : undefined, visibleRoles: [...sourceConfig.visibleRoles], visibleUsers: [...sourceConfig.visibleUsers] };
        const copied: ProcessDefinition = {
          id, code, name: config.name, description: config.description, type: source.type, disabled: false,
          nextVersionNumber: 2, updatedAt: nowText(), updatedBy: "当前用户", instanceCount: 0, versions: [],
          draft: { id: `${id}-v1-draft`, version: "V1", basic: config, formConfigured: true, formFieldCount: source.draft?.formFieldCount ?? getEffectiveVersion(source)?.formFieldCount ?? source.versions[0]?.formFieldCount ?? 0, flowConfigured: source.type === "free" || Boolean(source.draft?.flowConfigured ?? getEffectiveVersion(source)?.nodeCount ?? source.versions[0]?.nodeCount), nodeCount: source.draft?.nodeCount ?? getEffectiveVersion(source)?.nodeCount ?? source.versions[0]?.nodeCount ?? 0, updatedAt: nowText() },
        };
        set({ definitions: [copied, ...definitions] });
        return id;
      },
      ensureDraft: (definitionId, sourceVersion) => {
        const currentDefinition = get().definitions.find((item) => item.id === definitionId);
        const currentEffective = getEffectiveVersion(currentDefinition);
        const selectedSource = sourceVersion
          ? currentDefinition?.versions.find((item) => item.version === sourceVersion)
          : currentEffective;
        if (currentEffective) saveDesignerVersionSnapshot(definitionId, currentEffective.id);
        if (selectedSource && selectedSource.id !== currentEffective?.id) {
          restoreDesignerVersionSnapshot(definitionId, selectedSource.id);
        }
        let created = false;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || definition.draft) return definition;
            const config = sourceBasic(definition, sourceVersion);
            if (!config) return definition;
            const source = sourceVersion ? definition.versions.find((item) => item.version === sourceVersion) : getEffectiveVersion(definition);
            const label = versionLabel(definition.nextVersionNumber);
            created = true;
            return {
              ...definition,
              nextVersionNumber: definition.nextVersionNumber + 1,
              draft: {
                id: `${definition.id}-${label.toLowerCase()}-draft`,
                version: label,
                basedOn: source?.version,
                basic: { ...config, starterGroups: [...config.starterGroups], assigneeGroups: config.assigneeGroups ? [...config.assigneeGroups] : undefined, visibleRoles: [...config.visibleRoles], visibleUsers: [...config.visibleUsers] },
                formConfigured: true,
                formFieldCount: source?.formFieldCount ?? 0,
                flowConfigured: definition.type === "free" || Boolean(source?.nodeCount),
                nodeCount: source?.nodeCount ?? 0,
                updatedAt: nowText(),
              },
              updatedAt: nowText(),
              updatedBy: "当前用户",
            };
          }),
        }));
        return created;
      },
      resetDraftFromVersion: (definitionId, sourceVersion) => {
        const currentDefinition = get().definitions.find((item) => item.id === definitionId);
        const selectedSource = currentDefinition?.versions.find((item) => item.version === sourceVersion);
        if (selectedSource) restoreDesignerVersionSnapshot(definitionId, selectedSource.id);
        let reset = false;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || !definition.draft) return definition;
            const source = definition.versions.find((item) => item.version === sourceVersion);
            if (!source) return definition;
            reset = true;
            return {
              ...definition,
              updatedAt: nowText(),
              updatedBy: "当前用户",
              draft: {
                ...definition.draft,
                basedOn: source.version,
                basic: { ...source.basic, starterGroups: [...source.basic.starterGroups], assigneeGroups: source.basic.assigneeGroups ? [...source.basic.assigneeGroups] : undefined, visibleRoles: [...source.basic.visibleRoles], visibleUsers: [...source.basic.visibleUsers] },
                formConfigured: true,
                formFieldCount: source.formFieldCount,
                flowConfigured: definition.type === "free" || source.nodeCount >= 2,
                nodeCount: source.nodeCount,
                updatedAt: nowText(),
              },
            };
          }),
        }));
        return reset;
      },
      discardDraft: (definitionId) => {
        const currentDefinition = get().definitions.find((item) => item.id === definitionId);
        const restoreVersionId = currentDefinition?.draft?.withdrawnVersionId ?? currentDefinition?.effectiveVersionId;
        let discarded = false;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || !definition.draft || definition.versions.length === 0) return definition;
            discarded = true;
            return discardDraftSnapshot(definition);
          }),
        }));
        if (discarded && restoreVersionId) restoreDesignerVersionSnapshot(definitionId, restoreVersionId);
        return discarded;
      },
      updateDraftBasic: (definitionId, config) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.draft ? {
          ...definition,
          name: definition.effectiveVersionId ? definition.name : config.name,
          description: definition.effectiveVersionId ? definition.description : config.description,
          updatedAt: nowText(),
          updatedBy: "当前用户",
          draft: { ...definition.draft, basic: config, updatedAt: nowText() },
        } : definition),
      })),
      markFormConfigured: (definitionId, fieldCount) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.draft ? {
          ...definition,
          updatedAt: nowText(),
          draft: { ...definition.draft, formConfigured: fieldCount > 0, formFieldCount: fieldCount, updatedAt: nowText() },
        } : definition),
      })),
      markFlowConfigured: (definitionId, nodeCount) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.draft ? {
          ...definition,
          updatedAt: nowText(),
          draft: { ...definition.draft, flowConfigured: nodeCount >= 2, nodeCount, updatedAt: nowText() },
        } : definition),
      })),
      publishDraft: (definitionId, changeNote) => {
        let publishedVersion: string | null = null;
        let publishedVersionId: string | null = null;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || !definition.draft) return definition;
            const draft = definition.draft;
            const withdrawnSource = draft.withdrawnVersionId
              ? definition.versions.find((item) => item.id === draft.withdrawnVersionId)
              : undefined;
            publishedVersion = draft.version;
            const released = version(
              withdrawnSource?.id ?? `${definition.id}-${draft.version.toLowerCase()}`,
              draft.version,
              new Date().toLocaleString("zh-CN", { hour12: false }),
              "当前用户",
              changeNote,
              withdrawnSource?.instanceCount ?? 0,
              draft.formFieldCount,
              definition.type === "free" ? 0 : draft.nodeCount,
              draft.basic,
              withdrawnSource?.firstPublishedAt ?? withdrawnSource?.publishedAt,
              withdrawnSource?.firstPublishedBy ?? withdrawnSource?.createdBy,
            );
            const releasedWithLifecycle: ProcessVersion = {
              ...released,
              lastWithdrawnAt: draft.withdrawnAt,
              lastWithdrawnBy: draft.withdrawnBy,
            };
            publishedVersionId = releasedWithLifecycle.id;
            return {
              ...definition,
              name: draft.basic.name,
              description: draft.basic.description,
              type: draft.basic.type,
              disabled: draft.withdrawnVersionId ? Boolean(draft.withdrawnWasDisabled) : definition.disabled,
              effectiveVersionId: releasedWithLifecycle.id,
              draft: undefined,
              versions: [releasedWithLifecycle, ...definition.versions.filter((item) => item.id !== releasedWithLifecycle.id)],
              updatedAt: nowText(),
              updatedBy: "当前用户",
            };
          }),
        }));
        if (publishedVersionId) saveDesignerVersionSnapshot(definitionId, publishedVersionId);
        return publishedVersion;
      },
      withdrawEffectiveVersion: (definitionId, versionId) => {
        const currentDefinition = get().definitions.find((item) => item.id === definitionId);
        if (currentDefinition?.effectiveVersionId === versionId && !currentDefinition.draft) {
          saveDesignerVersionSnapshot(definitionId, versionId);
        }
        let result: WithdrawVersionResult = "not-found";
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId) return definition;
            if (definition.draft) {
              result = "has-draft";
              return definition;
            }
            if (definition.effectiveVersionId !== versionId) {
              result = "not-effective";
              return definition;
            }
            const target = definition.versions.find((item) => item.id === versionId);
            if (!target) return definition;
            if (target.instanceCount > 0) {
              result = "has-instances";
              return definition;
            }
            result = "withdrawn";
            const withdrawnAt = new Date().toLocaleString("zh-CN", { hour12: false });
            return {
              ...definition,
              effectiveVersionId: undefined,
              disabled: false,
              draft: {
                id: `${target.id}-draft`,
                version: target.version,
                basedOn: target.version,
                withdrawnVersionId: target.id,
                withdrawnWasDisabled: definition.disabled,
                withdrawnAt,
                withdrawnBy: "当前用户",
                basic: {
                  ...target.basic,
                  starterGroups: [...target.basic.starterGroups],
                  assigneeGroups: target.basic.assigneeGroups ? [...target.basic.assigneeGroups] : undefined,
                  visibleRoles: [...target.basic.visibleRoles],
                  visibleUsers: [...target.basic.visibleUsers],
                },
                formConfigured: true,
                formFieldCount: target.formFieldCount,
                flowConfigured: definition.type === "free" || target.nodeCount >= 2,
                nodeCount: target.nodeCount,
                updatedAt: nowText(),
              },
              updatedAt: nowText(),
              updatedBy: "当前用户",
            };
          }),
        }));
        return result;
      },
      activateVersion: (definitionId, versionId) => {
        const currentDefinition = get().definitions.find((item) => item.id === definitionId);
        const currentEffective = getEffectiveVersion(currentDefinition);
        if (currentEffective) saveDesignerVersionSnapshot(definitionId, currentEffective.id);
        let activated = false;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || definition.draft?.withdrawnVersionId) return definition;
            const target = definition.versions.find((item) => item.id === versionId);
            if (!target || definition.effectiveVersionId === versionId) return definition;
            activated = true;
            return {
              ...definition,
              effectiveVersionId: target.id,
              name: target.basic.name,
              description: target.basic.description,
              updatedAt: nowText(),
              updatedBy: "当前用户",
            };
          }),
        }));
        if (activated) restoreDesignerVersionSnapshot(definitionId, versionId);
        return activated;
      },
      deleteVersion: (definitionId, versionId, replacementVersionId) => {
        const definition = get().definitions.find((item) => item.id === definitionId);
        if (!definition) return "not-found";
        if (definition.draft?.id === versionId) {
          if (definition.versions.length === 0) {
            set({ definitions: get().definitions.filter((item) => item.id !== definitionId) });
            clearDefinitionDesignerArtifacts(definitionId);
            return "definition-deleted";
          }
          const restoreVersionId = definition.draft.withdrawnVersionId ?? definition.effectiveVersionId;
          set({ definitions: get().definitions.map((item) => item.id === definitionId ? discardDraftSnapshot(item) : item) });
          if (restoreVersionId) restoreDesignerVersionSnapshot(definitionId, restoreVersionId);
          return "deleted";
        }
        const target = definition.versions.find((item) => item.id === versionId);
        if (!target) return "not-found";
        if (target.instanceCount > 0) return "has-instances";
        const remaining = definition.versions.filter((item) => item.id !== versionId);
        let replacement = remaining.find((item) => item.id === replacementVersionId);
        if (definition.effectiveVersionId === versionId && remaining.length > 0 && !replacement) return "needs-replacement";
        if (definition.effectiveVersionId !== versionId) replacement = getEffectiveVersion(definition);

        if (remaining.length === 0 && !definition.draft) {
          set({ definitions: get().definitions.filter((item) => item.id !== definitionId) });
          clearDefinitionDesignerArtifacts(definitionId);
          return "definition-deleted";
        }

        const nextEffective = definition.effectiveVersionId === versionId ? replacement : getEffectiveVersion(definition);
        const draftOnly = remaining.length === 0 && Boolean(definition.draft);
        set({
          definitions: get().definitions.map((item) => item.id === definitionId ? {
            ...item,
            versions: remaining,
            effectiveVersionId: nextEffective?.id,
            disabled: draftOnly ? false : item.disabled,
            name: draftOnly ? item.draft!.basic.name : nextEffective?.basic.name ?? item.name,
            description: draftOnly ? item.draft!.basic.description : nextEffective?.basic.description ?? item.description,
            updatedAt: nowText(),
            updatedBy: "当前用户",
          } : item),
        });
        removeDesignerVersionSnapshot(definitionId, versionId);
        if (nextEffective && !definition.draft) restoreDesignerVersionSnapshot(definitionId, nextEffective.id);
        return "deleted";
      },
      deleteDefinition: (definitionId) => {
        const definitions = get().definitions;
        const definition = definitions.find((item) => item.id === definitionId);
        if (!definition || definition.instanceCount > 0 || definition.versions.some((item) => item.instanceCount > 0)) return false;
        set({ definitions: definitions.filter((item) => item.id !== definitionId) });
        clearDefinitionDesignerArtifacts(definitionId);
        return true;
      },
      toggleDefinition: (definitionId) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.effectiveVersionId ? {
          ...definition, disabled: !definition.disabled, updatedAt: nowText(), updatedBy: "当前用户",
        } : definition),
      })),
      resetDefinitions: () => {
        if (typeof window !== "undefined") {
          const prefixes = [
            "flowpilot-form-designer-draft-v2-",
            "flowpilot-flow-designer-v2-",
            "flowpilot-system-list-fields-v1:",
            `${DESIGNER_VERSION_SNAPSHOT_KEY_PREFIX}:`,
          ];
          Object.keys(window.localStorage)
            .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
            .forEach((key) => window.localStorage.removeItem(key));
        }
        set({ definitions: initialDefinitions });
      },
    }),
    {
      name: "flowpilot-process-definitions-v1",
      version: 6,
      migrate: (persisted) => {
        const state = persisted as Partial<ProcessDefinitionState>;
        const definitions = state.definitions ?? initialDefinitions;
        return {
          ...state,
          definitions: definitions.map((definition) => {
            const legacy = definition as ProcessDefinition & { currentVersion?: string };
            const fallback = initialDefinitions.find((item) => item.id === definition.id);
            const fallbackPrefix = fallback?.draft?.basic.instancePrefix
              ?? fallback?.versions[0]?.basic.instancePrefix
              ?? "";
            const legacyStarterGroups = (config: ProcessBasicConfig & { starterGroup?: string }) =>
              Array.isArray(config.starterGroups)
                ? [...config.starterGroups]
                : config.starterGroup
                  ? [config.starterGroup]
                  : [];
            const legacyAssigneeGroups = (config: ProcessBasicConfig & { assigneeGroup?: string }) =>
              Array.isArray(config.assigneeGroups)
                ? [...config.assigneeGroups]
                : config.assigneeGroup
                  ? [config.assigneeGroup]
                  : undefined;
            const normalizedVersions = definition.versions.map((item) => ({
              ...item,
              version: item.version.toUpperCase(),
              firstPublishedAt: item.firstPublishedAt ?? item.publishedAt,
              firstPublishedBy: item.firstPublishedBy ?? item.createdBy,
              starterGroups: legacyStarterGroups(item.basic as ProcessBasicConfig & { starterGroup?: string }),
              basic: {
                ...item.basic,
                instancePrefix: item.basic.instancePrefix ?? fallbackPrefix,
                starterGroups: legacyStarterGroups(item.basic as ProcessBasicConfig & { starterGroup?: string }),
                assigneeGroups: legacyAssigneeGroups(item.basic as ProcessBasicConfig & { assigneeGroup?: string }),
                visibleRoles: [...(item.basic.visibleRoles ?? [])],
                visibleUsers: [...(item.basic.visibleUsers ?? [])],
              },
            }));
            const normalizedDraft = definition.draft ? {
              ...definition.draft,
              version: definition.draft.version.toUpperCase(),
              basedOn: definition.draft.basedOn?.toUpperCase(),
              basic: {
                ...definition.draft.basic,
                instancePrefix: definition.draft.basic.instancePrefix ?? fallbackPrefix,
                starterGroups: legacyStarterGroups(definition.draft.basic as ProcessBasicConfig & { starterGroup?: string }),
                assigneeGroups: legacyAssigneeGroups(definition.draft.basic as ProcessBasicConfig & { assigneeGroup?: string }),
                visibleRoles: [...(definition.draft.basic.visibleRoles ?? [])],
                visibleUsers: [...(definition.draft.basic.visibleUsers ?? [])],
              },
            } : undefined;
            const legacyCurrent = legacy.currentVersion?.toUpperCase();
            const requestedEffectiveVersionId = definition.effectiveVersionId
              ?? normalizedVersions.find((item) => item.version === legacyCurrent)?.id;
            const effectiveVersionId = normalizedVersions.some((item) => item.id === requestedEffectiveVersionId)
              ? requestedEffectiveVersionId
              : normalizedVersions[0]?.id;
            const effective = normalizedVersions.find((item) => item.id === effectiveVersionId);
            const allocatedNumbers = [
              ...normalizedVersions.map((item) => Number(item.version.replace(/\D/g, ""))),
              Number(normalizedDraft?.version.replace(/\D/g, "") ?? 0),
            ].filter(Number.isFinite);
            return {
              ...definition,
              name: effective?.basic.name ?? normalizedDraft?.basic.name ?? definition.name,
              description: effective?.basic.description ?? normalizedDraft?.basic.description ?? definition.description,
              disabled: effectiveVersionId ? definition.disabled : false,
              effectiveVersionId,
              nextVersionNumber: definition.nextVersionNumber ?? Math.max(0, ...allocatedNumbers) + 1,
              draft: normalizedDraft,
              versions: normalizedVersions,
            };
          }),
        };
      },
    },
  ),
);
