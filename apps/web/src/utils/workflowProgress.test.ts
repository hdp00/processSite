import { describe, expect, it } from "vitest";
import type { ReviewerProgress, WorkflowTask } from "../data/types";
import type { StoredFlowEdgeSnapshot, StoredFlowNodeSnapshot } from "./designerStorage";
import { buildWorkflowProgressStages } from "./workflowProgress";

const nodes: StoredFlowNodeSnapshot[] = [
  { id: "start", data: { kind: "start", label: "开始" } },
  { id: "rd", data: { kind: "approval", label: "研发审核", permissionGroup: "研发组" } },
  { id: "qa", data: { kind: "approval", label: "质量审核", permissionGroup: "质量组" } },
  { id: "manager", data: { kind: "approval", label: "经理确认", permissionGroup: "经理组", handlingMode: "confirmation" } },
  { id: "archive", data: { kind: "approval", label: "归档确认", permissionGroup: "文控组" } },
  { id: "end", data: { kind: "end", label: "结束" } },
];

const edges: StoredFlowEdgeSnapshot[] = [
  { source: "start", target: "rd" },
  { source: "start", target: "qa" },
  { source: "rd", target: "manager" },
  { source: "qa", target: "manager" },
  { source: "manager", target: "archive" },
  { source: "archive", target: "end" },
];

const task = (nodeId: string, status: WorkflowTask["status"]): WorkflowTask => ({
  id: `task-${nodeId}`,
  instanceId: "instance-1",
  definitionId: "definition-1",
  versionId: "version-1",
  nodeId,
  nodeName: nodeId,
  permissionGroupId: `${nodeId}-group`,
  status,
  createdAt: "2026-08-20 10:00",
  round: 1,
});

const reviewer = (key: string, status: ReviewerProgress["status"]): ReviewerProgress => ({
  key,
  name: "审核人",
  group: `${key}-group`,
  shortGroup: key,
  status,
});

describe("workflow progress topology", () => {
  it("renders parallel and sequential approval stages from the locked topology", () => {
    const stages = buildWorkflowProgressStages(
      nodes,
      edges,
      [task("rd", "待处理"), task("qa", "待处理"), task("manager", "未激活"), task("archive", "未激活")],
      [reviewer("rd", "待审核"), reviewer("qa", "待审核"), reviewer("manager", "待审核"), reviewer("archive", "待审核")],
    );

    expect(stages.map((stage) => stage.nodes.map((node) => node.id))).toEqual([
      ["rd", "qa"],
      ["manager"],
      ["archive"],
    ]);
    expect(stages.map((stage) => stage.parallel)).toEqual([true, false, false]);
    expect(stages[1].nodes[0]).toMatchObject({
      status: "待激活",
      handlingMode: "confirmation",
      predecessorLabels: ["研发审核", "质量审核"],
    });
  });

  it("hides condition-skipped nodes without hiding the remaining stage", () => {
    const stages = buildWorkflowProgressStages(
      nodes,
      edges,
      [task("rd", "待处理"), task("qa", "已跳过"), task("manager", "未激活"), task("archive", "未激活")],
      [reviewer("rd", "待审核"), reviewer("qa", "已跳过"), reviewer("manager", "待审核"), reviewer("archive", "待审核")],
    );

    expect(stages[0]).toMatchObject({ parallel: false, nodes: [{ id: "rd" }] });
    expect(stages.flatMap((stage) => stage.nodes).some((node) => node.id === "qa")).toBe(false);
  });
});
