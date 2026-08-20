import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cloneDefaultSystemListFields } from "../data/listFieldConfig";
import {
  PROCESS_TITLE_FIELD_ID,
  clearDefinitionDesignerArtifacts,
  cloneCompleteDesignerSnapshot,
  createProcessTitleField,
  ensureProcessTitleField,
  type CompleteDesignerSnapshot,
} from "../utils/designerStorage";
import { currentUserCan } from "./permissionEngine";
import type { ImportedProcessDefinition } from "../utils/processDefinitionTransfer";
import { effectiveGroupMemberIds, useIdentityStore } from "./useIdentityStore";
import { validateProcessSnapshot } from "../utils/processDefinitionValidation";
import { nowDomainTimestamp } from "../utils/domainTime";

export type DefinitionType = "approval" | "free";
export type DefinitionStatus = "未发布" | "已发布" | "已停用";
export type VersionStatus = "校验未通过" | "可发布" | "已发布";
export type VersionValidationStatus = "通过" | "未通过";
export type DeleteVersionResult = "deleted" | "definition-deleted" | "published" | "has-instances" | "not-found";
export type UnpublishVersionResult = "unpublished" | "not-found" | "not-published";

export interface ProcessBasicConfig {
  name: string;
  code: string;
  instancePrefix: string;
  type: DefinitionType;
  description: string;
  starterGroups: string[];
  closeGroups: string[];
  assigneeGroups?: string[];
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
  createVersion: (definitionId: string, sourceVersionId: string) => string | null;
  importDefinition: (input: ImportedProcessDefinition) => string | null;
  updateVersionBasic: (definitionId: string, versionId: string, basic: ProcessBasicConfig) => boolean;
  updateVersionFormSnapshot: (definitionId: string, versionId: string, snapshot: CompleteDesignerSnapshot["form"], systemFields: CompleteDesignerSnapshot["systemFields"]) => boolean;
  updateVersionFlowSnapshot: (definitionId: string, versionId: string, snapshot: CompleteDesignerSnapshot["flow"]) => boolean;
  publishVersion: (definitionId: string, versionId: string, changeNote: string) => boolean;
  unpublishVersion: (definitionId: string, versionId: string, reason?: string) => UnpublishVersionResult;
  switchPublishedVersion: (definitionId: string, versionId: string) => boolean;
  deleteVersion: (definitionId: string, versionId: string) => DeleteVersionResult;
  deleteDefinition: (definitionId: string) => boolean;
  toggleDefinition: (definitionId: string) => void;
  recordInstanceCreated: (definitionId: string, versionId: string) => void;
  resetDefinitions: () => void;
}

const nowText = nowDomainTimestamp;
const versionLabel = (value: number) => `V${value}`;
const createDefinitionId = () => `process-${crypto.randomUUID()}`;
const currentActorName = () => {
  if (typeof window === "undefined") return "系统";
  try {
    const persisted = JSON.parse(window.localStorage.getItem("flowpilot-prototype-v5") ?? "{}") as { state?: { personaId?: string } };
    const personaId = persisted.state?.personaId;
    return useIdentityStore.getState().users.find((user) => user.id === personaId)?.name ?? "系统";
  } catch {
    return "系统";
  }
};

const emptySnapshot = (): CompleteDesignerSnapshot => ({
  form: { fields: [createProcessTitleField()] },
  flow: { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } },
  systemFields: cloneDefaultSystemListFields(),
});

const cloneBasic = (config: ProcessBasicConfig): ProcessBasicConfig => ({
  ...config,
  starterGroups: [...config.starterGroups],
  closeGroups: [...config.closeGroups],
  assigneeGroups: config.assigneeGroups ? [...config.assigneeGroups] : undefined,
  visibleRoles: [...config.visibleRoles],
  visibleUsers: [...config.visibleUsers],
});

const validateSnapshot = (type: DefinitionType, basic: ProcessBasicConfig, snapshot: CompleteDesignerSnapshot): VersionValidation => {
  const validation = validateProcessSnapshot(
    { ...basic, type },
    snapshot,
    {
      workflowGroups: useIdentityStore.getState().workflowGroups,
      effectiveMemberIds: effectiveGroupMemberIds,
    },
  );
  return { ...validation, checkedAt: nowText() };
};

const buildVersion = (id: string, label: string, basic: ProcessBasicConfig, snapshot: CompleteDesignerSnapshot, options: Partial<ProcessVersion> = {}): ProcessVersion => {
  const createdAt = options.createdAt ?? nowText();
  const normalizedSnapshot = cloneCompleteDesignerSnapshot(snapshot);
  const formFieldCount = normalizedSnapshot.form.fields.length;
  const nodeCount = basic.type === "free" ? 0 : normalizedSnapshot.flow.nodes.length;
  return {
    id,
    version: label,
    basedOn: options.basedOn,
    createdAt,
    createdBy: options.createdBy ?? currentActorName(),
    updatedAt: options.updatedAt ?? createdAt,
    updatedBy: options.updatedBy ?? options.createdBy ?? currentActorName(),
    firstPublishedAt: options.firstPublishedAt,
    firstPublishedBy: options.firstPublishedBy,
    publishedAt: options.publishedAt,
    lastUnpublishedAt: options.lastUnpublishedAt,
    lastUnpublishedBy: options.lastUnpublishedBy,
    lastUnpublishReason: options.lastUnpublishReason,
    changeNote: options.changeNote ?? "尚未发布。",
    instanceCount: options.instanceCount ?? 0,
    formFieldCount,
    nodeCount,
    starterGroups: [...basic.starterGroups],
    checksum: `${id.slice(-6).toUpperCase()}-${formFieldCount}F-${nodeCount}N`,
    basic: cloneBasic(basic),
    snapshot: normalizedSnapshot,
    validation: validateSnapshot(basic.type, basic, normalizedSnapshot),
  };
};

const basic = (name: string, code: string, type: DefinitionType, description: string, starterGroups: string[], extra: Partial<ProcessBasicConfig> = {}): ProcessBasicConfig => ({
  name,
  code,
  instancePrefix: "",
  type,
  description,
  starterGroups,
  closeGroups: [],
  visibleRoles: [],
  visibleUsers: [],
  ...extra,
});

const seedSnapshot = (id: string, config: ProcessBasicConfig, fieldCount: number, nodeCount: number): CompleteDesignerSnapshot => {
  const fields = Array.from({ length: fieldCount }, (_, index) => ({ id: index === 0 ? "title" : `field-${index + 1}`, type: "text", label: index === 0 ? "标题" : `历史字段 ${index + 1}`, required: index === 0, listVisible: index < 3, queryable: index < 2, reviewEditable: false }));
  if (config.type === "free") return { form: { fields }, flow: { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } }, systemFields: cloneDefaultSystemListFields() };
  const groups = id.startsWith("pdf-") ? ["PDF审核_研发_流程权限组", "PDF审核_质量_流程权限组", "PDF审核_生产_流程权限组"] : id.startsWith("test-") ? ["测试报告_研发_流程权限组", "测试报告_质量_流程权限组", "测试报告_生产_流程权限组"] : ["供应商变更_评审_流程权限组"];
  const approvals = groups.map((permissionGroup, index) => ({ id: `approval-${index + 1}`, data: { kind: "approval" as const, label: permissionGroup.replace(/_流程权限组$/, ""), permissionGroup, specifyAssignee: true, editableFields: [] } }));
  const nodes = [{ id: "start", data: { kind: "start" as const, label: "开始", permissionGroups: [...config.starterGroups] } }, ...approvals, { id: "end", data: { kind: "end" as const, label: "结束" } }];
  const edges = approvals.flatMap((node, index) => [{ id: `start-${index}`, source: "start", target: node.id }, { id: `${node.id}-end`, source: node.id, target: "end" }]);
  return { form: { fields }, flow: { nodes: nodeCount >= 2 ? nodes : [], edges: nodeCount >= 2 ? edges : [], meta: { rejectionHandling: "resubmit-or-close" } }, systemFields: cloneDefaultSystemListFields() };
};

const publishedSeed = (id: string, label: string, publishedAt: string, createdBy: string, changeNote: string, instanceCount: number, config: ProcessBasicConfig, snapshot: CompleteDesignerSnapshot): ProcessVersion => buildVersion(id, label, config, snapshot, { createdAt: publishedAt, createdBy, updatedAt: publishedAt, updatedBy: createdBy, firstPublishedAt: publishedAt, firstPublishedBy: createdBy, publishedAt, changeNote, instanceCount });

const pdfBasic = basic("PDF 文件审核", "PROC-PDF-001", "approval", "受控 PDF 文件由研发、质量、生产并行审核。", ["PDF审核_文控_流程权限组"], { instancePrefix: "DOC", closeGroups: ["PDF审核_文控_流程权限组"], visibleRoles: ["ROLE-007"], visibleUsers: ["lina"] });
const testBasic = basic("测试报告审核", "PROC-TR-002", "approval", "产品测试报告会签与发布流程。", ["测试报告_发起_流程权限组"], { instancePrefix: "DOC", closeGroups: ["测试报告_发起_流程权限组"], visibleRoles: ["ROLE-004", "ROLE-005"] });
const freeBasic = basic("异常协作事项", "PROC-FREE-003", "free", "按受理人连续流转，可回复、关闭并填写理由后重新打开。", ["自由协作_发起_流程权限组"], { instancePrefix: "ISSUE", closeGroups: ["自由协作_发起_流程权限组"], assigneeGroups: ["自由协作_受理_流程权限组"], visibleRoles: ["ROLE-007"] });
const supplierBasic = basic("供应商变更评审", "PROC-SC-004", "approval", "供应商材料或制程变更的跨部门审批流程。", ["供应商变更_发起_流程权限组"], { instancePrefix: "SC", closeGroups: ["供应商变更_发起_流程权限组"] });
const testV2Snapshot = (() => {
  const snapshot = seedSnapshot("test-v2", testBasic, 6, 5);
  const productionNodeIds = new Set(snapshot.flow.nodes
    .filter((node) => node.data?.kind === "approval" && node.data.permissionGroup === "测试报告_生产_流程权限组")
    .map((node) => node.id));
  return {
    ...snapshot,
    flow: {
      ...snapshot.flow,
      nodes: snapshot.flow.nodes.filter((node) => !productionNodeIds.has(node.id)),
      edges: snapshot.flow.edges.filter((edge) => !productionNodeIds.has(edge.source) && !productionNodeIds.has(edge.target)),
    },
  };
})();

const initialDefinitions: ProcessDefinition[] = [
  { id: "pdf-review", code: pdfBasic.code, name: pdfBasic.name, description: pdfBasic.description, type: "approval", disabled: false, publishedVersionId: "pdf-v3", nextVersionNumber: 4, updatedAt: "2026-08-12 16:42", updatedBy: "王敏", instanceCount: 128, versions: [publishedSeed("pdf-v3", "V3", "2026-08-02 14:30", "王敏", "增加质量节点可修改字段并优化并行提醒。", 42, pdfBasic, seedSnapshot("pdf-v3", pdfBasic, 9, 5)), publishedSeed("pdf-v2", "V2", "2026-05-16 10:05", "刘燕", "研发、质量和生产改为同起点并行审核。", 71, pdfBasic, seedSnapshot("pdf-v2", pdfBasic, 8, 5)), publishedSeed("pdf-v1", "V1", "2026-02-12 09:20", "系统管理员", "首次发布。", 15, pdfBasic, seedSnapshot("pdf-v1", pdfBasic, 7, 5))] },
  {
    id: "test-report-review",
    code: testBasic.code,
    name: testBasic.name,
    description: testBasic.description,
    type: "approval",
    disabled: false,
    nextVersionNumber: 3,
    updatedAt: "2026-08-13 09:18",
    updatedBy: "林晓",
    instanceCount: 2,
    versions: [
      buildVersion("test-report-v2", "V2", testBasic, testV2Snapshot, {
        basedOn: "V1",
        createdAt: "2026-07-15 10:20",
        createdBy: "林晓",
        updatedAt: "2026-08-13 09:18",
        updatedBy: "林晓",
        firstPublishedAt: "2026-07-18 14:10",
        firstPublishedBy: "林晓",
        lastUnpublishedAt: "2026-08-13 09:18",
        lastUnpublishedBy: "林晓",
        lastUnpublishReason: "暂停新测试报告发起，历史实例继续处理。",
        changeNote: "调整测试报告审核字段并保留历史运行版本。",
        instanceCount: 1,
      }),
      buildVersion("test-report-v1", "V1", testBasic, seedSnapshot("test-v1", testBasic, 5, 5), {
        createdAt: "2026-04-12 09:30",
        createdBy: "林晓",
        updatedAt: "2026-07-18 14:10",
        updatedBy: "林晓",
        firstPublishedAt: "2026-04-15 11:00",
        firstPublishedBy: "林晓",
        lastUnpublishedAt: "2026-07-18 14:10",
        lastUnpublishedBy: "林晓",
        lastUnpublishReason: "切换到 V2。",
        changeNote: "测试报告审核初始版本。",
        instanceCount: 1,
      }),
    ],
  },
  { id: "free-collaboration", code: freeBasic.code, name: freeBasic.name, description: freeBasic.description, type: "free", disabled: false, publishedVersionId: "free-v2", nextVersionNumber: 3, updatedAt: "2026-08-10 14:06", updatedBy: "系统管理员", instanceCount: 67, versions: [publishedSeed("free-v2", "V2", "2026-07-30 16:18", "王敏", "增加异常改派；重新打开时恢复初始表单编辑。", 39, freeBasic, seedSnapshot("free-v2", freeBasic, 5, 0)), publishedSeed("free-v1", "V1", "2026-04-08 11:42", "系统管理员", "首次发布自由协作流程。", 28, freeBasic, seedSnapshot("free-v1", freeBasic, 4, 0))] },
  { id: "supplier-change-review", code: supplierBasic.code, name: "供应商变更会签", description: supplierBasic.description, type: "approval", disabled: true, publishedVersionId: "supplier-v2", nextVersionNumber: 3, updatedAt: "2026-07-28 11:25", updatedBy: "赵磊", instanceCount: 21, versions: [publishedSeed("supplier-v2", "V2", "2026-07-28 11:25", "赵磊", "调整评审说明和发起范围，当前没有实例。", 0, { ...supplierBasic, name: "供应商变更会签" }, seedSnapshot("supplier-v2", { ...supplierBasic, name: "供应商变更会签" }, 7, 4)), publishedSeed("supplier-v1", "V1", "2026-07-20 11:25", "赵磊", "首次发布供应商变更评审。", 21, supplierBasic, seedSnapshot("supplier-v1", supplierBasic, 6, 4))] },
];

const hasRunnableApprovalTopology = (version: ProcessVersion) => {
  const approvals = version.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval");
  return approvals.length > 0 && version.snapshot.flow.edges.length > 0;
};

const repairBuiltInHistoricalVersions = (definition: ProcessDefinition): ProcessDefinition => {
  if (definition.id !== "test-report-review") return definition;
  const fallback = initialDefinitions.find((item) => item.id === definition.id)!;
  const remaining = [...definition.versions];
  const requiredVersions = fallback.versions.map((seedVersion) => {
    const index = remaining.findIndex((version) => version.version === seedVersion.version);
    const existing = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    if (existing && hasRunnableApprovalTopology(existing)) {
      return { ...existing, instanceCount: Math.max(existing.instanceCount, seedVersion.instanceCount) };
    }
    return {
      ...seedVersion,
      basic: cloneBasic(seedVersion.basic),
      snapshot: cloneCompleteDesignerSnapshot(seedVersion.snapshot),
    };
  });
  const versions = [...requiredVersions, ...remaining];
  const allocated = versions.map((version) => Number(version.version.replace(/\D/g, ""))).filter(Number.isFinite);
  return {
    ...definition,
    versions,
    nextVersionNumber: Math.max(definition.nextVersionNumber, Math.max(0, ...allocated) + 1),
    instanceCount: Math.max(definition.instanceCount, fallback.instanceCount),
  };
};

const nextSequence = (definitions: ProcessDefinition[]) => Math.max(0, ...definitions.map((definition) => Number(definition.code.match(/(\d+)$/)?.[1] ?? 0))) + 1;

export const getPublishedVersion = (definition?: ProcessDefinition) => definition?.versions.find((version) => version.id === definition.publishedVersionId);
export const getVersionStatus = (definition: ProcessDefinition, versionId: string): VersionStatus => definition.publishedVersionId === versionId ? "已发布" : definition.versions.find((version) => version.id === versionId)?.validation.status === "通过" ? "可发布" : "校验未通过";
export const canEditVersion = (definition: ProcessDefinition, version: ProcessVersion) => definition.publishedVersionId !== version.id && version.instanceCount === 0;
export const definitionStatus = (definition: ProcessDefinition): DefinitionStatus => definition.disabled ? "已停用" : definition.publishedVersionId ? "已发布" : "未发布";

const refreshVersion = (version: ProcessVersion, config: ProcessBasicConfig, snapshot: CompleteDesignerSnapshot): ProcessVersion => {
  const next = buildVersion(version.id, version.version, config, snapshot, { ...version, updatedAt: nowText(), updatedBy: currentActorName() });
  return { ...next, firstPublishedAt: version.firstPublishedAt, firstPublishedBy: version.firstPublishedBy, publishedAt: version.publishedAt, lastUnpublishedAt: version.lastUnpublishedAt, lastUnpublishedBy: version.lastUnpublishedBy, instanceCount: version.instanceCount };
};

export const useProcessDefinitionStore = create<ProcessDefinitionState>()(
  persist(
    (set, get) => ({
      definitions: initialDefinitions,
      createDefinition: ({ name, type, description }) => {
        if (!currentUserCan("config-definition:编辑")) return "";
        const definitions = get().definitions;
        const sequence = nextSequence(definitions);
        const id = createDefinitionId();
        const code = `PROC-${type === "approval" ? "AP" : "FREE"}-${String(sequence).padStart(3, "0")}`;
        const config = basic(name.trim(), code, type, description?.trim() || "尚未填写流程说明。", []);
        const firstVersion = buildVersion(`${id}-v1`, "V1", config, emptySnapshot());
        set({ definitions: [{ id, code, name: config.name, description: config.description, type, disabled: false, nextVersionNumber: 2, versions: [firstVersion], updatedAt: nowText(), updatedBy: currentActorName(), instanceCount: 0 }, ...definitions] });
        return id;
      },
      copyDefinition: (definitionId) => {
        if (!currentUserCan("config-definition:编辑")) return null;
        const definitions = get().definitions;
        const source = definitions.find((definition) => definition.id === definitionId);
        const sourceVersion = getPublishedVersion(source) ?? source?.versions[0];
        if (!source || !sourceVersion) return null;
        const sequence = nextSequence(definitions);
        const id = createDefinitionId();
        const code = `PROC-${source.type === "approval" ? "AP" : "FREE"}-${String(sequence).padStart(3, "0")}`;
        const config = cloneBasic({ ...sourceVersion.basic, code, name: `${sourceVersion.basic.name}（副本）` });
        const copiedVersion = buildVersion(`${id}-v1`, "V1", config, sourceVersion.snapshot, { basedOn: `${source.code} / ${sourceVersion.version}` });
        set({ definitions: [{ id, code, name: config.name, description: config.description, type: source.type, disabled: false, nextVersionNumber: 2, versions: [copiedVersion], updatedAt: nowText(), updatedBy: currentActorName(), instanceCount: 0 }, ...definitions] });
        return id;
      },
      createVersion: (definitionId, sourceVersionId) => {
        if (!currentUserCan("config-definition:编辑")) return null;
        let createdId: string | null = null;
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          const source = definition.versions.find((version) => version.id === sourceVersionId);
          if (!source) return definition;
          const label = versionLabel(definition.nextVersionNumber);
          createdId = `${definition.id}-${label.toLowerCase()}-${Date.now()}`;
          return { ...definition, nextVersionNumber: definition.nextVersionNumber + 1, versions: [buildVersion(createdId, label, source.basic, source.snapshot, { basedOn: source.version }), ...definition.versions], updatedAt: nowText(), updatedBy: currentActorName() };
        }) }));
        return createdId;
      },
      importDefinition: (input) => {
        if (!currentUserCan("config-definition:编辑") || !input.versions.length) return null;
        const definitions = get().definitions;
        const sequence = nextSequence(definitions);
        const id = createDefinitionId();
        const code = `PROC-${input.type === "approval" ? "AP" : "FREE"}-${String(sequence).padStart(3, "0")}`;
        const importedName = definitions.some((definition) => definition.name === input.name)
          ? `${input.name}（导入）`
          : input.name;
        const usedLabels = new Set<string>();
        const versions = input.versions.map((source, index) => {
          let label = /^V\d+$/.test(source.version) ? source.version : versionLabel(index + 1);
          if (usedLabels.has(label)) label = versionLabel(Math.max(index + 1, ...[...usedLabels].map((value) => Number(value.slice(1)) + 1)));
          usedLabels.add(label);
          const basicConfig = cloneBasic({
            ...source.basic,
            name: importedName,
            code,
            type: input.type,
          });
          return buildVersion(`${id}-${label.toLowerCase()}-${crypto.randomUUID()}`, label, basicConfig, source.snapshot, {
            basedOn: `文件导入 · 原 ${source.version}（${source.sourceStatus}）`,
            changeNote: source.changeNote || "从导入文件创建",
          });
        });
        const allocated = versions.map((version) => Number(version.version.slice(1))).filter(Number.isFinite);
        const created: ProcessDefinition = {
          id,
          code,
          name: importedName,
          description: input.description,
          type: input.type,
          disabled: false,
          nextVersionNumber: Math.max(0, ...allocated) + 1,
          versions,
          updatedAt: nowText(),
          updatedBy: currentActorName(),
          instanceCount: 0,
        };
        set({ definitions: [created, ...definitions] });
        return id;
      },
      updateVersionBasic: (definitionId, versionId, config) => {
        if (!currentUserCan("config-definition:编辑")) return false;
        let updated = false;
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          const target = definition.versions.find((version) => version.id === versionId);
          if (!target || !canEditVersion(definition, target)) return definition;
          updated = true;
          return { ...definition, name: definition.publishedVersionId ? definition.name : config.name, description: definition.publishedVersionId ? definition.description : config.description, type: config.type, code: config.code, updatedAt: nowText(), updatedBy: currentActorName(), versions: definition.versions.map((version) => version.id === versionId ? refreshVersion(version, config, version.snapshot) : version) };
        }) }));
        return updated;
      },
      updateVersionFormSnapshot: (definitionId, versionId, formSnapshot, systemFields) => {
        if (!currentUserCan("config-form:编辑")) return false;
        let updated = false;
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          const target = definition.versions.find((version) => version.id === versionId);
          if (!target || !canEditVersion(definition, target)) return definition;
          updated = true;
          const snapshot = {
            ...target.snapshot,
            form: { ...structuredClone(formSnapshot), fields: ensureProcessTitleField(formSnapshot.fields) },
            systemFields: structuredClone(systemFields),
          };
          return { ...definition, updatedAt: nowText(), updatedBy: currentActorName(), versions: definition.versions.map((version) => version.id === versionId ? refreshVersion(version, version.basic, snapshot) : version) };
        }) }));
        return updated;
      },
      updateVersionFlowSnapshot: (definitionId, versionId, flowSnapshot) => {
        if (!currentUserCan("config-definition:编辑")) return false;
        let updated = false;
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          const target = definition.versions.find((version) => version.id === versionId);
          if (!target || !canEditVersion(definition, target)) return definition;
          updated = true;
          const snapshot = { ...target.snapshot, flow: structuredClone(flowSnapshot) };
          return { ...definition, updatedAt: nowText(), updatedBy: currentActorName(), versions: definition.versions.map((version) => version.id === versionId ? refreshVersion(version, version.basic, snapshot) : version) };
        }) }));
        return updated;
      },
      publishVersion: (definitionId, versionId, changeNote) => {
        if (!currentUserCan("config-definition:发布")) return false;
        let published = false;
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          const target = definition.versions.find((version) => version.id === versionId);
          if (!target) return definition;
          const checked = refreshVersion(target, target.basic, target.snapshot);
          if (checked.validation.status !== "通过") return { ...definition, versions: definition.versions.map((version) => version.id === target.id ? checked : version) };
          published = true;
          const publishedAt = nowText();
          const released: ProcessVersion = { ...checked, changeNote, firstPublishedAt: checked.firstPublishedAt ?? publishedAt, firstPublishedBy: checked.firstPublishedBy ?? currentActorName(), publishedAt, updatedAt: publishedAt, updatedBy: currentActorName() };
          return { ...definition, name: released.basic.name, description: released.basic.description, type: released.basic.type, publishedVersionId: released.id, updatedAt: publishedAt, updatedBy: currentActorName(), versions: definition.versions.map((version) => version.id === released.id ? released : version) };
        }) }));
        return published;
      },
      unpublishVersion: (definitionId, versionId, reason) => {
        if (!currentUserCan("config-definition:发布")) return "not-found";
        let result: UnpublishVersionResult = "not-found";
        set((state) => ({ definitions: state.definitions.map((definition) => {
          if (definition.id !== definitionId) return definition;
          if (definition.publishedVersionId !== versionId) { result = "not-published"; return definition; }
          const target = definition.versions.find((version) => version.id === versionId);
          if (!target) return definition;
          result = "unpublished";
          const at = nowText();
          return { ...definition, publishedVersionId: undefined, updatedAt: at, updatedBy: currentActorName(), versions: definition.versions.map((version) => version.id === versionId ? { ...version, lastUnpublishedAt: at, lastUnpublishedBy: currentActorName(), lastUnpublishReason: reason?.trim() || "未填写原因" } : version) };
        }) }));
        return result;
      },
      switchPublishedVersion: (definitionId, versionId) => {
        if (!currentUserCan("config-definition:发布")) return false;
        const target = get().definitions.find((definition) => definition.id === definitionId)?.versions.find((version) => version.id === versionId);
        return target ? get().publishVersion(definitionId, versionId, target.changeNote || "切换为发布版本") : false;
      },
      deleteVersion: (definitionId, versionId) => {
        if (!currentUserCan("config-definition:删除")) return "not-found";
        const definition = get().definitions.find((item) => item.id === definitionId);
        const target = definition?.versions.find((version) => version.id === versionId);
        if (!definition || !target) return "not-found";
        if (definition.publishedVersionId === versionId) return "published";
        if (target.instanceCount > 0) return "has-instances";
        const remaining = definition.versions.filter((version) => version.id !== versionId);
        if (!remaining.length) {
          set({ definitions: get().definitions.filter((item) => item.id !== definitionId) });
          clearDefinitionDesignerArtifacts(definitionId);
          return "definition-deleted";
        }
        set({ definitions: get().definitions.map((item) => item.id === definitionId ? { ...item, versions: remaining, updatedAt: nowText(), updatedBy: currentActorName() } : item) });
        return "deleted";
      },
      deleteDefinition: (definitionId) => {
        if (!currentUserCan("config-definition:删除")) return false;
        const definition = get().definitions.find((item) => item.id === definitionId);
        if (!definition || definition.publishedVersionId || definition.instanceCount > 0 || definition.versions.some((version) => version.instanceCount > 0)) return false;
        set({ definitions: get().definitions.filter((item) => item.id !== definitionId) });
        clearDefinitionDesignerArtifacts(definitionId);
        return true;
      },
      toggleDefinition: (definitionId) => currentUserCan("config-definition:编辑") && set((state) => ({ definitions: state.definitions.map((definition) => definition.id === definitionId && definition.publishedVersionId ? { ...definition, disabled: !definition.disabled, updatedAt: nowText(), updatedBy: currentActorName() } : definition) })),
      recordInstanceCreated: (definitionId, versionId) => set((state) => ({ definitions: state.definitions.map((definition) => definition.id === definitionId ? { ...definition, instanceCount: definition.instanceCount + 1, versions: definition.versions.map((version) => version.id === versionId ? { ...version, instanceCount: version.instanceCount + 1 } : version) } : definition) })),
      resetDefinitions: () => set({ definitions: initialDefinitions }),
    }),
    {
      name: "flowpilot-process-definitions-v1",
      version: 16,
      migrate: (persisted) => {
        const legacyState = persisted as { definitions?: Array<Record<string, unknown>> };
        if (!legacyState.definitions) return { definitions: initialDefinitions };
        const definitions = legacyState.definitions.map((raw) => {
          const fallback = initialDefinitions.find((item) => item.id === raw.id);
          const legacyVersions = Array.isArray(raw.versions) ? raw.versions as Array<Record<string, unknown>> : [];
          const legacyDraft = raw.draft as Record<string, unknown> | undefined;
          const normalizeBasic = (value: unknown): ProcessBasicConfig => {
            const source = (value ?? fallback?.versions[0]?.basic ?? {}) as Partial<ProcessBasicConfig> & { starterGroup?: string; assigneeGroup?: string };
            const starterGroups = Array.isArray(source.starterGroups) ? [...source.starterGroups] : source.starterGroup ? [source.starterGroup] : [];
            const legacySource = source as typeof source & { closeGroups?: string[]; closerGroups?: string[] };
            const closeGroups = Array.isArray(legacySource.closeGroups)
              ? [...legacySource.closeGroups]
              : Array.isArray(legacySource.closerGroups)
                ? [...legacySource.closerGroups]
                : [...starterGroups];
            const visibleRoles = (source.visibleRoles ?? []).flatMap((value) => {
              const role = useIdentityStore.getState().roles.find((item) => item.id === value || item.name === value);
              return role ? [role.id] : [];
            });
            return { name: source.name ?? String(raw.name ?? "未命名流程"), code: source.code ?? String(raw.code ?? "PROC-UNKNOWN"), instancePrefix: source.instancePrefix ?? "", type: source.type ?? (raw.type as DefinitionType) ?? "approval", description: source.description ?? String(raw.description ?? ""), starterGroups, closeGroups, assigneeGroups: Array.isArray(source.assigneeGroups) ? [...source.assigneeGroups] : source.assigneeGroup ? [source.assigneeGroup] : undefined, visibleRoles, visibleUsers: (source.visibleUsers ?? []).map((value) => value === "linxiao" ? "lina" : value) };
          };
          const normalizeVersion = (item: Record<string, unknown>): ProcessVersion => {
            const config = normalizeBasic(item.basic);
            const snapshot = cloneCompleteDesignerSnapshot(item.snapshot as CompleteDesignerSnapshot | undefined);
            return buildVersion(String(item.id), String(item.version).toUpperCase(), config, snapshot, { basedOn: item.basedOn as string | undefined, createdAt: String(item.createdAt ?? item.firstPublishedAt ?? item.publishedAt ?? nowText()), createdBy: String(item.createdBy ?? "历史数据"), updatedAt: String(item.updatedAt ?? item.publishedAt ?? nowText()), updatedBy: String(item.updatedBy ?? item.createdBy ?? "历史数据"), firstPublishedAt: (item.firstPublishedAt ?? item.publishedAt) as string | undefined, firstPublishedBy: (item.firstPublishedBy ?? item.createdBy) as string | undefined, publishedAt: item.publishedAt as string | undefined, lastUnpublishedAt: (item.lastUnpublishedAt ?? item.lastWithdrawnAt) as string | undefined, lastUnpublishedBy: (item.lastUnpublishedBy ?? item.lastWithdrawnBy) as string | undefined, lastUnpublishReason: item.lastUnpublishReason as string | undefined, changeNote: String(item.changeNote ?? "历史版本"), instanceCount: Number(item.instanceCount ?? 0) });
          };
          let versions = legacyVersions.map(normalizeVersion);
          let publishedVersionId = (raw.publishedVersionId ?? raw.effectiveVersionId) as string | undefined;
          if (legacyDraft) {
            const draftBasic = normalizeBasic(legacyDraft.basic);
            const draftSnapshot = cloneCompleteDesignerSnapshot(legacyDraft.snapshot as CompleteDesignerSnapshot | undefined);
            const withdrawnId = legacyDraft.withdrawnVersionId as string | undefined;
            const targetId = withdrawnId ?? String(legacyDraft.id).replace(/-draft$/, "");
            const oldTarget = versions.find((version) => version.id === withdrawnId);
            const converted = buildVersion(targetId, String(legacyDraft.version ?? "V1").toUpperCase(), draftBasic, draftSnapshot, { basedOn: legacyDraft.basedOn as string | undefined, createdAt: String(legacyDraft.updatedAt ?? nowText()), createdBy: "历史数据", updatedAt: String(legacyDraft.updatedAt ?? nowText()), updatedBy: "历史数据", instanceCount: oldTarget?.instanceCount ?? 0, firstPublishedAt: oldTarget?.firstPublishedAt, firstPublishedBy: oldTarget?.firstPublishedBy, publishedAt: oldTarget?.publishedAt });
            versions = [converted, ...versions.filter((version) => version.id !== targetId)];
            if (withdrawnId) publishedVersionId = undefined;
          }
          if (!versions.length && fallback) versions = fallback.versions.map((version) => ({ ...version, basic: cloneBasic(version.basic), snapshot: cloneCompleteDesignerSnapshot(version.snapshot) }));
          const published = versions.find((version) => version.id === publishedVersionId);
          const allocated = versions.map((version) => Number(version.version.replace(/\D/g, ""))).filter(Number.isFinite);
          return { id: String(raw.id), code: String(raw.code ?? published?.basic.code ?? versions[0]?.basic.code ?? "PROC-UNKNOWN"), name: published?.basic.name ?? String(raw.name ?? versions[0]?.basic.name ?? "未命名流程"), description: published?.basic.description ?? String(raw.description ?? versions[0]?.basic.description ?? ""), type: (raw.type as DefinitionType) ?? versions[0]?.basic.type ?? "approval", disabled: Boolean(raw.disabled && publishedVersionId), publishedVersionId: versions.some((version) => version.id === publishedVersionId) ? publishedVersionId : undefined, nextVersionNumber: Number(raw.nextVersionNumber ?? Math.max(0, ...allocated) + 1), versions, updatedAt: String(raw.updatedAt ?? nowText()), updatedBy: String(raw.updatedBy ?? "历史数据"), instanceCount: Number(raw.instanceCount ?? versions.reduce((total, version) => total + version.instanceCount, 0)) } satisfies ProcessDefinition;
        }).map(repairBuiltInHistoricalVersions);
        return { definitions };
      },
    },
  ),
);
