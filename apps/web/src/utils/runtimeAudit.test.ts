import { describe, expect, it } from "vitest";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { collectRuntimeAuditEvents } from "./runtimeAudit";

const instance: ProcessInstance = {
  id: "instance-1",
  definitionId: "definition-1",
  versionId: "version-1",
  workflowType: "approval",
  code: "QA26080001",
  title: "测试流程",
  template: "质量审核",
  templateVersion: "V1",
  status: "已完成",
  initiator: "王敏",
  initiatorId: "wangmin",
  department: "文控",
  createdAt: "2026-08-19 09:00:00",
  updatedAt: "2026-08-19 10:00:00",
  round: 1,
  currentNode: "流程结束",
  priority: "普通",
  description: "",
  pdfName: "无附件",
  pdfSize: "—",
  documentCode: "",
  documentType: "",
  documentLevel: "",
  revision: "",
  reviewers: [],
  resubmissions: [{
    round: 2,
    submittedAt: "2026-08-19 09:30:00",
    submittedById: "wangmin",
    submittedByName: "王敏",
    modifiedFields: [{ fieldId: "title", label: "标题" }],
  }],
};

const task: WorkflowTask = {
  id: "task-1",
  instanceId: instance.id,
  definitionId: "definition-1",
  versionId: "version-1",
  nodeId: "quality-review",
  nodeName: "质量审核",
  permissionGroupId: "quality-group",
  status: "已完成",
  completedById: "lina",
  completedByName: "李娜",
  action: "通过",
  createdAt: "2026-08-19 09:00:00",
  completedAt: "2026-08-19 10:00:00",
  round: 1,
};

describe("collectRuntimeAuditEvents", () => {
  it("从同一实例和待办状态生成创建、审核事件", () => {
    const events = collectRuntimeAuditEvents([instance], [task]);
    expect(events.map((event) => event.id)).toContain("runtime-created-instance-1");
    expect(events.map((event) => event.id)).toContain("runtime-decision-task-1");
    expect(events.find((event) => event.id === "runtime-decision-task-1")?.details)
      .toMatchObject({ instanceId: "instance-1", instanceCode: "QA26080001", round: 1 });
    expect(events.find((event) => event.id === "runtime-resubmission-instance-1-r2"))
      .toMatchObject({ action: "resubmit", actorId: "wangmin", occurredAt: "2026-08-19 09:30:00" });
  });
});
