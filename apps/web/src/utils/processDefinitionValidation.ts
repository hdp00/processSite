import type { WorkflowPermissionGroup } from "../state/useIdentityStore";
import {
  PROCESS_TITLE_FIELD_ID,
  normalizeDesignerInputPermission,
  normalizeStoredCondition,
  type CompleteDesignerSnapshot,
  type StoredDesignerField,
  type StoredFlowEdgeSnapshot,
  type StoredFlowNodeSnapshot,
  type StoredNodeCondition,
} from "./designerStorage";
import { flattenDesignerChoiceOptions, type DesignerChoiceOption } from "./designerOptions";

export interface ProcessValidationBasic {
  name: string;
  instancePrefix: string;
  type: "approval" | "free";
  starterGroups: string[];
  closeGroups: string[];
  assigneeGroups?: string[];
}

export interface ProcessValidationContext {
  workflowGroups: WorkflowPermissionGroup[];
  effectiveMemberIds: (groupIdOrName: string) => string[];
}

export interface ProcessValidationCheck {
  key: string;
  title: string;
  detail: string;
  pass: boolean;
}

export interface ProcessValidationResult {
  status: "通过" | "未通过";
  issues: string[];
  checks: ProcessValidationCheck[];
}

const choiceTypes = new Set(["select", "cascader", "radio", "checkbox"]);

const invalidOptionTree = (options: DesignerChoiceOption[] | undefined): boolean => {
  if (!options?.length) return true;
  const labels = options.map((option) => option.label.trim());
  const ids = flattenDesignerChoiceOptions(options).map((option) => option.id);
  return labels.some((label) => !label)
    || new Set(labels).size !== labels.length
    || new Set(ids).size !== ids.length
    || options.some((option) => option.children?.length ? invalidOptionTree(option.children) : false);
};

const conditionIsInvalid = (
  condition: StoredNodeCondition | undefined,
  fieldById: Map<string, StoredDesignerField>,
) => {
  const normalized = normalizeStoredCondition(condition);
  if (!normalized) return false;
  if (!normalized.rules.length) return true;
  return normalized.rules.some((rule) => {
    const field = fieldById.get(rule.fieldId);
    const supported = field?.type === "checkbox"
      ? ["contains", "not-contains", "empty", "not-empty"]
      : field?.type === "text"
        ? ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not-empty"]
        : ["eq", "neq", "empty", "not-empty"];
    const optionValueMissing = Boolean(field && choiceTypes.has(field.type)
      && !["empty", "not-empty"].includes(rule.operator)
      && !flattenDesignerChoiceOptions(field.options).some((option) => option.id === String(rule.value ?? "")));
    return !field
      || !supported.includes(rule.operator)
      || optionValueMissing
      || (!["empty", "not-empty"].includes(rule.operator) && (rule.value === undefined || rule.value === ""));
  });
};

const resolveGroup = (groups: WorkflowPermissionGroup[], idOrName: string) =>
  groups.find((group) => group.id === idOrName || group.name === idOrName);

const groupProblem = (
  idOrName: string,
  purpose: WorkflowPermissionGroup["purposes"][number],
  context?: ProcessValidationContext,
) => {
  if (!idOrName.trim()) return "未选择流程权限组";
  if (!context) return undefined;
  const group = resolveGroup(context.workflowGroups, idOrName);
  if (!group) return `流程权限组“${idOrName}”不存在`;
  if (group.status !== "启用") return `流程权限组“${group.name}”已停用`;
  if (!group.purposes.includes(purpose)) return `流程权限组“${group.name}”不具备“${purpose}”用途`;
  const effectiveMemberCount = group.effectiveMemberCount ?? context.effectiveMemberIds(group.id).length;
  if (!effectiveMemberCount) return `流程权限组“${group.name}”没有有效成员`;
  return undefined;
};

const visit = (origin: string | undefined, graph: Map<string, string[]>) => {
  const visited = new Set<string>();
  if (!origin) return visited;
  const queue = [origin];
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    graph.get(current)?.forEach((next) => queue.push(next));
  }
  return visited;
};

export const validateApprovalFlow = (
  nodes: StoredFlowNodeSnapshot[],
  edges: StoredFlowEdgeSnapshot[],
  fields: StoredDesignerField[],
  context?: ProcessValidationContext,
): ProcessValidationCheck[] => {
  const starts = nodes.filter((node) => node.data?.kind === "start");
  const ends = nodes.filter((node) => node.data?.kind === "end");
  const approvals = nodes.filter((node) => node.data?.kind === "approval");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const labels = (items: StoredFlowNodeSnapshot[]) => items.map((node) => node.data?.label || node.id).join("、");
  const danglingEdges = edges.filter((edge) => !nodeById.has(edge.source) || !nodeById.has(edge.target));
  const selfEdges = edges.filter((edge) => edge.source === edge.target);
  const edgePairs = edges.map((edge) => `${edge.source}->${edge.target}`);
  const duplicateEdges = edgePairs.filter((pair, index) => edgePairs.indexOf(pair) !== index);
  const validEdges = edges.filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target) && edge.source !== edge.target);
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const reverseAdjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  validEdges.forEach((edge) => {
    adjacency.get(edge.source)?.push(edge.target);
    reverseAdjacency.get(edge.target)?.push(edge.source);
  });

  const reachableFromStart = visit(starts[0]?.id, adjacency);
  const canReachEnd = visit(ends[0]?.id, reverseAdjacency);
  const disconnected = nodes.filter((node) => !reachableFromStart.has(node.id) || !canReachEnd.has(node.id));
  const terminalDirectionProblems = nodes.filter((node) =>
    (node.data?.kind === "start" && (reverseAdjacency.get(node.id)?.length ?? 0) > 0)
    || (node.data?.kind === "end" && (adjacency.get(node.id)?.length ?? 0) > 0)
    || (node.data?.kind === "approval" && (!(reverseAdjacency.get(node.id)?.length) || !(adjacency.get(node.id)?.length))),
  );

  const indegree = new Map(nodes.map((node) => [node.id, reverseAdjacency.get(node.id)?.length ?? 0]));
  const cycleQueue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visitedCount = 0;
  while (cycleQueue.length) {
    const current = cycleQueue.shift()!;
    visitedCount += 1;
    adjacency.get(current)?.forEach((next) => {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) cycleQueue.push(next);
    });
  }
  const hasCycle = visitedCount !== nodes.length;

  const permissionProblems: string[] = [];
  starts.forEach((node) => {
    const groups = node.data?.permissionGroups ?? [];
    if (!groups.length) permissionProblems.push(`${node.data?.label || node.id}：未选择发起流程权限组`);
    groups.forEach((group) => {
      const problem = groupProblem(group, "发起", context);
      if (problem) permissionProblems.push(`${node.data?.label || node.id}：${problem}`);
    });
  });
  approvals.forEach((node) => {
    const problem = groupProblem(node.data?.permissionGroup ?? "", "审批/受理", context);
    if (problem) permissionProblems.push(`${node.data?.label || node.id}：${problem}`);
  });

  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const invalidConditions = approvals.filter((node) => conditionIsInvalid(node.data?.activationCondition, fieldById));
  const assignedFields = new Set(approvals.flatMap((node) => node.data?.editableFields ?? []));
  const requiredReviewerFields = fields.filter((field) =>
    normalizeDesignerInputPermission(field) === "reviewer" && field.required && !assignedFields.has(field.id),
  );
  const invalidRepeatedEditing = approvals.filter((node) => node.data?.allowRepeatedEditing && !node.data.editableFields?.length);
  const invalidEmailNodes = nodes.filter((node) => {
    if (node.data?.kind !== "approval" && node.data?.kind !== "end") return false;
    const notification = node.data.emailNotification;
    return Boolean(notification?.enabled
      && !notification.notifyReviewers
      && !notification.notifyInitiator
      && !(notification.extraUserIds?.length ?? 0));
  });

  const editableLabelByValue = new Map<string, string>();
  fields.forEach((field) => {
    if (field.type === "table") {
      if (normalizeDesignerInputPermission(field) === "reviewer") editableLabelByValue.set(field.id, `${field.label || field.id}（整表）`);
      if (normalizeDesignerInputPermission(field) === "both") field.columns?.filter((column) => column.reviewEditable).forEach((column) => editableLabelByValue.set(`${field.id}.${column.id}`, `${field.label || field.id} / ${column.label}`));
    } else if (normalizeDesignerInputPermission(field) !== "initiator") editableLabelByValue.set(field.id, field.label || field.id);
  });
  const splitNodes = nodes.filter((node) => (adjacency.get(node.id)?.length ?? 0) >= 2);
  const joinNodes = nodes.filter((node) => (reverseAdjacency.get(node.id)?.length ?? 0) >= 2);
  const invalidSplits: string[] = [];
  const conflictMessages: string[] = [];
  splitNodes.forEach((splitNode) => {
    const branchRootIds = adjacency.get(splitNode.id) ?? [];
    const invalidTargets = branchRootIds.map((id) => nodeById.get(id)).filter((node) => node?.data?.kind !== "approval");
    const branchDistances = branchRootIds.map((rootId) => {
      const distances = new Map<string, number>();
      const queue: Array<[string, number]> = [[rootId, 0]];
      while (queue.length) {
        const [current, distance] = queue.shift()!;
        if (distances.has(current)) continue;
        distances.set(current, distance);
        adjacency.get(current)?.forEach((next) => queue.push([next, distance + 1]));
      }
      return distances;
    });
    const totalBranchDistance = (nodeId: string) => branchDistances
      .reduce((sum, distances) => sum + distances.get(nodeId)!, 0);
    const commonJoin = joinNodes
      .filter((node) => branchDistances.every((distances) => distances.has(node.id)))
      .sort((left, right) => totalBranchDistance(left.id) - totalBranchDistance(right.id))[0];
    if (invalidTargets.length || !commonJoin) {
      invalidSplits.push(splitNode.data?.label || splitNode.id);
      return;
    }
    const fieldOwners = new Map<string, Array<{ branch: number; label: string }>>();
    branchRootIds.forEach((rootId, branch) => {
      const visited = new Set<string>();
      const queue = [rootId];
      while (queue.length) {
        const current = queue.shift()!;
        if (current === commonJoin.id || visited.has(current)) continue;
        visited.add(current);
        const node = nodeById.get(current);
        if (node?.data?.kind === "approval") (node.data.editableFields ?? []).forEach((field) => fieldOwners.set(field, [
          ...(fieldOwners.get(field) ?? []),
          { branch, label: node.data?.label || node.id },
        ]));
        adjacency.get(current)?.forEach((next) => queue.push(next));
      }
    });
    fieldOwners.forEach((owners, field) => {
      if (new Set(owners.map((owner) => owner.branch)).size > 1) conflictMessages.push(
        `${editableLabelByValue.get(field) ?? field}（${[...new Set(owners.map((owner) => owner.label))].join("、")}）`,
      );
    });
  });

  const uniqueTerminals = starts.length === 1 && ends.length === 1;
  const edgeStructureValid = !danglingEdges.length && !selfEdges.length && !duplicateEdges.length;
  const connected = uniqueTerminals && edgeStructureValid && !hasCycle && !disconnected.length && !terminalDirectionProblems.length;
  return [
    { key: "terminal", title: "开始与结束节点唯一", detail: uniqueTerminals ? "已检测到 1 个开始节点和 1 个结束节点" : `当前开始节点 ${starts.length} 个，结束节点 ${ends.length} 个`, pass: uniqueTerminals },
    { key: "connected", title: "流程连通性", detail: connected ? `全部 ${nodes.length} 个节点均可由开始到达并最终流向结束` : hasCycle ? "流程中存在循环连线" : danglingEdges.length ? "存在连接到已删除节点的连线" : selfEdges.length || duplicateEdges.length ? "存在自连接或重复连线" : terminalDirectionProblems.length ? `节点出入方向不完整：${labels(terminalDirectionProblems)}` : disconnected.length ? `未连通节点：${labels(disconnected)}` : "请先修正开始与结束节点", pass: connected },
    { key: "groups", title: "流程权限组", detail: permissionProblems.length ? permissionProblems.join("；") : `发起节点及 ${approvals.length} 个审批节点均已配置有效权限组`, pass: !permissionProblems.length },
    { key: "parallel-topology", title: "并行与汇聚拓扑", detail: invalidSplits.length ? `${invalidSplits.join("、")} 的多条分支需要直接连接审批节点并汇聚到同一后续节点` : splitNodes.length ? `已自动识别 ${splitNodes.length} 处并行、${joinNodes.length} 处汇聚` : "当前为串行流程，无需配置并行节点", pass: !invalidSplits.length },
    { key: "field-conflict", title: "并行可修改字段冲突", detail: conflictMessages.length ? `发现冲突：${conflictMessages.join("；")}` : "各并行路径中的审批节点可修改字段互不重叠", pass: !conflictMessages.length },
    { key: "conditions", title: "审批执行条件", detail: invalidConditions.length ? `条件配置不完整：${labels(invalidConditions)}` : "所有条件均引用有效字段并已完整配置", pass: !invalidConditions.length },
    { key: "reviewer-required", title: "审核人必填字段", detail: requiredReviewerFields.length ? `尚未分配负责节点：${requiredReviewerFields.map((field) => field.label).join("、")}` : "审核人必填字段均已分配到至少一个审批节点", pass: !requiredReviewerFields.length },
    { key: "repeated-editing", title: "重复修改配置", detail: invalidRepeatedEditing.length ? `请先配置可修改字段：${labels(invalidRepeatedEditing)}` : "重复修改仅用于已授权字段", pass: !invalidRepeatedEditing.length },
    { key: "email-notification", title: "邮件通知收件人", detail: invalidEmailNodes.length ? `已启用邮件但未选择收件人：${labels(invalidEmailNodes)}` : "所有已启用邮件均已配置收件人", pass: !invalidEmailNodes.length },
  ];
};

export const validateProcessSnapshot = (
  basic: ProcessValidationBasic,
  snapshot: CompleteDesignerSnapshot,
  context?: ProcessValidationContext,
): ProcessValidationResult => {
  const issues: string[] = [];
  if (!basic.name.trim()) issues.push("流程名称不能为空");
  if (!basic.instancePrefix.trim()) issues.push("实例编号前缀未配置");
  if (!/^[A-Za-z0-9_-]+$/.test(basic.instancePrefix.trim())) issues.push("实例编号前缀只能包含字母、数字、横线和下划线");
  const validateBasicGroups = (ids: string[], purpose: WorkflowPermissionGroup["purposes"][number], emptyMessage: string) => {
    if (!ids.length) issues.push(emptyMessage);
    ids.forEach((id) => {
      const problem = groupProblem(id, purpose, context);
      if (problem) issues.push(problem);
    });
  };
  validateBasicGroups(basic.starterGroups, "发起", "至少选择一个发起流程权限组");
  validateBasicGroups(basic.closeGroups, "关闭", "至少选择一个关闭流程权限组");
  const titleField = snapshot.form.fields.find((field) => field.id === PROCESS_TITLE_FIELD_ID);
  if (!titleField || titleField.type !== "text") issues.push("初始表单必须包含系统固定的标题文本框");
  if (titleField && normalizeDesignerInputPermission(titleField) === "reviewer") issues.push("标题必须由发起人填写");
  const invalidFieldOptions = snapshot.form.fields.some((field) =>
    (choiceTypes.has(field.type) && invalidOptionTree(field.options))
    || field.columns?.some((column) => column.type && column.type !== "text" && invalidOptionTree(column.options)),
  );
  if (invalidFieldOptions) issues.push("单选、复选、下拉或多级下拉存在空白、重复或缺失的选项");
  const fieldIndexById = new Map(snapshot.form.fields.map((field, index) => [field.id, index]));
  const invalidDisplayCondition = snapshot.form.fields.some((field, fieldIndex) => {
    const condition = normalizeStoredCondition(field.displayCondition);
    if (!condition) return false;
    return field.id === PROCESS_TITLE_FIELD_ID || !condition.rules.length || condition.rules.some((rule) => {
      const sourceIndex = fieldIndexById.get(rule.fieldId);
      const sourceField = sourceIndex === undefined ? undefined : snapshot.form.fields[sourceIndex];
      return sourceIndex === undefined
        || sourceIndex >= fieldIndex
        || !sourceField
        || !["text", "select", "cascader", "radio", "checkbox"].includes(sourceField.type)
        || conditionIsInvalid({ mode: "all", rules: [rule] }, new Map(snapshot.form.fields.map((item) => [item.id, item])));
    });
  });
  if (invalidDisplayCondition) issues.push("初始表单存在无效或未填写完整的字段显示条件");

  const checks = basic.type === "approval"
    ? validateApprovalFlow(snapshot.flow.nodes, snapshot.flow.edges, snapshot.form.fields, context)
    : [];
  if (basic.type === "free") validateBasicGroups(basic.assigneeGroups ?? [], "审批/受理", "至少选择一个受理流程权限组");
  checks.filter((check) => !check.pass).forEach((check) => issues.push(`${check.title}：${check.detail}`));
  return { status: issues.length ? "未通过" : "通过", issues: [...new Set(issues)], checks };
};
