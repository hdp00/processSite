import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedProcessDefinition } from "../utils/processDefinitionTransfer";
import { installMemoryBrowserStorage, type MemoryStorage } from "../test/memoryStorage";
import type { ProcessBasicConfig, ProcessDefinition, ProcessVersion } from "./useProcessDefinitionStore";

let storage: MemoryStorage;
let definitionModule: typeof import("./useProcessDefinitionStore");
let identityModule: typeof import("./useIdentityStore");

const definitionById = (definitionId: string) =>
  definitionModule.useProcessDefinitionStore.getState().definitions.find((definition) => definition.id === definitionId);

const setActor = (personaId: string) => {
  storage.setItem("flowpilot-prototype-v5", JSON.stringify({ state: { authenticated: true, personaId } }));
};

const replaceDefinition = (definitionId: string, updater: (definition: ProcessDefinition) => ProcessDefinition) => {
  definitionModule.useProcessDefinitionStore.setState((state) => ({
    definitions: state.definitions.map((definition) => definition.id === definitionId ? updater(definition) : definition),
  }));
};

const cloneVersion = (version: ProcessVersion, overrides: Partial<ProcessVersion> = {}): ProcessVersion => ({
  ...structuredClone(version),
  ...overrides,
});

beforeAll(async () => {
  ({ localStorage: storage } = installMemoryBrowserStorage());
  identityModule = await import("./useIdentityStore");
  definitionModule = await import("./useProcessDefinitionStore");
});

beforeEach(() => {
  vi.restoreAllMocks();
  storage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  setActor("superadmin");
});

describe("流程定义状态与缺失目标边界", () => {
  it("状态辅助函数区分停用、发布、未发布、可编辑和未知版本", () => {
    const published = definitionById("pdf-review")!;
    const disabled = definitionById("supplier-change-review")!;
    const unpublished = definitionById("test-report-review")!;
    const publishedVersion = definitionModule.getPublishedVersion(published)!;
    const editableVersion = unpublished.versions.find((version) => version.instanceCount === 0) ?? cloneVersion(unpublished.versions[0], { instanceCount: 0 });

    expect(definitionModule.definitionStatus(published)).toBe("已发布");
    expect(definitionModule.definitionStatus(disabled)).toBe("已停用");
    expect(definitionModule.definitionStatus(unpublished)).toBe("未发布");
    expect(definitionModule.getPublishedVersion(unpublished)).toBeUndefined();
    expect(definitionModule.getVersionStatus(unpublished, "missing-version")).toBe("校验未通过");
    expect(definitionModule.canEditVersion(published, publishedVersion)).toBe(false);
    expect(definitionModule.canEditVersion(unpublished, cloneVersion(editableVersion, { instanceCount: 1 }))).toBe(false);
    expect(definitionModule.canEditVersion(unpublished, editableVersion)).toBe(true);
  });

  it("所有按标识寻址的动作遇到缺失定义或版本时返回失败且不改变数据", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const source = definitionModule.getPublishedVersion(definitionById("pdf-review"))!;
    const before = structuredClone(store.definitions);

    expect(store.copyDefinition("missing-definition")).toBeNull();
    expect(store.createVersion("missing-definition", source.id)).toBeNull();
    expect(store.createVersion("pdf-review", "missing-version")).toBeNull();
    expect(store.updateVersionBasic("missing-definition", source.id, source.basic)).toBe(false);
    expect(store.updateVersionBasic("pdf-review", "missing-version", source.basic)).toBe(false);
    expect(store.updateVersionFormSnapshot("missing-definition", source.id, source.snapshot.form, source.snapshot.systemFields)).toBe(false);
    expect(store.updateVersionFormSnapshot("pdf-review", "missing-version", source.snapshot.form, source.snapshot.systemFields)).toBe(false);
    expect(store.updateVersionFlowSnapshot("missing-definition", source.id, source.snapshot.flow)).toBe(false);
    expect(store.updateVersionFlowSnapshot("pdf-review", "missing-version", source.snapshot.flow)).toBe(false);
    expect(store.revalidateVersion("missing-definition", source.id)).toBe(false);
    expect(store.revalidateVersion("pdf-review", "missing-version")).toBe(false);
    expect(store.publishVersion("missing-definition", source.id, "不会发布")).toBe(false);
    expect(store.publishVersion("pdf-review", "missing-version", "不会发布")).toBe(false);
    expect(store.unpublishVersion("missing-definition", source.id)).toBe("not-found");
    expect(store.switchPublishedVersion("missing-definition", source.id)).toBe(false);
    expect(store.switchPublishedVersion("pdf-review", "missing-version")).toBe(false);
    expect(store.deleteVersion("missing-definition", source.id)).toBe("not-found");
    expect(store.deleteVersion("pdf-review", "missing-version")).toBe("not-found");
    expect(store.deleteDefinition("missing-definition")).toBe(false);
    store.toggleDefinition("missing-definition");

    expect(definitionModule.useProcessDefinitionStore.getState().definitions).toEqual(before);
  });

  it("无配置权限用户的创建、导入、保存、发布、删除和停用均安全拒绝", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const source = definitionModule.getPublishedVersion(definitionById("pdf-review"))!;
    const input: ImportedProcessDefinition = {
      name: "越权导入",
      type: "approval",
      description: "不应创建",
      versions: [{
        version: "V1",
        sourceStatus: "已发布",
        changeNote: "越权",
        basic: structuredClone(source.basic),
        snapshot: structuredClone(source.snapshot),
      }],
    };
    const before = structuredClone(store.definitions);
    setActor("hejing");

    expect(store.createDefinition({ name: "越权创建", type: "approval" })).toBe("");
    expect(store.copyDefinition("pdf-review")).toBeNull();
    expect(store.createVersion("pdf-review", source.id)).toBeNull();
    expect(store.importDefinition(input)).toBeNull();
    expect(store.updateVersionBasic("pdf-review", source.id, source.basic)).toBe(false);
    expect(store.updateVersionFormSnapshot("pdf-review", source.id, source.snapshot.form, source.snapshot.systemFields)).toBe(false);
    expect(store.updateVersionFlowSnapshot("pdf-review", source.id, source.snapshot.flow)).toBe(false);
    expect(store.publishVersion("pdf-review", source.id, "越权发布")).toBe(false);
    expect(store.unpublishVersion("pdf-review", source.id, "越权取消")).toBe("not-found");
    expect(store.switchPublishedVersion("pdf-review", source.id)).toBe(false);
    expect(store.deleteVersion("pdf-review", source.id)).toBe("not-found");
    expect(store.deleteDefinition("pdf-review")).toBe(false);
    store.toggleDefinition("pdf-review");

    expect(definitionModule.useProcessDefinitionStore.getState().definitions).toEqual(before);
  });
});

describe("流程定义复制、导入与保存边界", () => {
  it("复制可回退到未发布首版本，空版本定义则拒绝且快照保持独立", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const free = definitionById("free-collaboration")!;
    const draftSource: ProcessDefinition = {
      ...structuredClone(free),
      id: "free-draft-source",
      code: "PROC-FREE-998",
      publishedVersionId: undefined,
      disabled: false,
      versions: [cloneVersion(free.versions[0], { id: "free-draft-v1", version: "V1", instanceCount: 0 })],
      instanceCount: 0,
    };
    const emptySource: ProcessDefinition = {
      ...structuredClone(draftSource),
      id: "empty-source",
      code: "PROC-FREE-999",
      versions: [],
    };
    definitionModule.useProcessDefinitionStore.setState((state) => ({
      definitions: [draftSource, emptySource, ...state.definitions],
    }));

    expect(store.copyDefinition(emptySource.id)).toBeNull();
    const copiedId = store.copyDefinition(draftSource.id)!;
    const copied = definitionById(copiedId)!;
    expect(copied.code).toMatch(/^PROC-FREE-/);
    expect(copied.name).toBe(`${draftSource.versions[0].basic.name}（副本）`);
    expect(copied.publishedVersionId).toBeUndefined();
    expect(copied.versions[0].basedOn).toBe(`${draftSource.code} / V1`);
    expect(copied.versions[0].snapshot).toEqual(draftSource.versions[0].snapshot);
    expect(copied.versions[0].snapshot).not.toBe(draftSource.versions[0].snapshot);
  });

  it("导入拒绝空版本，并归一化自由流程的非法或重复版本号与空变更说明", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const source = definitionModule.getPublishedVersion(definitionById("free-collaboration"))!;
    expect(store.importDefinition({ name: "空导入", type: "free", description: "", versions: [] })).toBeNull();

    const versionInput = (version: string, changeNote: string) => ({
      version,
      sourceStatus: "历史版本",
      changeNote,
      basic: structuredClone(source.basic),
      snapshot: structuredClone(source.snapshot),
    });
    const importedId = store.importDefinition({
      name: "自由协作迁移件",
      type: "free",
      description: "版本编号边界",
      versions: [versionInput("release", ""), versionInput("V1", "第二版"), versionInput("V1", "第三版")],
    })!;
    const imported = definitionById(importedId)!;

    expect(imported.name).toBe("自由协作迁移件");
    expect(imported.code).toMatch(/^PROC-FREE-/);
    expect(imported.nextVersionNumber).toBe(4);
    expect(imported.versions.map((version) => version.version)).toEqual(["V1", "V2", "V3"]);
    expect(imported.versions.map((version) => version.changeNote)).toEqual(["从导入文件创建", "第二版", "第三版"]);
    expect(imported.versions[0].basedOn).toBe("文件导入 · 原 release（历史版本）");
  });

  it("发布版本和已有实例版本均不可保存，草稿解除锁定后可深拷贝保存", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const source = definitionModule.getPublishedVersion(definition)!;
    expect(store.updateVersionBasic(definition.id, source.id, { ...source.basic, name: "不应覆盖" })).toBe(false);
    expect(store.updateVersionFormSnapshot(definition.id, source.id, source.snapshot.form, source.snapshot.systemFields)).toBe(false);
    expect(store.updateVersionFlowSnapshot(definition.id, source.id, source.snapshot.flow)).toBe(false);

    const draftId = store.createVersion(definition.id, source.id)!;
    replaceDefinition(definition.id, (current) => ({
      ...current,
      versions: current.versions.map((version) => version.id === draftId ? { ...version, instanceCount: 1 } : version),
    }));
    const locked = definitionById(definition.id)!.versions.find((version) => version.id === draftId)!;
    expect(store.updateVersionBasic(definition.id, draftId, { ...locked.basic, name: "仍不应覆盖" })).toBe(false);
    expect(store.updateVersionFormSnapshot(definition.id, draftId, { fields: [] }, locked.snapshot.systemFields)).toBe(false);
    expect(store.updateVersionFlowSnapshot(definition.id, draftId, locked.snapshot.flow)).toBe(false);

    replaceDefinition(definition.id, (current) => ({
      ...current,
      versions: current.versions.map((version) => version.id === draftId ? { ...version, instanceCount: 0 } : version),
    }));
    const editable = definitionById(definition.id)!.versions.find((version) => version.id === draftId)!;
    const nextBasic: ProcessBasicConfig = { ...editable.basic, name: "PDF 文件审核草稿", description: "草稿说明" };
    const formInput = { fields: [] };
    const flowInput = structuredClone(editable.snapshot.flow);
    const systemFieldsInput = structuredClone(editable.snapshot.systemFields);
    expect(store.updateVersionBasic(definition.id, draftId, nextBasic)).toBe(true);
    expect(store.updateVersionFormSnapshot(definition.id, draftId, formInput, systemFieldsInput)).toBe(true);
    expect(store.updateVersionFlowSnapshot(definition.id, draftId, flowInput)).toBe(true);

    const savedDefinition = definitionById(definition.id)!;
    const saved = savedDefinition.versions.find((version) => version.id === draftId)!;
    expect(savedDefinition.name).toBe(definition.name);
    expect(saved.basic.name).toBe("PDF 文件审核草稿");
    expect(saved.snapshot.form.fields.map((field) => field.id)).toEqual(["title"]);
    expect(saved.snapshot.flow).toEqual(flowInput);
    expect(saved.snapshot.flow).not.toBe(flowInput);
    expect(saved.snapshot.systemFields).toEqual(systemFieldsInput);
    expect(saved.snapshot.systemFields).not.toBe(systemFieldsInput);
  });
});

describe("发布、停用与删除边界", () => {
  it("发布前始终重新校验快照，伪造的通过状态不会产生发布版本", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definitionId = store.createDefinition({ name: "未配置审批", type: "approval", description: "校验边界" });
    const before = definitionById(definitionId)!;
    const versionId = before.versions[0].id;
    replaceDefinition(definitionId, (definition) => ({
      ...definition,
      versions: definition.versions.map((version) => version.id === versionId
        ? { ...version, validation: { status: "通过", checkedAt: "伪造时间", issues: [] } }
        : version),
    }));

    expect(store.publishVersion(definitionId, versionId, "不应发布")).toBe(false);
    const checked = definitionById(definitionId)!;
    expect(checked.publishedVersionId).toBeUndefined();
    expect(checked.name).toBe(before.name);
    expect(checked.updatedAt).toBe(before.updatedAt);
    expect(checked.versions[0].validation.status).toBe("未通过");
    expect(checked.versions[0].validation.issues.length).toBeGreaterThan(0);
    expect(checked.versions[0].firstPublishedAt).toBeUndefined();
  });

  it("已有实例的只读版本仍可按最新外部依赖重新校验并再次发布", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const version = definitionModule.getPublishedVersion(definition)!;
    expect(version.instanceCount).toBeGreaterThan(0);
    expect(store.unpublishVersion(definition.id, version.id, "验证只读版本重新校验")).toBe("unpublished");
    replaceDefinition(definition.id, (current) => ({
      ...current,
      versions: current.versions.map((item) => item.id === version.id
        ? { ...item, validation: { status: "未通过", checkedAt: "权限组修复前", issues: ["权限组没有有效成员"] } }
        : item),
    }));
    const before = structuredClone(definitionById(definition.id)!.versions.find((item) => item.id === version.id)!.snapshot);

    expect(definitionModule.canEditVersion(definitionById(definition.id)!, definitionById(definition.id)!.versions.find((item) => item.id === version.id)!)).toBe(false);
    expect(store.revalidateVersion(definition.id, version.id)).toBe(true);
    const checked = definitionById(definition.id)!.versions.find((item) => item.id === version.id)!;
    expect(checked.snapshot).toEqual(before);
    expect(checked.validation).toMatchObject({ status: "通过", issues: [] });
    expect(checked.validation.checkedAt).not.toBe("权限组修复前");
    expect(store.publishVersion(definition.id, version.id, "权限组修复后重新发布")).toBe(true);
  });

  it("切换、取消发布和再次发布保留首次发布信息，并为留空原因提供默认值", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const source = definitionModule.getPublishedVersion(definition)!;
    const draftId = store.createVersion(definition.id, source.id)!;
    replaceDefinition(definition.id, (current) => ({
      ...current,
      versions: current.versions.map((version) => version.id === draftId ? { ...version, changeNote: "" } : version),
    }));

    expect(store.unpublishVersion(definition.id, "pdf-v1", "不是当前版本")).toBe("not-published");
    expect(store.switchPublishedVersion(definition.id, draftId)).toBe(true);
    const firstPublished = definitionById(definition.id)!.versions.find((version) => version.id === draftId)!;
    expect(firstPublished.changeNote).toBe("切换为发布版本");
    expect(firstPublished.firstPublishedAt).toBeTruthy();
    expect(firstPublished.firstPublishedBy).toBe("超级管理员");
    replaceDefinition(definition.id, (current) => ({
      ...current,
      versions: current.versions.map((version) => version.id === draftId
        ? { ...version, validation: { status: "未通过", checkedAt: "过期校验时间", issues: ["过期校验结果"] } }
        : version),
    }));

    expect(store.unpublishVersion(definition.id, draftId, "   ")).toBe("unpublished");
    const unpublished = definitionById(definition.id)!.versions.find((version) => version.id === draftId)!;
    expect(unpublished.validation.status).toBe("通过");
    expect(unpublished.validation.issues).toEqual([]);
    expect(unpublished.validation.checkedAt).not.toBe("过期校验时间");
    expect(unpublished.lastUnpublishReason).toBe("未填写原因");
    expect(unpublished.lastUnpublishedBy).toBe("超级管理员");
    expect(store.switchPublishedVersion(definition.id, draftId)).toBe(true);
    const republished = definitionById(definition.id)!.versions.find((version) => version.id === draftId)!;
    expect(republished.firstPublishedAt).toBe(firstPublished.firstPublishedAt);
    expect(republished.firstPublishedBy).toBe(firstPublished.firstPublishedBy);
  });

  it("停用流程取消发布后仍保持停用且没有发布版本", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    store.toggleDefinition("pdf-review");
    expect(definitionById("pdf-review")).toMatchObject({ disabled: true, publishedVersionId: "pdf-v3" });

    expect(store.unpublishVersion("pdf-review", "pdf-v3", "维护期间取消发布")).toBe("unpublished");
    expect(definitionById("pdf-review")).toMatchObject({ disabled: true, publishedVersionId: undefined });
    expect(definitionModule.definitionStatus(definitionById("pdf-review")!)).toBe("已停用");
  });

  it("发布指针悬空时取消发布返回 not-found 且不篡改定义", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    replaceDefinition("test-report-review", (definition) => ({ ...definition, publishedVersionId: "ghost-version" }));
    const before = structuredClone(definitionById("test-report-review")!);

    expect(store.unpublishVersion("test-report-review", "ghost-version", "无目标")).toBe("not-found");
    expect(definitionById("test-report-review")).toEqual(before);
  });

  it("只有已发布定义可停用和启用，未发布定义保持原状", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    expect(definitionById("pdf-review")?.disabled).toBe(false);
    store.toggleDefinition("pdf-review");
    expect(definitionById("pdf-review")?.disabled).toBe(true);
    store.toggleDefinition("pdf-review");
    expect(definitionById("pdf-review")?.disabled).toBe(false);

    const unpublishedBefore = structuredClone(definitionById("test-report-review")!);
    store.toggleDefinition("test-report-review");
    expect(definitionById("test-report-review")).toEqual(unpublishedBefore);
  });

  it("实例引用阻止版本和定义删除；解除引用后可删除版本、定义及设计器草稿", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definitionId = store.createDefinition({ name: "引用保护流程", type: "free" });
    const versionId = definitionById(definitionId)!.versions[0].id;
    store.synchronizeInstanceCounts([{ definitionId, versionId }]);

    expect(definitionById(definitionId)).toMatchObject({ instanceCount: 1 });
    expect(definitionById(definitionId)?.versions[0].instanceCount).toBe(1);
    expect(store.deleteVersion(definitionId, versionId)).toBe("has-instances");
    expect(store.deleteDefinition(definitionId)).toBe(false);
    replaceDefinition(definitionId, (definition) => ({ ...definition, instanceCount: 0 }));
    expect(store.deleteDefinition(definitionId)).toBe(false);

    store.synchronizeInstanceCounts([]);
    const stableState = definitionModule.useProcessDefinitionStore.getState();
    store.synchronizeInstanceCounts([]);
    expect(definitionModule.useProcessDefinitionStore.getState()).toBe(stableState);

    const secondVersionId = store.createVersion(definitionId, versionId)!;
    storage.setItem(`flowpilot-form-designer-draft-v2-${definitionId}`, "form");
    storage.setItem(`flowpilot-flow-designer-v2-${definitionId}`, "flow");
    storage.setItem(`flowpilot-system-list-fields-v1:${definitionId}`, "columns");
    expect(store.deleteVersion(definitionId, secondVersionId)).toBe("deleted");
    expect(storage.getItem(`flowpilot-form-designer-draft-v2-${definitionId}`)).toBe("form");
    expect(store.deleteDefinition(definitionId)).toBe(true);
    expect(definitionById(definitionId)).toBeUndefined();
    expect(storage.getItem(`flowpilot-form-designer-draft-v2-${definitionId}`)).toBeNull();
    expect(storage.getItem(`flowpilot-flow-designer-v2-${definitionId}`)).toBeNull();
    expect(storage.getItem(`flowpilot-system-list-fields-v1:${definitionId}`)).toBeNull();
  });

  it("删除唯一未引用版本会一并删除定义，而发布定义始终受保护", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    expect(store.deleteDefinition("pdf-review")).toBe(false);
    expect(store.deleteVersion("pdf-review", "pdf-v3")).toBe("published");

    const disposableId = store.createDefinition({ name: "一次性流程", type: "free" });
    const disposableVersionId = definitionById(disposableId)!.versions[0].id;
    expect(store.deleteVersion(disposableId, disposableVersionId)).toBe("definition-deleted");
    expect(definitionById(disposableId)).toBeUndefined();
  });
});

describe("流程定义 v18 旧数据迁移", () => {
  it("缺少 definitions 的旧状态回退为完整内置定义", async () => {
    storage.setItem("flowpilot-process-definitions-v1", JSON.stringify({ state: {}, version: 0 }));
    await definitionModule.useProcessDefinitionStore.persist.rehydrate();

    expect(definitionModule.useProcessDefinitionStore.getState().definitions.map((definition) => definition.id)).toEqual([
      "pdf-review",
      "test-report-review",
      "free-collaboration",
      "supplier-change-review",
    ]);
  });

  it("迁移时重新计算已取消发布版本的过期校验结果", async () => {
    const legacy = structuredClone(definitionById("pdf-review")!);
    legacy.publishedVersionId = undefined;
    legacy.versions = legacy.versions.map((version) => version.id === "pdf-v3"
      ? { ...version, validation: { status: "未通过", checkedAt: "过期校验时间", issues: ["过期校验结果"] } }
      : version);
    const legacyVersion = legacy.versions.find((version) => version.id === "pdf-v3")!;
    delete legacyVersion.snapshot.flow.savedAt;
    storage.setItem("flowpilot-process-definitions-v1", JSON.stringify({ state: { definitions: [legacy] }, version: 16 }));

    await definitionModule.useProcessDefinitionStore.persist.rehydrate();

    const migrated = definitionById("pdf-review")!;
    const version = migrated.versions.find((item) => item.id === "pdf-v3")!;
    expect(migrated.publishedVersionId).toBeUndefined();
    expect(version.validation).toMatchObject({ status: "通过", issues: [] });
    expect(version.validation.checkedAt).not.toBe("过期校验时间");
    expect(version.snapshot.flow.savedAt).toBe(version.updatedAt);
    expect(definitionModule.getVersionStatus(migrated, version.id)).toBe("可发布");
  });

  it("迁移旧单值权限字段、撤回草稿、悬空发布指针并修复内置历史版本", async () => {
    const pdfVersion = definitionModule.getPublishedVersion(definitionById("pdf-review"))!;
    const testDefinition = definitionById("test-report-review")!;
    const testV1 = testDefinition.versions.find((version) => version.version === "V1")!;
    const testV2 = testDefinition.versions.find((version) => version.version === "V2")!;
    const legacyBasic = {
      name: "旧审批流程",
      code: "LEGACY-001",
      type: "approval",
      description: "旧字段迁移",
      starterGroup: "PDF审核_文控_流程权限组",
      closerGroups: ["PDF审核_文控_流程权限组"],
      assigneeGroup: "PDF审核_研发_流程权限组",
      visibleRoles: ["流程管理员", "ROLE-005", "不存在角色"],
      visibleUsers: ["linxiao", "wangmin"],
    };
    const rawVersion = (version: ProcessVersion, overrides: Record<string, unknown> = {}) => ({
      id: version.id,
      version: version.version.toLowerCase(),
      basic: structuredClone(version.basic),
      snapshot: structuredClone(version.snapshot),
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      publishedAt: version.publishedAt,
      changeNote: version.changeNote,
      instanceCount: version.instanceCount,
      ...overrides,
    });
    const brokenTestV2Snapshot = structuredClone(testV2.snapshot);
    brokenTestV2Snapshot.flow.nodes = [];
    brokenTestV2Snapshot.flow.edges = [];
    const extraV9 = rawVersion(testV1, { id: "legacy-test-v9", version: "v9", instanceCount: 0 });

    storage.setItem("flowpilot-process-definitions-v1", JSON.stringify({
      version: 4,
      state: {
        definitions: [
          {
            id: "legacy-custom",
            name: "旧名称",
            description: "旧说明",
            type: "approval",
            disabled: true,
            effectiveVersionId: "legacy-v1",
            versions: [
              {
                id: "legacy-v1",
                version: "v1",
                basic: legacyBasic,
                snapshot: structuredClone(pdfVersion.snapshot),
                publishedAt: "2025-01-02 03:04",
                createdBy: "旧管理员",
                instanceCount: 2,
              },
              {
                id: "legacy-v2",
                version: "v2",
                basic: {
                  ...legacyBasic,
                  starterGroups: ["PDF审核_文控_流程权限组"],
                  closeGroups: ["PDF审核_文控_流程权限组"],
                  assigneeGroups: ["PDF审核_研发_流程权限组"],
                },
                snapshot: structuredClone(pdfVersion.snapshot),
                firstPublishedAt: "2025-02-01 09:00",
                lastWithdrawnAt: "2025-02-02 09:00",
                lastWithdrawnBy: "旧管理员",
                instanceCount: 3,
              },
            ],
            draft: {
              id: "legacy-v1-draft",
              withdrawnVersionId: "legacy-v1",
              version: "v1",
              updatedAt: "2025-03-01 09:00",
              basic: { ...legacyBasic, closerGroups: undefined },
              snapshot: structuredClone(pdfVersion.snapshot),
            },
          },
          {
            id: "test-report-review",
            code: "PROC-TR-002",
            name: "损坏的测试报告",
            type: "approval",
            nextVersionNumber: 1,
            instanceCount: 0,
            versions: [
              rawVersion(testV2, { id: "legacy-test-v2", snapshot: brokenTestV2Snapshot, instanceCount: 0 }),
              rawVersion(testV1, { id: "legacy-test-v1", instanceCount: 0 }),
              extraV9,
            ],
          },
          {
            id: "pdf-review",
            name: "缺失版本 PDF",
            type: "approval",
            disabled: true,
            effectiveVersionId: "pdf-v3",
            versions: "not-an-array",
          },
          {
            id: "empty-custom",
            disabled: true,
            publishedVersionId: "ghost-version",
            versions: [],
          },
        ],
      },
    }));

    await definitionModule.useProcessDefinitionStore.persist.rehydrate();

    const migrated = definitionModule.useProcessDefinitionStore.getState().definitions;
    const custom = migrated.find((definition) => definition.id === "legacy-custom")!;
    expect(custom).toMatchObject({
      code: "LEGACY-001",
      name: "旧名称",
      description: "旧说明",
      disabled: true,
      publishedVersionId: undefined,
      nextVersionNumber: 3,
      instanceCount: 5,
    });
    expect(custom.versions.map((version) => version.version)).toEqual(["V1", "V2"]);
    expect(custom.versions[0]).toMatchObject({
      id: "legacy-v1",
      instanceCount: 2,
      firstPublishedAt: "2025-01-02 03:04",
      firstPublishedBy: "旧管理员",
      publishedAt: "2025-01-02 03:04",
    });
    expect(custom.versions[0].basic).toMatchObject({
      starterGroups: ["PDF审核_文控_流程权限组"],
      closeGroups: ["PDF审核_文控_流程权限组"],
      assigneeGroups: ["PDF审核_研发_流程权限组"],
      visibleRoles: ["ROLE-002", "ROLE-005"],
      visibleUsers: ["lina", "wangmin"],
    });
    expect(custom.versions[1]).toMatchObject({
      lastUnpublishedAt: "2025-02-02 09:00",
      lastUnpublishedBy: "旧管理员",
    });

    const repaired = migrated.find((definition) => definition.id === "test-report-review")!;
    expect(repaired.versions.map((version) => version.version)).toEqual(["V2", "V1", "V9"]);
    expect(repaired.versions[0].id).toBe("test-report-v2");
    expect(repaired.versions[1].id).toBe("legacy-test-v1");
    expect(repaired.versions[1].instanceCount).toBeGreaterThanOrEqual(1);
    expect(repaired.nextVersionNumber).toBe(10);
    expect(repaired.instanceCount).toBe(2);

    const repairedPdf = migrated.find((definition) => definition.id === "pdf-review")!;
    expect(repairedPdf.versions).toHaveLength(3);
    expect(repairedPdf.publishedVersionId).toBe("pdf-v3");
    expect(repairedPdf.disabled).toBe(true);

    const empty = migrated.find((definition) => definition.id === "empty-custom")!;
    expect(empty).toMatchObject({
      code: "PROC-UNKNOWN",
      name: "未命名流程",
      description: "",
      type: "approval",
      disabled: true,
      publishedVersionId: undefined,
      nextVersionNumber: 1,
      instanceCount: 0,
      versions: [],
    });
  });
});
