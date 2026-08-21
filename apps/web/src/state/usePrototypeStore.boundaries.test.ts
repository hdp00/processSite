import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession, DirectoryUser } from "../api/contracts";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { installMemoryBrowserStorage, type MemoryStorage } from "../test/memoryStorage";

let storage: MemoryStorage;
let identityModule: typeof import("./useIdentityStore");
let definitionModule: typeof import("./useProcessDefinitionStore");
let prototypeModule: typeof import("./usePrototypeStore");

beforeAll(async () => {
  ({ localStorage: storage } = installMemoryBrowserStorage());
  identityModule = await import("./useIdentityStore");
  definitionModule = await import("./useProcessDefinitionStore");
  prototypeModule = await import("./usePrototypeStore");
});

beforeEach(() => {
  storage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  prototypeModule.usePrototypeStore.getState().resetDemo();
});

const setActor = (personaId: string) => {
  prototypeModule.usePrototypeStore.setState({
    authenticated: true,
    personaId,
    operatorUserId: personaId,
    sessionPermissions: [],
    sessionSuperAdmin: personaId === "superadmin",
    operatorSuperAdmin: personaId === "superadmin",
    impersonation: undefined,
  });
};

const instanceById = (instanceId: string) =>
  prototypeModule.usePrototypeStore.getState().instances.find((instance) => instance.id === instanceId);

const taskById = (taskId: string) =>
  prototypeModule.usePrototypeStore.getState().tasks.find((task) => task.id === taskId);

const addInstance = (instance: ProcessInstance, task?: WorkflowTask) => {
  prototypeModule.usePrototypeStore.setState((state) => ({
    instances: [instance, ...state.instances],
    tasks: task ? [task, ...state.tasks] : state.tasks,
  }));
};

const reviewScenario = (
  id: string,
  instanceChanges: Partial<ProcessInstance> = {},
  taskChanges: Partial<WorkflowTask> = {},
) => {
  const source = structuredClone(instanceById("proc-42")!);
  const sourceTask = structuredClone(prototypeModule.usePrototypeStore.getState().tasks.find((task) =>
    task.instanceId === source.id && task.permissionGroupId === "PDF审核_质量_流程权限组" && task.status === "待处理",
  )!);
  const instance = { ...source, id, ...instanceChanges };
  const task = { ...sourceTask, id: `task-${id}`, instanceId: id, ...taskChanges };
  addInstance(instance, task);
  return { instance, task };
};

const withoutPassword = (userId: string): DirectoryUser => {
  const { password: _password, ...user } = identityModule.findIdentityUser(userId)!;
  return user;
};

describe("原型会话状态边界", () => {
  it("登录、远程会话、模拟身份、切换身份和退出保持操作者语义一致", () => {
    const store = prototypeModule.usePrototypeStore.getState();
    store.logout();
    expect(prototypeModule.usePrototypeStore.getState()).toMatchObject({
      authenticated: false,
      sessionPermissions: [],
      sessionSuperAdmin: false,
      operatorSuperAdmin: false,
      impersonation: undefined,
    });

    prototypeModule.usePrototypeStore.getState().login();
    expect(prototypeModule.usePrototypeStore.getState()).toMatchObject({
      authenticated: true,
      personaId: "lina",
      operatorUserId: "lina",
      sessionSuperAdmin: false,
    });

    const session: AuthSession = {
      user: withoutPassword("lina"),
      operatorUser: withoutPassword("superadmin"),
      permissions: ["work-task:查看"],
      superAdmin: false,
      operatorSuperAdmin: true,
      impersonation: {
        id: "impersonation-1",
        operatorUserId: "superadmin",
        targetUserId: "lina",
        reason: "验证权限",
        startedAt: "2026-08-20 10:00",
        expiresAt: "2026-08-20 10:30",
      },
    };
    prototypeModule.usePrototypeStore.getState().applyAuthSession(session);
    expect(prototypeModule.usePrototypeStore.getState()).toMatchObject({
      authenticated: true,
      personaId: "lina",
      operatorUserId: "superadmin",
      sessionPermissions: ["work-task:查看"],
      sessionSuperAdmin: false,
      operatorSuperAdmin: true,
      impersonation: { targetUserId: "lina" },
    });

    prototypeModule.usePrototypeStore.getState().switchPersona("zhaolei");
    expect(prototypeModule.usePrototypeStore.getState().personaId).toBe("zhaolei");
    prototypeModule.usePrototypeStore.getState().logout();
    expect(prototypeModule.usePrototypeStore.getState()).toMatchObject({
      authenticated: false,
      personaId: "zhaolei",
      impersonation: undefined,
    });
  });
});

describe("流程创建与审核冲突边界", () => {
  it("拒绝缺失定义、无权身份、停用发起人和无效自由流受理人", () => {
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "missing-definition",
      formValues: { title: "不存在" },
    })).toBeNull();

    setActor("hejing");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "pdf-review",
      formValues: { title: "越权发起" },
    })).toBeNull();

    identityModule.useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === "wangmin"
      ? { ...user, status: "停用" }
      : user));
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "pdf-review",
      formValues: { title: "停用账号发起" },
    })).toBeNull();

    identityModule.useIdentityStore.getState().resetIdentity();
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "free-collaboration",
      formValues: { title: "缺少受理人" },
    })).toBeNull();
    expect(prototypeModule.usePrototypeStore.getState().createProcessInstance({
      definitionId: "free-collaboration",
      firstAssigneeId: "hejing",
      formValues: { title: "受理人不在权限组" },
    })).toBeNull();
  });

  it("拒绝缺失实例、缺失锁定版本、非法状态、未知操作者和缺少动作权限的审核", () => {
    setActor("superadmin");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance("missing-instance", "pass", "通过")).toBe(false);

    const broken = reviewScenario("review-broken-version", { versionId: "deleted-version" });
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      broken.instance.id,
      "pass",
      "锁定版本已经删除",
      undefined,
      undefined,
      broken.task.id,
    )).toBe(false);

    const completed = reviewScenario("review-completed-instance", { status: "已完成" });
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      completed.instance.id,
      "pass",
      "完成后重复提交",
      undefined,
      undefined,
      completed.task.id,
    )).toBe(false);

    const unknownActor = reviewScenario("review-unknown-actor");
    setActor("missing-user");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      unknownActor.instance.id,
      "pass",
      "未知用户",
      undefined,
      undefined,
      unknownActor.task.id,
    )).toBe(false);

    const noPermission = reviewScenario("review-no-permission");
    storage.setItem("flowpilot-role-permissions-v1", JSON.stringify({ "ROLE-005": ["work-task:查看"] }));
    setActor("lina");
    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      noPermission.instance.id,
      "reject",
      "权限已撤销",
      undefined,
      undefined,
      noPermission.task.id,
    )).toBe(false);
    expect(taskById(noPermission.task.id)?.status).toBe("待处理");
  });

  it("同一待办首次提交成功后拒绝重复或并发提交且不重复写入结果", () => {
    const scenario = reviewScenario("review-once");
    setActor("lina");

    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      scenario.instance.id,
      "pass",
      "首次提交",
      undefined,
      undefined,
      scenario.task.id,
    )).toBe(true);
    const firstResult = structuredClone(taskById(scenario.task.id));
    expect(firstResult).toMatchObject({ status: "已完成", action: "通过", comment: "首次提交" });

    expect(prototypeModule.usePrototypeStore.getState().reviewInstance(
      scenario.instance.id,
      "reject",
      "重复提交不应覆盖",
      undefined,
      undefined,
      scenario.task.id,
    )).toBe(false);
    expect(taskById(scenario.task.id)).toEqual(firstResult);
    expect(prototypeModule.usePrototypeStore.getState().tasks.filter((task) => task.id === scenario.task.id)).toHaveLength(1);
  });

  it("重复修改只允许原处理人或超级管理员修改已授权字段，并识别无变化提交", () => {
    expect(prototypeModule.usePrototypeStore.getState().reviseCompletedTask(
      "missing-instance",
      "missing-task",
      { title: "不存在" },
    )).toBe("forbidden");

    const instance = instanceById("proc-42")!;
    const completedTask = prototypeModule.usePrototypeStore.getState().tasks.find((task) =>
      task.instanceId === instance.id && task.status === "已完成" && task.action === "通过",
    )!;
    definitionModule.useProcessDefinitionStore.setState((state) => ({
      definitions: state.definitions.map((definition) => definition.id !== instance.definitionId
        ? definition
        : {
            ...definition,
            versions: definition.versions.map((version) => version.id !== instance.versionId
              ? version
              : {
                  ...version,
                  snapshot: {
                    ...version.snapshot,
                    flow: {
                      ...version.snapshot.flow,
                      nodes: version.snapshot.flow.nodes.map((node) => node.id !== completedTask.nodeId
                        ? node
                        : {
                            ...node,
                            data: { ...node.data, allowRepeatedEditing: true, editableFields: ["title"] },
                          }),
                    },
                  },
                }),
          }),
    }));

    setActor("superadmin");
    expect(prototypeModule.usePrototypeStore.getState().reviseCompletedTask(
      instance.id,
      completedTask.id,
      { title: instance.formValues?.title },
      "没有实际变化",
    )).toBe("no-changes");
    expect(taskById(completedTask.id)?.fieldRevisions).toBeUndefined();
  });
});

describe("实例命令失败码", () => {
  it("关闭流程区分不存在、版本丢失、权限撤销和重复关闭", () => {
    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().closeInstance("missing-instance", "关闭"))
      .toMatchObject({ ok: false, reason: "not-found" });

    const broken = { ...structuredClone(instanceById("proc-42")!), id: "close-broken", versionId: "deleted-version" };
    addInstance(broken);
    expect(prototypeModule.usePrototypeStore.getState().closeInstance(broken.id, "关闭"))
      .toMatchObject({ ok: false, reason: "version-missing" });

    setActor("lina");
    expect(prototypeModule.usePrototypeStore.getState().closeInstance("proc-42", "越权关闭"))
      .toMatchObject({ ok: false, reason: "forbidden" });

    setActor("wangmin");
    expect(prototypeModule.usePrototypeStore.getState().closeInstance("proc-25", "重复关闭"))
      .toMatchObject({ ok: false, reason: "invalid-state" });
  });

  it("审核前更新区分不存在、版本丢失和不允许修改的状态", () => {
    setActor("superadmin");
    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance("missing-instance", { title: "修改" }))
      .toMatchObject({ ok: false, reason: "not-found" });

    const broken = { ...structuredClone(instanceById("proc-42")!), id: "update-broken", versionId: "deleted-version" };
    addInstance(broken);
    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance(broken.id, { title: "修改" }))
      .toMatchObject({ ok: false, reason: "version-missing" });

    expect(prototypeModule.usePrototypeStore.getState().updateUnreviewedInstance("proc-31", { title: "完成后修改" }))
      .toMatchObject({ ok: false, reason: "invalid-state" });
  });

  it("重新提交区分不存在、版本丢失、非驳回状态和无权创建人", () => {
    setActor("superadmin");
    expect(prototypeModule.usePrototypeStore.getState().republishInstance("missing-instance", { title: "重提" }))
      .toMatchObject({ ok: false, reason: "not-found" });

    const broken = {
      ...structuredClone(instanceById("proc-37")!),
      id: "republish-broken",
      versionId: "deleted-version",
    };
    addInstance(broken);
    expect(prototypeModule.usePrototypeStore.getState().republishInstance(broken.id, { title: "重提" }))
      .toMatchObject({ ok: false, reason: "version-missing" });
    expect(prototypeModule.usePrototypeStore.getState().republishInstance("proc-42", { title: "非驳回重提" }))
      .toMatchObject({ ok: false, reason: "invalid-state" });

    setActor("lina");
    expect(prototypeModule.usePrototypeStore.getState().republishInstance("proc-37", { title: "越权重提" }))
      .toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("自由协作异常操作", () => {
  it("仅回复作者可以在进行中的事项内修改回复，并保留修订历史", () => {
    const entry = instanceById("free-18")!.freeTimeline!.find((item) => item.type === "reply" && item.actor === "张伟")!;
    const originalContent = entry.content;

    setActor("lina");
    prototypeModule.usePrototypeStore.getState().editFreeFlowReply("free-18", entry.id, "他人越权修改");
    expect(instanceById("free-18")?.freeTimeline?.find((item) => item.id === entry.id)?.content).toBe(originalContent);

    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().editFreeFlowReply("free-18", entry.id, "研发修订后的结论");
    expect(instanceById("free-18")?.freeTimeline?.find((item) => item.id === entry.id)).toMatchObject({
      content: "研发修订后的结论",
      revisions: expect.arrayContaining([expect.objectContaining({ content: originalContent })]),
    });

    const closedEntry = instanceById("free-12")!.freeTimeline!.find((item) => item.type === "reply" && item.actor === "张伟")!;
    prototypeModule.usePrototypeStore.getState().editFreeFlowReply("free-12", closedEntry.id, "关闭后修改");
    expect(instanceById("free-12")?.freeTimeline?.find((item) => item.id === closedEntry.id)?.content)
      .toBe(closedEntry.content);
  });

  it("只有创建人可以修改进行中事项的初始内容，并记录字段及富文本变化", () => {
    const before = structuredClone(instanceById("free-18")!);
    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().updateFreeFlowInitial("free-18", {
      title: "越权修改",
      category: "其他",
      priority: "普通",
      description: "越权",
      initialContent: "越权",
    });
    expect(instanceById("free-18")).toEqual(before);

    setActor("wangmin");
    prototypeModule.usePrototypeStore.getState().updateFreeFlowInitial("free-18", {
      title: "MTR-320 干涉问题（已补充）",
      category: "设计变更",
      priority: "普通",
      description: "补充影响范围和验证计划",
      initialContent: "<p>补充后的初始说明</p>",
    });
    const updated = instanceById("free-18")!;
    expect(updated).toMatchObject({
      title: "MTR-320 干涉问题（已补充）",
      category: "设计变更",
      documentType: "设计变更",
      priority: "普通",
      description: "补充影响范围和验证计划",
    });
    expect(updated.freeTimeline?.find((item) => item.type === "created")).toMatchObject({
      content: "<p>补充后的初始说明</p>",
      revisions: [expect.objectContaining({ content: before.freeTimeline?.find((item) => item.type === "created")?.content })],
    });
    expect(updated.freeTimeline?.at(-1)).toMatchObject({
      type: "form-edited",
      actor: "王敏",
      fieldChanges: expect.arrayContaining([
        expect.objectContaining({ field: "标题" }),
        expect.objectContaining({ field: "事项分类" }),
        expect.objectContaining({ field: "优先级" }),
        expect.objectContaining({ field: "事项摘要" }),
        expect.objectContaining({ field: "初始说明" }),
      ]),
    });
  });

  it("无权转交、无效受理人、越权改派、越权关闭和无效重开均保持原状态", () => {
    const activeBefore = structuredClone(instanceById("free-18")!);
    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().transferFreeFlow("free-18", "越权转交", "赵磊");
    expect(instanceById("free-18")).toEqual(activeBefore);

    setActor("lina");
    prototypeModule.usePrototypeStore.getState().transferFreeFlow("free-18", "无效受理人", "何静");
    expect(instanceById("free-18")).toEqual(activeBefore);
    prototypeModule.usePrototypeStore.getState().forceReassignFreeFlow("free-18", "越权改派", "赵磊");
    expect(instanceById("free-18")).toEqual(activeBefore);
    prototypeModule.usePrototypeStore.getState().closeFreeFlow("free-18", "越权关闭");
    expect(instanceById("free-18")).toEqual(activeBefore);

    const closedBefore = structuredClone(instanceById("free-12")!);
    setActor("hejing");
    prototypeModule.usePrototypeStore.getState().reopenFreeFlow("free-12", "无关人员重开", "林晓");
    expect(instanceById("free-12")).toEqual(closedBefore);
    setActor("zhangwei");
    prototypeModule.usePrototypeStore.getState().reopenFreeFlow("free-12", "无效受理人", "何静");
    expect(instanceById("free-12")).toEqual(closedBefore);
  });

  it("超级管理员可补充回复但不会被写入业务参与人列表", () => {
    const before = structuredClone(instanceById("free-18")!);
    setActor("superadmin");
    prototypeModule.usePrototypeStore.getState().replyFreeFlow("free-18", "管理员补充审计说明");

    const updated = instanceById("free-18")!;
    expect(updated.freeTimeline).toHaveLength((before.freeTimeline?.length ?? 0) + 1);
    expect(updated.freeTimeline?.at(-1)).toMatchObject({
      type: "reply",
      actor: "超级管理员",
      content: "管理员补充审计说明",
    });
    expect(updated.participants).toEqual(before.participants);
    expect(updated.participantIds).toEqual(before.participantIds);
  });
});
