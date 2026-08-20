import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
let definitionModule: typeof import("./useProcessDefinitionStore");
let prototypeModule: typeof import("./usePrototypeStore");
let identityModule: typeof import("./useIdentityStore");
let transferModule: typeof import("../utils/processDefinitionTransfer");

const setActor = (personaId: string) => {
  prototypeModule.usePrototypeStore.setState({ personaId, authenticated: true });
  storage.setItem("flowpilot-prototype-v5", JSON.stringify({ state: { personaId } }));
};

const definitionById = (definitionId: string) =>
  definitionModule.useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);

const instanceById = (instanceId: string) =>
  prototypeModule.usePrototypeStore.getState().instances.find((item) => item.id === instanceId);

beforeAll(async () => {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  definitionModule = await import("./useProcessDefinitionStore");
  prototypeModule = await import("./usePrototypeStore");
  identityModule = await import("./useIdentityStore");
  transferModule = await import("../utils/processDefinitionTransfer");
});

beforeEach(() => {
  storage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  prototypeModule.usePrototypeStore.getState().resetDemo();
  setActor("superadmin");
});

describe("流程定义完整生命周期", () => {
  it("创建全新定义时生成独立 V1，且不会继承示例配置", () => {
    const definitionId = definitionModule.useProcessDefinitionStore.getState().createDefinition({
      name: "固件发布单",
      type: "approval",
      description: "集成测试流程",
    });

    const definition = definitionById(definitionId);
    expect(definition).toMatchObject({ name: "固件发布单", type: "approval", nextVersionNumber: 2 });
    expect(definition?.publishedVersionId).toBeUndefined();
    expect(definition?.versions).toHaveLength(1);
    expect(definition?.versions[0]).toMatchObject({ version: "V1", instanceCount: 0 });
    expect(definition?.versions[0].snapshot.form.fields.map((field) => field.id)).toEqual(["title"]);
    expect(definition?.versions[0].snapshot.flow.nodes).toEqual([]);
    expect(definition?.versions[0].validation.status).toBe("未通过");
  });

  it("连续创建流程定义时始终生成不同的稳定标识", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_788_000_000_000);
    const firstId = definitionModule.useProcessDefinitionStore.getState().createDefinition({ name: "流程 A", type: "approval" });
    const secondId = definitionModule.useProcessDefinitionStore.getState().createDefinition({ name: "流程 B", type: "approval" });
    now.mockRestore();

    expect(firstId).not.toBe(secondId);
    expect(definitionById(firstId)?.name).toBe("流程 A");
    expect(definitionById(secondId)?.name).toBe("流程 B");
  });

  it("可保存完整配置、发布、复制新版本并原子切换发布版本", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const source = definitionById("pdf-review")!;
    const sourceVersion = definitionModule.getPublishedVersion(source)!;
    const definitionId = store.createDefinition({ name: "固件发布单", type: "approval" });
    const firstVersion = definitionById(definitionId)!.versions[0];
    const firstBasic = {
      ...firstVersion.basic,
      name: "固件发布单",
      instancePrefix: "FW_",
      starterGroups: [...sourceVersion.basic.starterGroups],
      closeGroups: [...sourceVersion.basic.closeGroups],
    };

    expect(store.updateVersionBasic(definitionId, firstVersion.id, firstBasic)).toBe(true);
    expect(store.updateVersionFormSnapshot(definitionId, firstVersion.id, sourceVersion.snapshot.form, sourceVersion.snapshot.systemFields)).toBe(true);
    expect(store.updateVersionFlowSnapshot(definitionId, firstVersion.id, sourceVersion.snapshot.flow)).toBe(true);
    expect(definitionById(definitionId)?.versions[0].validation.status).toBe("通过");
    expect(store.publishVersion(definitionId, firstVersion.id, "首次发布")).toBe(true);
    expect(definitionById(definitionId)?.publishedVersionId).toBe(firstVersion.id);
    expect(store.updateVersionBasic(definitionId, firstVersion.id, { ...firstBasic, name: "不应生效" })).toBe(false);

    const secondVersionId = store.createVersion(definitionId, firstVersion.id)!;
    const secondVersion = definitionById(definitionId)!.versions.find((item) => item.id === secondVersionId)!;
    expect(secondVersion.version).toBe("V2");
    expect(secondVersion.basedOn).toBe("V1");
    expect(secondVersion.snapshot).toEqual(sourceVersion.snapshot);
    expect(secondVersion.snapshot).not.toBe(sourceVersion.snapshot);
    expect(store.updateVersionBasic(definitionId, secondVersionId, { ...secondVersion.basic, name: "固件发布单新版" })).toBe(true);
    expect(store.publishVersion(definitionId, secondVersionId, "切换版本")).toBe(true);

    const switched = definitionById(definitionId)!;
    expect(switched.publishedVersionId).toBe(secondVersionId);
    expect(switched.name).toBe("固件发布单新版");
    expect(definitionModule.getVersionStatus(switched, firstVersion.id)).toBe("可发布");
    expect(definitionModule.getVersionStatus(switched, secondVersionId)).toBe("已发布");
  });

  it("复制新流程使用完整独立快照，不会直接发布", () => {
    const source = definitionById("pdf-review")!;
    const sourceVersion = definitionModule.getPublishedVersion(source)!;
    const copiedId = definitionModule.useProcessDefinitionStore.getState().copyDefinition(source.id)!;
    const copied = definitionById(copiedId)!;

    expect(copied).toMatchObject({ type: source.type, nextVersionNumber: 2 });
    expect(copied.publishedVersionId).toBeUndefined();
    expect(copied.name).toBe(`${sourceVersion.basic.name}（副本）`);
    expect(copied.versions[0].version).toBe("V1");
    expect(copied.versions[0].basedOn).toBe(`${source.code} / ${sourceVersion.version}`);
    expect(copied.versions[0].snapshot).toEqual(sourceVersion.snapshot);
    expect(copied.versions[0].snapshot).not.toBe(sourceVersion.snapshot);
  });

  it("流程定义使用显示文本导出并按同名主数据安全导入", () => {
    const source = definitionById("pdf-review")!;
    const identities = identityModule.useIdentityStore.getState();
    const exported = transferModule.createProcessDefinitionExport(source, identities);
    const json = JSON.stringify(exported, null, 2);

    expect(json).toContain('"文件类型": "FlowPilot 流程定义"');
    expect(json).toContain('"流程名称": "PDF 文件审核"');
    expect(json).not.toContain("pdf-v3");
    expect(json).not.toContain('"id"');
    expect(json).not.toContain('"code"');

    const preview = transferModule.parseProcessDefinitionImport(json, identities);
    expect(preview.warnings).toEqual([]);
    expect(preview.definition.versions).toHaveLength(source.versions.length);
    const importedId = definitionModule.useProcessDefinitionStore.getState().importDefinition(preview.definition)!;
    const imported = definitionById(importedId)!;

    expect(imported.name).toBe("PDF 文件审核（导入）");
    expect(imported.publishedVersionId).toBeUndefined();
    expect(imported.instanceCount).toBe(0);
    expect(imported.versions).toHaveLength(source.versions.length);
    expect(imported.versions.every((version) => version.instanceCount === 0)).toBe(true);
    const sharedFieldIds = imported.versions.map((version) =>
      version.snapshot.form.fields.find((field) => field.label === "历史字段 2")?.id,
    );
    expect(sharedFieldIds.every(Boolean)).toBe(true);
    expect(new Set(sharedFieldIds).size).toBe(1);
    expect(imported.versions[0].basic.visibleRoles).toEqual(source.versions[0].basic.visibleRoles);
  });

  it("发布、实例引用和删除保护符合版本规则", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const disposableId = store.createDefinition({ name: "待删除流程", type: "free" });
    const disposableVersionId = definitionById(disposableId)!.versions[0].id;
    expect(store.deleteVersion(disposableId, disposableVersionId)).toBe("definition-deleted");
    expect(definitionById(disposableId)).toBeUndefined();

    const source = definitionById("pdf-review")!;
    const publishedVersion = definitionModule.getPublishedVersion(source)!;
    expect(store.deleteVersion(source.id, publishedVersion.id)).toBe("published");
    expect(store.unpublishVersion(source.id, publishedVersion.id, "测试取消发布")).toBe("unpublished");
    expect(store.deleteVersion(source.id, publishedVersion.id)).toBe("has-instances");
    expect(store.deleteDefinition(source.id)).toBe(false);

    const invalidId = store.createDefinition({ name: "未配置流程", type: "approval" });
    const invalidVersionId = definitionById(invalidId)!.versions[0].id;
    expect(store.publishVersion(invalidId, invalidVersionId, "不应发布")).toBe(false);
    expect(definitionById(invalidId)?.publishedVersionId).toBeUndefined();
  });

  it("没有流程配置权限的用户不能创建、复制或发布", () => {
    setActor("hejing");
    const store = definitionModule.useProcessDefinitionStore.getState();
    expect(store.createDefinition({ name: "越权流程", type: "approval" })).toBe("");
    expect(store.copyDefinition("pdf-review")).toBeNull();
    expect(store.publishVersion("pdf-review", "pdf-v3", "越权发布")).toBe(false);
  });
});

describe("固定审批流程完整生命周期", () => {
  it("旧演示实例会按锁定版本统一审核记录与待办节点标识", () => {
    const instance = instanceById("proc-42")!;
    const version = definitionById("pdf-review")?.versions.find((item) => item.id === instance.versionId)!;
    const approvalNodeIds = version.snapshot.flow.nodes
      .filter((node) => node.data?.kind === "approval")
      .map((node) => node.id);
    const qaNode = version.snapshot.flow.nodes.find((node) => node.data?.permissionGroup === "PDF审核_质量_流程权限组")!;
    const qaTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) =>
      task.instanceId === instance.id && task.nodeId === qaNode.id && task.status === "待处理",
    )!;

    expect(instance.reviewers.map((reviewer) => reviewer.key)).toEqual(approvalNodeIds);
    expect(qaTask).toMatchObject({ permissionGroupId: "PDF审核_质量_流程权限组", defaultAssigneeId: "lina" });
    setActor("lina");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instance.id, "pass", "质量审核通过", undefined, undefined, qaTask.id)).toBe(true);
    expect(instanceById(instance.id)?.reviewers.find((reviewer) => reviewer.key === qaNode.id)).toMatchObject({
      status: "已通过",
      name: "林晓",
    });
  });

  it("旧持久化数据迁移时同步修复审核记录、待办和默认责任人", () => {
    const current = instanceById("proc-42")!;
    const legacyKeyByGroup = new Map([
      ["PDF审核_研发_流程权限组", "rd"],
      ["PDF审核_质量_流程权限组", "qa"],
      ["PDF审核_生产_流程权限组", "production"],
    ]);
    const legacy = {
      ...structuredClone(current),
      reviewers: current.reviewers.map((reviewer) => ({
        ...reviewer,
        key: legacyKeyByGroup.get(reviewer.group) ?? reviewer.key,
      })),
    };
    const qualityTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) =>
      task.instanceId === current.id && task.permissionGroupId === "PDF审核_质量_流程权限组",
    )!;
    const migrated = prototypeModule.normalizePrototypeRuntimeData([legacy], [{
      ...qualityTask,
      nodeId: "qa",
      nodeName: "质量审核",
      defaultAssigneeId: "current-user",
    }]);
    const version = definitionById("pdf-review")?.versions.find((item) => item.id === current.versionId)!;
    const qaNode = version.snapshot.flow.nodes.find((node) => node.data?.permissionGroup === "PDF审核_质量_流程权限组")!;

    expect(migrated.instances[0].reviewers.some((reviewer) => reviewer.key === "qa")).toBe(false);
    expect(migrated.instances[0].reviewers.some((reviewer) => reviewer.key === qaNode.id)).toBe(true);
    expect(migrated.tasks.find((task) => task.nodeId === qaNode.id)).toMatchObject({
      permissionGroupId: "PDF审核_质量_流程权限组",
      defaultAssigneeId: "lina",
    });
  });

  it("无当前发布版本的历史测试报告仍能按锁定的完整版本处理待办", () => {
    const definition = definitionById("test-report-review")!;
    const instance = instanceById("report-12")!;
    const lockedVersion = definition.versions.find((version) => version.id === instance.versionId)!;
    const rdNode = lockedVersion.snapshot.flow.nodes.find((node) => node.data?.permissionGroup === "测试报告_研发_流程权限组")!;
    const rdTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) =>
      task.instanceId === instance.id && task.nodeId === rdNode.id && task.status === "待处理",
    )!;

    expect(definition.publishedVersionId).toBeUndefined();
    expect(lockedVersion.version).toBe("V2");
    expect(instance.reviewers.map((reviewer) => reviewer.key)).toEqual(
      lockedVersion.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval").map((node) => node.id),
    );
    setActor("zhangwei");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instance.id, "pass", "研发审核通过", undefined, undefined, rdTask.id)).toBe(true);
    expect(instanceById(instance.id)?.status).toBe("已完成");
  });

  it("审核节点开启重复修改后可再次替换单文件附件", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const source = definitionModule.getPublishedVersion(definition)!;
    const versionId = store.createVersion(definition.id, source.id)!;
    const form = structuredClone(source.snapshot.form);
    const attachment = {
      id: "review-attachment",
      type: "attachment" as const,
      label: "测试附件",
      required: false,
      inputStage: "reviewer" as const,
      attachment: {
        inlinePdf: false,
        maxCount: 1,
        maxSizeMb: 100,
        allowedExtensions: ["pdf"],
        excelToPdf: false,
        maxPreviewPages: 1,
      },
    };
    form.fields.push(attachment);
    const flow = structuredClone(source.snapshot.flow);
    const reviewNode = flow.nodes.find((node) => node.data?.permissionGroup?.includes("研发"))!;
    reviewNode.data = {
      ...reviewNode.data,
      editableFields: [attachment.id],
      allowRepeatedEditing: true,
    };
    flow.nodes.filter((node) => node.id !== reviewNode.id && node.data?.kind === "approval").forEach((node) => {
      node.data = { ...node.data, editableFields: [], allowRepeatedEditing: false };
    });

    expect(store.updateVersionFormSnapshot(definition.id, versionId, form, source.snapshot.systemFields)).toBe(true);
    expect(store.updateVersionFlowSnapshot(definition.id, versionId, flow)).toBe(true);
    expect(store.publishVersion(definition.id, versionId, "重复修改附件测试")).toBe(true);

    setActor("wangmin");
    const instanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: definition.id,
      formValues: { title: "ADT 测试报告", [attachment.id]: [] },
    })!;
    const task = prototypeModule.usePrototypeStore.getState().tasks.find((item) =>
      item.instanceId === instanceId && item.nodeId === reviewNode.id,
    )!;
    setActor("zhangwei");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "首次上传", undefined, {
      title: "ADT 测试报告",
      [attachment.id]: [{ id: "attachment-v1", name: "ADT-v1.pdf" }],
    }, task.id)).toBe(true);
    expect(prototypeModule.usePrototypeStore.getState().reviseCompletedTask(instanceId, task.id, {
      title: "ADT 测试报告",
      [attachment.id]: [{ id: "attachment-v2", name: "ADT-v2.pdf" }],
    }, "替换附件")).toBe("updated");
    expect(instanceById(instanceId)?.formValues?.[attachment.id]).toEqual([{ id: "attachment-v2", name: "ADT-v2.pdf" }]);
  });

  it("创建、发起前修改、权限校验、通过、驳回、重新提交和完成形成一致链路", () => {
    const definitionBefore = definitionById("pdf-review")!;
    const version = definitionModule.getPublishedVersion(definitionBefore)!;
    const previousCount = version.instanceCount;
    setActor("wangmin");
    const instanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: definitionBefore.id,
      formValues: { title: "生命周期测试文件" },
    })!;

    expect(instanceId).toBeTruthy();
    expect(instanceById(instanceId)).toMatchObject({ status: "审核中", round: 1, versionId: version.id, title: "生命周期测试文件" });
    expect(definitionById("pdf-review")?.versions.find((item) => item.id === version.id)?.instanceCount).toBe(previousCount + 1);
    expect(prototypeModule.usePrototypeStore.getState().tasks.filter((task) => task.instanceId === instanceId && task.status === "待处理")).toHaveLength(3);

    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance(instanceId, {
      title: "审核前已修改",
      formValues: { title: "审核前已修改" },
    })).toEqual({ ok: true });
    expect(instanceById(instanceId)?.title).toBe("审核前已修改");

    setActor("liufang");
    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance(instanceId, { title: "越权修改" })).toMatchObject({ ok: false, reason: "forbidden" });
    setActor("hejing");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "越权审核")).toBe(false);

    const rdTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.instanceId === instanceId && task.permissionGroupId.includes("研发"))!;
    setActor("zhangwei");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "confirm", "错误处理方式", undefined, undefined, rdTask.id)).toBe(false);
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "研发通过", undefined, undefined, rdTask.id)).toBe(true);

    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance(instanceId, { title: "审核后不应修改" })).toMatchObject({ ok: false, reason: "locked" });

    const qaTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.instanceId === instanceId && task.permissionGroupId.includes("质量") && task.status === "待处理")!;
    setActor("lina");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "reject", "", undefined, undefined, qaTask.id)).toBe(false);
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "reject", "质量数据不完整", undefined, undefined, qaTask.id)).toBe(true);
    expect(instanceById(instanceId)?.status).toBe("驳回待处理");
    expect(prototypeModule.usePrototypeStore.getState().tasks.filter((task) => task.instanceId === instanceId && task.status === "已取消")).toHaveLength(1);

    setActor("liufang");
    expect(prototypeModule.usePrototypeStore.getState().republishInstance(instanceId, { title: "非创建人重提" })).toMatchObject({ ok: false, reason: "forbidden" });
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().republishInstance(instanceId, {
      title: "修订后重新提交",
      formValues: { title: "修订后重新提交" },
    })).toEqual({ ok: true });
    expect(instanceById(instanceId)).toMatchObject({ status: "审核中", round: 2, title: "修订后重新提交" });
    expect(instanceById(instanceId)?.resubmissions).toEqual([
      expect.objectContaining({
        round: 2,
        submittedById: "wangmin",
        submittedByName: "王敏",
        modifiedFields: [{ fieldId: "title", label: "标题" }],
      }),
    ]);

    setActor("superadmin");
    const secondRoundTaskIds = prototypeModule.usePrototypeStore.getState().tasks
      .filter((task) => task.instanceId === instanceId && task.round === 2 && task.status === "待处理")
      .map((task) => task.id);
    expect(secondRoundTaskIds).toHaveLength(3);
    secondRoundTaskIds.forEach((taskId) => {
      expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "通过", undefined, undefined, taskId)).toBe(true);
    });
    expect(instanceById(instanceId)?.status).toBe("已完成");

    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().closeInstance(instanceId, "流程结束后关闭")).toEqual({ ok: true });
    expect(instanceById(instanceId)?.status).toBe("已关闭");
  });

  it("停用或取消发布后禁止创建新实例，已有实例仍锁定原版本", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const originalVersion = definitionModule.getPublishedVersion(definitionById("pdf-review"))!;
    setActor("wangmin");
    const existingId = prototypeModule.usePrototypeStore.getState().createProcessInstance({ definitionId: "pdf-review", formValues: { title: "版本锁定测试" } })!;
    expect(instanceById(existingId)?.versionId).toBe(originalVersion.id);

    setActor("superadmin");
    store.toggleDefinition("pdf-review");
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({ definitionId: "pdf-review", formValues: { title: "停用时禁止" } })).toBeNull();

    setActor("superadmin");
    store.toggleDefinition("pdf-review");
    expect(store.unpublishVersion("pdf-review", originalVersion.id, "测试无发布版本")).toBe("unpublished");
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({ definitionId: "pdf-review", formValues: { title: "未发布时禁止" } })).toBeNull();
    expect(instanceById(existingId)?.versionId).toBe(originalVersion.id);
  });

  it("自动关闭和仅重新提交两种驳回规则均按版本快照执行", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const source = definitionModule.getPublishedVersion(definition)!;
    const autoCloseVersionId = store.createVersion(definition.id, source.id)!;
    expect(store.updateVersionFlowSnapshot(definition.id, autoCloseVersionId, {
      ...structuredClone(source.snapshot.flow),
      meta: { rejectionHandling: "auto-close" },
    })).toBe(true);
    expect(store.publishVersion(definition.id, autoCloseVersionId, "自动关闭测试")).toBe(true);

    setActor("wangmin");
    const autoCloseInstanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({ definitionId: definition.id, formValues: { title: "自动关闭实例" } })!;
    setActor("superadmin");
    const autoCloseTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.instanceId === autoCloseInstanceId && task.status === "待处理")!;
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(autoCloseInstanceId, "reject", "自动关闭", undefined, undefined, autoCloseTask.id)).toBe(true);
    expect(instanceById(autoCloseInstanceId)?.status).toBe("已关闭");
    expect(prototypeModule.usePrototypeStore.getState().tasks.filter((task) => task.instanceId === autoCloseInstanceId && (task.status === "待处理" || task.status === "未激活"))).toHaveLength(0);

    const resubmitOnlyVersionId = store.createVersion(definition.id, source.id)!;
    expect(store.updateVersionFlowSnapshot(definition.id, resubmitOnlyVersionId, {
      ...structuredClone(source.snapshot.flow),
      meta: { rejectionHandling: "resubmit-only" },
    })).toBe(true);
    expect(store.publishVersion(definition.id, resubmitOnlyVersionId, "仅重新提交测试")).toBe(true);
    setActor("wangmin");
    const resubmitOnlyInstanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({ definitionId: definition.id, formValues: { title: "仅重新提交实例" } })!;
    setActor("superadmin");
    const resubmitOnlyTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.instanceId === resubmitOnlyInstanceId && task.status === "待处理")!;
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(resubmitOnlyInstanceId, "reject", "需要修订", undefined, undefined, resubmitOnlyTask.id)).toBe(true);
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().closeInstance(resubmitOnlyInstanceId, "尝试关闭")).toMatchObject({ ok: false, reason: "invalid-state" });
  });

  it("确认节点和条件跳过节点使用各自固定语义完成流程", () => {
    const store = definitionModule.useProcessDefinitionStore.getState();
    const definition = definitionById("pdf-review")!;
    const source = definitionModule.getPublishedVersion(definition)!;
    const versionId = store.createVersion(definition.id, source.id)!;
    const flow = structuredClone(source.snapshot.flow);
    const approvalNodes = flow.nodes.filter((node) => node.data?.kind === "approval");
    approvalNodes[0].data = { ...approvalNodes[0].data, handlingMode: "confirmation" };
    approvalNodes[2].data = {
      ...approvalNodes[2].data,
      activationCondition: {
        mode: "all",
        rules: [{ id: "condition-production", fieldId: "title", operator: "eq", value: "需要生产审核" }],
      },
    };
    expect(store.updateVersionFlowSnapshot(definition.id, versionId, flow)).toBe(true);
    expect(store.publishVersion(definition.id, versionId, "条件与确认测试")).toBe(true);

    setActor("superadmin");
    const instanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: definition.id,
      formValues: { title: "无需生产审核" },
    })!;
    const runtimeTasks = prototypeModule.usePrototypeStore.getState().tasks.filter((task) => task.instanceId === instanceId);
    expect(runtimeTasks.filter((task) => task.status === "已跳过")).toHaveLength(1);
    const confirmationTask = runtimeTasks.find((task) => task.nodeId === approvalNodes[0].id)!;
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "错误动作", undefined, undefined, confirmationTask.id)).toBe(false);
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "confirm", "已确认", undefined, undefined, confirmationTask.id)).toBe(true);
    const remainingTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.instanceId === instanceId && task.status === "待处理")!;
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(instanceId, "pass", "通过", undefined, undefined, remainingTask.id)).toBe(true);
    expect(instanceById(instanceId)?.status).toBe("已完成");
  });
});

describe("自由协作流程完整生命周期", () => {
  it("支持创建、回复、转交、异常改派、关闭和填写理由后重新打开", () => {
    setActor("wangmin");
    const instanceId = prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "free-collaboration",
      firstAssigneeId: "zhangwei",
      formValues: { title: "现场异常协作", initialContent: "请研发先分析" },
    })!;
    expect(instanceById(instanceId)).toMatchObject({ workflowType: "free", status: "进行中", currentAssigneeId: "zhangwei" });

    const initialTimelineLength = instanceById(instanceId)?.freeTimeline?.length ?? 0;
    setActor("hejing");
    prototypeModule.usePrototypeStore.getState().replyFreeFlow(instanceId, "无权回复");
    expect(instanceById(instanceId)?.freeTimeline).toHaveLength(initialTimelineLength);

    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().replyFreeFlow(instanceId, "研发已完成分析");
    expect(instanceById(instanceId)?.freeTimeline).toHaveLength(initialTimelineLength + 1);
    prototypeModule.usePrototypeStore.getState().transferFreeFlow(instanceId, "请质量确认", "林晓");
    expect(instanceById(instanceId)).toMatchObject({ currentAssignee: "林晓", currentAssigneeId: "lina" });

    setActor("wangmin");
    prototypeModule.usePrototypeStore.getState().forceReassignFreeFlow(instanceId, "质量人员临时不在", "赵磊");
    expect(instanceById(instanceId)).toMatchObject({ currentAssignee: "赵磊", currentAssigneeId: "zhaolei" });
    prototypeModule.usePrototypeStore.getState().closeFreeFlow(instanceId, "问题已解决");
    expect(instanceById(instanceId)).toMatchObject({ status: "已关闭", currentAssigneeId: undefined });

    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().reopenFreeFlow(instanceId, "问题再次出现", "林晓");
    expect(instanceById(instanceId)).toMatchObject({ status: "进行中", currentAssigneeId: "lina" });
    expect(instanceById(instanceId)?.freeTimeline?.map((entry) => entry.type)).toEqual(expect.arrayContaining(["created", "reply", "assigned", "reassigned", "closed", "reopened"]));
  });
});
