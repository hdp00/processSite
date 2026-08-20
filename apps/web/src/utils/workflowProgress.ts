import type { ReviewerProgress, WorkflowTask } from "../data/types";
import type { StoredFlowEdgeSnapshot, StoredFlowNodeSnapshot } from "./designerStorage";
import { buildFlowLevels } from "./designerStorage";

export type WorkflowProgressStatus = ReviewerProgress["status"] | "待激活";

export interface WorkflowProgressNode {
  id: string;
  label: string;
  permissionGroupId: string;
  handlingMode: "approval" | "confirmation";
  status: WorkflowProgressStatus;
  defaultAssigneeId?: string;
  actualAssigneeName?: string;
  actionAt?: string;
  substitute?: boolean;
  predecessorLabels: string[];
}

export interface WorkflowProgressStage {
  index: number;
  parallel: boolean;
  nodes: WorkflowProgressNode[];
}

const progressStatus = (
  task: WorkflowTask | undefined,
  reviewer: ReviewerProgress | undefined,
): WorkflowProgressStatus => {
  if (task?.status === "未激活") return "待激活";
  if (task?.status === "待处理") return reviewer?.status ?? "待审核";
  if (task?.status === "已取消") return "已取消";
  if (task?.status === "已完成" && !reviewer) {
    if (task.action === "确认") return "已确认";
    if (task.action === "驳回") return "已驳回";
    return "已通过";
  }
  return reviewer?.status ?? "待激活";
};

export const buildWorkflowProgressStages = (
  nodes: StoredFlowNodeSnapshot[],
  edges: StoredFlowEdgeSnapshot[],
  tasks: WorkflowTask[],
  reviewers: ReviewerProgress[],
): WorkflowProgressStage[] => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const taskByNode = new Map(tasks.map((task) => [task.nodeId, task]));
  const reviewerByNode = new Map(reviewers.map((reviewer) => [reviewer.key, reviewer]));
  const incomingByNode = new Map(nodes.map((node) => [node.id, [] as string[]]));
  edges.forEach((edge) => incomingByNode.get(edge.target)?.push(edge.source));
  const isSkipped = (nodeId: string) => taskByNode.get(nodeId)?.status === "已跳过"
    || reviewerByNode.get(nodeId)?.status === "已跳过";
  const visibleApprovalPredecessors = (nodeId: string, visited = new Set<string>()): string[] => {
    if (visited.has(nodeId)) return [];
    const nextVisited = new Set(visited).add(nodeId);
    return (incomingByNode.get(nodeId) ?? []).flatMap((sourceId) => {
      const source = nodeById.get(sourceId);
      if (!source || source.data?.kind === "start") return [];
      if (source.data?.kind === "approval" && !isSkipped(sourceId)) return [source.data.label || "未命名节点"];
      return visibleApprovalPredecessors(sourceId, nextVisited);
    });
  };
  return buildFlowLevels(nodes, edges)
    .map((level) => level.flatMap((nodeId): WorkflowProgressNode[] => {
      const node = nodeById.get(nodeId);
      if (node?.data?.kind !== "approval") return [];
      const task = taskByNode.get(nodeId);
      const reviewer = reviewerByNode.get(nodeId);
      if (isSkipped(nodeId)) return [];
      const predecessorLabels = [...new Set(visibleApprovalPredecessors(nodeId))];
      return [{
        id: nodeId,
        label: node.data.label || "未命名节点",
        permissionGroupId: reviewer?.group || node.data.permissionGroup || "未配置流程权限组",
        handlingMode: node.data.handlingMode ?? "approval",
        status: progressStatus(task, reviewer),
        defaultAssigneeId: task?.defaultAssigneeId,
        actualAssigneeName: reviewer?.actionAt ? reviewer.name : task?.completedByName,
        actionAt: reviewer?.actionAt ?? task?.completedAt,
        substitute: reviewer?.substitute || Boolean(task?.defaultAssigneeId && task.completedById && task.defaultAssigneeId !== task.completedById),
        predecessorLabels,
      }];
    }))
    .filter((level) => level.length > 0)
    .map((level, index) => ({ index: index + 1, parallel: level.length > 1, nodes: level }));
};
