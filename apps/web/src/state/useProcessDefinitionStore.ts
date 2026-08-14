import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DefinitionType = "approval" | "free";
export type DefinitionStatus = "草稿" | "已发布" | "已停用";
export type VersionStatus = "草稿" | "已发布" | "已停用";

export interface ProcessBasicConfig {
  name: string;
  code: string;
  instancePrefix: string;
  type: DefinitionType;
  description: string;
  starterGroup: string;
  assigneeGroup?: string;
  visibleRoles: string[];
  visibleUsers: string[];
}

export interface ProcessDraft {
  id: string;
  version: string;
  basedOn?: string;
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
  status: VersionStatus;
  publishedAt: string;
  createdBy: string;
  changeNote: string;
  instanceCount: number;
  formFieldCount: number;
  nodeCount: number;
  starterGroup: string;
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
  currentVersion?: string;
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
  updateDraftBasic: (definitionId: string, basic: ProcessBasicConfig) => void;
  markFormConfigured: (definitionId: string, fieldCount: number) => void;
  markFlowConfigured: (definitionId: string, nodeCount: number) => void;
  publishDraft: (definitionId: string, changeNote: string) => string | null;
  toggleDefinition: (definitionId: string) => void;
  resetDefinitions: () => void;
}

const nowText = () => "刚刚";

const basic = (
  name: string,
  code: string,
  type: DefinitionType,
  description: string,
  starterGroup: string,
  extra: Partial<ProcessBasicConfig> = {},
): ProcessBasicConfig => ({
  name,
  code,
  instancePrefix: "",
  type,
  description,
  starterGroup,
  visibleRoles: [],
  visibleUsers: [],
  ...extra,
});

const version = (
  id: string,
  label: string,
  status: VersionStatus,
  publishedAt: string,
  createdBy: string,
  changeNote: string,
  instanceCount: number,
  formFieldCount: number,
  nodeCount: number,
  config: ProcessBasicConfig,
): ProcessVersion => ({
  id,
  version: label,
  status,
  publishedAt,
  createdBy,
  changeNote,
  instanceCount,
  formFieldCount,
  nodeCount,
  starterGroup: config.starterGroup,
  checksum: status === "草稿" ? "草稿未生成" : `${id.slice(-4).toUpperCase()}-${formFieldCount}F-${nodeCount}N`,
  basic: config,
});

const pdfBasic = basic(
  "PDF 文件审核",
  "PROC-PDF-001",
  "approval",
  "受控 PDF 文件由研发、质量、生产并行审核。",
  "PDF审核_文控_流程权限组",
  { instancePrefix: "DOC", visibleRoles: ["部门查看员"], visibleUsers: ["linxiao"] },
);
const testBasic = basic(
  "测试报告审核",
  "PROC-TR-002",
  "approval",
  "产品测试报告会签与发布流程。",
  "测试报告_发起_流程权限组",
  { instancePrefix: "DOC", visibleRoles: ["研发经理", "质量经理"] },
);
const freeBasic = basic(
  "异常协作事项",
  "PROC-FREE-003",
  "free",
  "按受理人连续流转，可回复、关闭并填写理由后重新打开。",
  "自由协作_发起_流程权限组",
  { instancePrefix: "ISSUE", assigneeGroup: "自由协作_受理_流程权限组", visibleRoles: ["部门查看员"] },
);
const supplierBasic = basic(
  "供应商变更评审",
  "PROC-SC-004",
  "approval",
  "供应商材料或制程变更的跨部门审批流程。",
  "供应商变更_发起_流程权限组",
  { instancePrefix: "SC" },
);

const initialDefinitions: ProcessDefinition[] = [
  {
    id: "pdf-review", code: pdfBasic.code, name: pdfBasic.name, description: pdfBasic.description, type: "approval", disabled: false,
    currentVersion: "v3", updatedAt: "2026-08-12 16:42", updatedBy: "王敏", instanceCount: 128,
    versions: [
      version("pdf-v3", "v3", "已发布", "2026-08-02 14:30", "王敏", "增加质量节点可修改字段并优化并行提醒。", 42, 9, 5, pdfBasic),
      version("pdf-v2", "v2", "已停用", "2026-05-16 10:05", "刘燕", "研发、质量和生产改为同起点并行审核。", 71, 8, 5, pdfBasic),
      version("pdf-v1", "v1", "已停用", "2026-02-12 09:20", "系统管理员", "首次发布。", 15, 7, 5, pdfBasic),
    ],
  },
  {
    id: "test-report-review", code: testBasic.code, name: testBasic.name, description: testBasic.description, type: "approval", disabled: false,
    updatedAt: "2026-08-13 09:18", updatedBy: "林晓", instanceCount: 0, versions: [],
    draft: { id: "test-report-v1-draft", version: "v1", basic: testBasic, formConfigured: true, formFieldCount: 5, flowConfigured: false, nodeCount: 4, updatedAt: "2026-08-13 09:18" },
  },
  {
    id: "free-collaboration", code: freeBasic.code, name: freeBasic.name, description: freeBasic.description, type: "free", disabled: false,
    currentVersion: "v2", updatedAt: "2026-08-10 14:06", updatedBy: "系统管理员", instanceCount: 67,
    versions: [
      version("free-v2", "v2", "已发布", "2026-07-30 16:18", "王敏", "增加异常改派；重新打开时恢复初始表单编辑。", 39, 5, 0, freeBasic),
      version("free-v1", "v1", "已停用", "2026-04-08 11:42", "系统管理员", "首次发布自由协作流程。", 28, 4, 0, freeBasic),
    ],
  },
  {
    id: "supplier-change-review", code: supplierBasic.code, name: supplierBasic.name, description: supplierBasic.description, type: "approval", disabled: true,
    currentVersion: "v1", updatedAt: "2026-07-28 11:25", updatedBy: "赵磊", instanceCount: 21,
    versions: [version("supplier-v1", "v1", "已发布", "2026-07-20 11:25", "赵磊", "首次发布供应商变更评审。", 21, 6, 4, supplierBasic)],
  },
];

const nextSequence = (definitions: ProcessDefinition[]) => Math.max(
  0,
  ...definitions.map((definition) => Number(definition.code.match(/(\d+)$/)?.[1] ?? 0)),
) + 1;

const nextVersion = (definition: ProcessDefinition) => {
  const numbers = definition.versions.map((item) => Number(item.version.replace(/\D/g, ""))).filter(Number.isFinite);
  return `v${Math.max(0, ...numbers) + 1}`;
};

const sourceBasic = (definition: ProcessDefinition, sourceVersion?: string) => {
  if (sourceVersion) return definition.versions.find((item) => item.version === sourceVersion)?.basic;
  if (definition.currentVersion) return definition.versions.find((item) => item.version === definition.currentVersion)?.basic;
  return definition.draft?.basic;
};

export const definitionStatus = (definition: ProcessDefinition): DefinitionStatus => {
  if (definition.disabled) return "已停用";
  return definition.currentVersion ? "已发布" : "草稿";
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
        const config = basic(name.trim(), code, type, description?.trim() || "尚未填写流程说明。", "");
        const created: ProcessDefinition = {
          id, code, name: config.name, description: config.description, type, disabled: false,
          updatedAt: nowText(), updatedBy: "当前用户", instanceCount: 0, versions: [],
          draft: { id: `${id}-v1-draft`, version: "v1", basic: config, formConfigured: false, formFieldCount: 0, flowConfigured: type === "free", nodeCount: 0, updatedAt: nowText() },
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
        const config = { ...sourceConfig, name: `${source.name}（副本）`, code, visibleRoles: [...sourceConfig.visibleRoles], visibleUsers: [...sourceConfig.visibleUsers] };
        const copied: ProcessDefinition = {
          id, code, name: config.name, description: config.description, type: source.type, disabled: false,
          updatedAt: nowText(), updatedBy: "当前用户", instanceCount: 0, versions: [],
          draft: { id: `${id}-v1-draft`, version: "v1", basic: config, formConfigured: true, formFieldCount: source.draft?.formFieldCount ?? source.versions[0]?.formFieldCount ?? 0, flowConfigured: source.type === "free" || Boolean(source.draft?.flowConfigured ?? source.versions[0]?.nodeCount), nodeCount: source.draft?.nodeCount ?? source.versions[0]?.nodeCount ?? 0, updatedAt: nowText() },
        };
        set({ definitions: [copied, ...definitions] });
        return id;
      },
      ensureDraft: (definitionId, sourceVersion) => {
        let created = false;
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || definition.draft) return definition;
            const config = sourceBasic(definition, sourceVersion);
            if (!config) return definition;
            const source = sourceVersion ? definition.versions.find((item) => item.version === sourceVersion) : definition.versions.find((item) => item.version === definition.currentVersion);
            created = true;
            return {
              ...definition,
              draft: {
                id: `${definition.id}-${nextVersion(definition)}-draft`,
                version: nextVersion(definition),
                basedOn: source?.version,
                basic: { ...config, visibleRoles: [...config.visibleRoles], visibleUsers: [...config.visibleUsers] },
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
      updateDraftBasic: (definitionId, config) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.draft ? {
          ...definition,
          name: config.name,
          description: config.description,
          type: config.type,
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
        set((state) => ({
          definitions: state.definitions.map((definition) => {
            if (definition.id !== definitionId || !definition.draft) return definition;
            const draft = definition.draft;
            publishedVersion = draft.version;
            const previous = definition.versions.map((item) => item.status === "已发布" ? { ...item, status: "已停用" as const } : item);
            const released = version(
              `${definition.id}-${draft.version}`,
              draft.version,
              "已发布",
              new Date().toLocaleString("zh-CN", { hour12: false }),
              "当前用户",
              changeNote,
              0,
              draft.formFieldCount,
              definition.type === "free" ? 0 : draft.nodeCount,
              draft.basic,
            );
            return {
              ...definition,
              name: draft.basic.name,
              description: draft.basic.description,
              type: draft.basic.type,
              disabled: false,
              currentVersion: draft.version,
              draft: undefined,
              versions: [released, ...previous],
              updatedAt: nowText(),
              updatedBy: "当前用户",
            };
          }),
        }));
        return publishedVersion;
      },
      toggleDefinition: (definitionId) => set((state) => ({
        definitions: state.definitions.map((definition) => definition.id === definitionId && definition.currentVersion ? {
          ...definition, disabled: !definition.disabled, updatedAt: nowText(), updatedBy: "当前用户",
        } : definition),
      })),
      resetDefinitions: () => {
        if (typeof window !== "undefined") {
          const prefixes = [
            "flowpilot-form-designer-draft-v2-",
            "flowpilot-flow-designer-v2-",
            "flowpilot-system-list-fields-v1:",
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
      version: 2,
      migrate: (persisted) => {
        const state = persisted as ProcessDefinitionState;
        const definitions = state.definitions ?? initialDefinitions;
        return {
          ...state,
          definitions: definitions.map((definition) => {
            const fallback = initialDefinitions.find((item) => item.id === definition.id);
            const fallbackPrefix = fallback?.draft?.basic.instancePrefix
              ?? fallback?.versions[0]?.basic.instancePrefix
              ?? "";
            return {
              ...definition,
              draft: definition.draft ? {
                ...definition.draft,
                basic: {
                  ...definition.draft.basic,
                  instancePrefix: definition.draft.basic.instancePrefix ?? fallbackPrefix,
                },
              } : undefined,
              versions: definition.versions.map((item) => ({
                ...item,
                basic: {
                  ...item.basic,
                  instancePrefix: item.basic.instancePrefix ?? fallbackPrefix,
                },
              })),
            };
          }),
        };
      },
    },
  ),
);
