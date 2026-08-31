import { describe, expect, it } from "vitest";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  normalizeAttachmentRecord,
  normalizeAuditEvent,
  normalizeDomainRole,
  normalizeDirectoryUser,
  normalizeEmailOutboxItem,
  normalizePageResult,
  normalizeProcessInstance,
  normalizeProcessVersion,
  normalizeWorkflowTask,
  normalizeWorkflowGroup,
} from "./remoteAdapters";

describe("formal REST response adapters", () => {
  it("maps OpenAPI pagination and nested directory references", () => {
    const result = normalizePageResult({
      items: [{
        id: "user-1",
        loginName: "zhangsan",
        name: "张三",
        email: "zhangsan@example.com",
        authenticationMode: "domain",
        department: { id: "dept-1", path: "研发 / 平台" },
        position: { id: "position-1", name: "工程师" },
        roles: [{ id: "role-1", name: "研发审核员" }],
        status: "enabled",
        lastLoginAt: "2026-08-21T08:00:00Z",
      }],
      meta: { page: 2, pageSize: 20, total: 41, totalPages: 3 },
    }, normalizeDirectoryUser);

    expect(result.page).toEqual({ number: 2, size: 20, totalElements: 41, totalPages: 3 });
    expect(result.items[0]).toMatchObject({
      account: "zhangsan",
      department: ["dept-1"],
      departmentPath: "研发 / 平台",
      jobTitle: "工程师",
      roles: ["研发审核员"],
      roleIds: ["role-1"],
      status: "启用",
    });
  });

  it("maps a formal process version DTO to the shared complete snapshot model", () => {
    const source = useProcessDefinitionStore.getState().definitions[0].versions[0];
    const version = normalizeProcessVersion({
      ...source,
      version: undefined,
      versionLabel: "V9",
      basedOn: { versionId: "v8", versionLabel: "V8" },
      createdBy: { id: "user-1", name: "张三" },
      updatedBy: { id: "user-2", name: "李四" },
      starterGroups: undefined,
      basic: {
        ...source.basic,
        starterGroups: undefined,
        closeGroups: undefined,
        visibleRoles: undefined,
        visibleUsers: undefined,
        starterGroupIds: source.basic.starterGroups,
        closeGroupIds: source.basic.closeGroups,
        visibleRoleIds: source.basic.visibleRoles,
        visibleUserIds: source.basic.visibleUsers,
      },
      validation: {
        status: "passed",
        checkedAt: source.validation.checkedAt,
        issues: [{ code: "EXAMPLE", message: "示例提示" }],
      },
      snapshot: {
        ...source.snapshot,
        form: {
          ...source.snapshot.form,
          fields: [
            ...source.snapshot.form.fields,
            { id: "remote-text", type: "text", label: "文本", options: [{ id: "invalid", label: "不应保留" }] },
            { id: "remote-file", type: "attachment", label: "附件", options: [{ id: "invalid-file", label: "不应保留" }] },
            { id: "remote-select", type: "select", label: "下拉", options: [{ id: "valid", label: "应保留" }] },
          ],
        },
      },
    });

    expect(version).toMatchObject({
      version: "V9",
      basedOn: "V8",
      createdBy: "张三",
      updatedBy: "李四",
      starterGroups: source.basic.starterGroups,
      validation: { status: "通过", issues: ["示例提示"] },
    });
    expect(version.formFieldCount).toBe(source.snapshot.form.fields.length);
    expect(version.nodeCount).toBe(source.snapshot.flow.nodes.length);
    expect(version.snapshot.form.fields.find((field) => field.id === "remote-text")?.options).toBeUndefined();
    expect(version.snapshot.form.fields.find((field) => field.id === "remote-file")?.options).toBeUndefined();
    expect(version.snapshot.form.fields.find((field) => field.id === "remote-select")?.options).toHaveLength(1);
  });

  it("maps formal instance and task enums without leaking transport DTOs into pages", () => {
    const instance = normalizeProcessInstance({
      id: "instance-1",
      definitionId: "definition-1",
      versionId: "version-1",
      code: "PDF26080001",
      title: "发布审核",
      processName: "PDF审核",
      versionLabel: "V2",
      workflowType: "approval",
      status: "reviewing",
      round: 1,
      currentNodeNames: ["研发审核", "质量审核"],
      initiator: { id: "user-1", name: "王敏", departmentPath: "质量" },
      formValues: { priority: "紧急", description: "说明" },
      fieldRevisions: { title: 2 },
      reviewProgress: [],
      attachments: [],
      tasks: [],
      timeline: [],
      createdAt: "2026-08-21T08:00:00Z",
      updatedAt: "2026-08-21T09:00:00Z",
    });
    const task = normalizeWorkflowTask({
      id: "task-1",
      instanceId: "instance-1",
      definitionId: "definition-1",
      versionId: "version-1",
      nodeId: "node-1",
      nodeName: "研发审核",
      permissionGroupId: "group-1",
      handlingMode: "approval",
      status: "pending",
      round: 1,
      editableFieldIds: ["title"],
      allowedActions: ["pass", "reject"],
      submittedFieldChanges: [],
      fieldRevisions: [],
      createdAt: "2026-08-21T08:00:00Z",
    });

    expect(instance).toMatchObject({ status: "审核中", currentNode: "研发审核、质量审核", priority: "紧急", fieldRevisions: { title: 2 } });
    expect(task).toMatchObject({ status: "待处理", handlingMode: "approval", editableFieldIds: ["title"], allowedActions: ["pass", "reject"] });
  });

  it("maps formal role, workflow group, attachment and audit DTOs", () => {
    expect(normalizeDomainRole({
      id: "role-1", code: "reviewer", name: "审核员", description: "", status: "enabled",
      memberCount: 2, memberIds: ["user-1"], permissionCount: 5, pagePermissionCount: 2, actionPermissionCount: 5,
    })).toMatchObject({ users: 2, pagePermissions: 2, actionPermissions: 5, memberUserIds: ["user-1"] });

    expect(normalizeWorkflowGroup({
      id: "group-1", code: "G001", name: "研发审核", purposes: ["review-or-accept"], status: "enabled",
      directUserIds: ["user-1"], roleIds: ["role-1"], effectiveMemberCount: 3, openTaskCount: 4,
      referencedProcesses: [{ id: "definition-1", name: "PDF 审核" }], updatedAt: "2026-08-25T08:00:00Z",
    })).toMatchObject({ effectiveMemberCount: 3, openTasks: 4, processes: ["PDF 审核"] });

    expect(normalizeAttachmentRecord({
      id: "attachment-1", originalName: "审核.pdf", sizeBytes: 2048, contentType: "application/pdf",
      status: "referenced", uploadedBy: { id: "user-1", name: "张三" }, uploadedAt: "2026-08-25T08:00:00Z",
      referencedBy: [{ aggregateType: "process-instance", aggregateId: "instance-1", fieldId: "attachment" }],
    })).toMatchObject({ name: "审核.pdf", size: 2048, uploadedById: "user-1", lifecycle: "active", instanceId: "instance-1", fieldId: "attachment" });

    expect(normalizeAuditEvent({
      id: "audit-1", action: "workflow-task.confirmed", aggregateType: "workflow-task", aggregateId: "task-1",
      actor: { id: "user-1", name: "张三", departmentPath: "研发 / 软件" },
      operator: { id: "admin", name: "管理员", departmentPath: "系统" }, result: "success",
      occurredAt: "2026-08-25T08:00:00Z", details: { summary: "确认研发节点" },
    })).toMatchObject({ category: "task", actorId: "user-1", actorName: "张三", actorDepartmentPath: "研发 / 软件", operatorName: "管理员", operatorDepartmentPath: "系统", result: "success", resourceType: "workflow-task", resourceId: "task-1", summary: "确认研发节点" });
  });

  it("maps free-collaboration mail events to the existing notification categories", () => {
    const common = {
      id: "mail-1",
      instanceId: "instance-1",
      recipient: { id: "user-1", name: "张三" },
      recipientEmailSnapshot: "zhangsan@example.test",
      status: "pending",
      attemptCount: 0,
      createdAt: "2026-08-31T08:00:00Z",
    };

    expect(normalizeEmailOutboxItem({
      ...common,
      eventType: "free-collaboration-assigned",
      taskId: "task-1",
    })).toMatchObject({ kind: "task-activated", taskId: "task-1" });
    expect(normalizeEmailOutboxItem({
      ...common,
      eventType: "free-collaboration-closed",
    })).toMatchObject({ kind: "process-completed", taskId: undefined });
  });
});
