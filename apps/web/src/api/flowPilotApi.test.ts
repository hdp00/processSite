// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { flowPilotApi } from "./flowPilotApi";

const instance: ProcessInstance = {
  id: "instance-1",
  definitionId: "definition-1",
  versionId: "version-1",
  code: "TEST0001",
  title: "测试流程",
  template: "测试流程",
  templateVersion: "V1",
  status: "审核中",
  initiator: "发起人",
  initiatorId: "user-1",
  department: "",
  createdAt: "2026-09-01T08:00:00Z",
  updatedAt: "2026-09-01T08:00:00Z",
  round: 1,
  currentNode: "审批",
  priority: "普通",
  description: "",
  formValues: { title: "测试流程", "review-note": "" },
  fieldRevisions: { title: 3, "review-note": 2 },
  reviewers: [],
};

const task = (editableFieldIds: string[]): WorkflowTask => ({
  id: "task-1",
  instanceId: instance.id,
  definitionId: instance.definitionId,
  versionId: instance.versionId,
  nodeId: "approval-1",
  nodeName: "审批",
  permissionGroupId: "group-1",
  editableFieldIds,
  status: "待处理",
  createdAt: "2026-09-01T08:00:00Z",
  round: 1,
});

const responseFor = (workflowTask: WorkflowTask) => new Response(JSON.stringify({
  instance,
  task: workflowTask,
  activatedTaskIds: [],
  cancelledTaskIds: [],
}), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

afterEach(() => {
  usePrototypeStore.setState({ instances: [], tasks: [] });
  vi.unstubAllGlobals();
});

describe("任务审核请求", () => {
  it("节点没有授权编辑字段时只提交审核动作和意见", async () => {
    const currentTask = task([]);
    usePrototypeStore.setState({ instances: [instance], tasks: [currentTask] });
    const request = vi.fn().mockResolvedValue(responseFor(currentTask));
    vi.stubGlobal("fetch", request);

    await flowPilotApi.tasks.decide(currentTask.id, {
      action: "pass",
      comment: "同意",
      fieldValues: { title: "页面完整表单值", "review-note": "不应提交" },
    }, '"task-1-revision-1"');

    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      action: "pass",
      comment: "同意",
      fieldValues: {},
      baseFieldRevisions: {},
      attachmentIdsByField: {},
    });
  });

  it("只提交当前节点授权字段及对应并发版本", async () => {
    const currentTask = task(["review-note"]);
    usePrototypeStore.setState({ instances: [instance], tasks: [currentTask] });
    const request = vi.fn().mockResolvedValue(responseFor(currentTask));
    vi.stubGlobal("fetch", request);

    await flowPilotApi.tasks.decide(currentTask.id, {
      action: "pass",
      fieldValues: { title: "不能修改", "review-note": "审核补充" },
    }, '"task-1-revision-1"');

    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.fieldValues).toEqual({ "review-note": "审核补充" });
    expect(body.baseFieldRevisions).toEqual({ "review-note": 2 });
  });
});
