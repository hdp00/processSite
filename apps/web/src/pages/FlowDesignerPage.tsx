import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ApartmentOutlined,
  AuditOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  FilePdfOutlined,
  InfoCircleOutlined,
  MailOutlined,
  PlayCircleFilled,
  PlusOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Input,
  message,
  Radio,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import {
  ProcessWizardNextButton,
  ProcessWizardPreviousButton,
} from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { useIdentityStore } from "../state/useIdentityStore";
import {
  canEditVersion,
  getVersionStatus,
  useProcessDefinitionStore,
  type VersionStatus,
} from "../state/useProcessDefinitionStore";
import {
  buildFlowLevels,
  conditionOperatorLabel,
  type EditableFieldOption,
  type ApprovalHandlingMode,
  type ConditionOperator,
  type StoredDesignerField,
  type StoredFlowDesignerSnapshot,
  type StoredNodeCondition,
  type StoredNodeEmailNotification,
} from "../utils/designerStorage";
import "./flow-designer.css";

const { Text, Title } = Typography;

type NodeKind = "start" | "approval" | "end";

interface FlowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  description: string;
  permissionGroup?: string;
  permissionGroups?: string[];
  specifyAssignee?: boolean;
  editableFields: string[];
  handlingMode?: ApprovalHandlingMode;
  allowRepeatedEditing?: boolean;
  activationCondition?: StoredNodeCondition;
  emailNotification?: StoredNodeEmailNotification;
}

interface ConditionFieldOption extends EditableFieldOption {
  type: string;
  options?: string[];
  inputStage?: "initiator" | "reviewer";
  required?: boolean;
}

type DesignerNode = Node<FlowNodeData, "processNode">;
type DesignerEdge = Edge;

interface FlowMeta {
  name: string;
  code: string;
  version: string;
  basedOn: string;
  status: VersionStatus;
  rejectionHandling: "resubmit-or-close" | "resubmit-only" | "auto-close";
  lastSavedAt: string;
}

interface StoredDraft {
  nodes: DesignerNode[];
  edges: DesignerEdge[];
  meta: FlowMeta;
}

interface ValidationResult {
  key: string;
  title: string;
  detail: string;
  pass: boolean;
}

const rejectionHandlingOptions: Array<{
  value: FlowMeta["rejectionHandling"];
  label: string;
  description: string;
}> = [
  {
    value: "resubmit-or-close",
    label: "重新提交或关闭",
    description: "进入驳回待处理，由发起方修改后重新提交，或直接关闭流程。",
  },
  {
    value: "resubmit-only",
    label: "仅允许重新提交",
    description: "进入驳回待处理，发起方修改后必须重新提交，不能在此状态关闭。",
  },
  {
    value: "auto-close",
    label: "自动关闭流程",
    description: "驳回结果提交后立即关闭流程，不再等待发起方处理。",
  },
];

const handlingModeOptions: Array<{
  value: ApprovalHandlingMode;
  label: string;
  description: string;
}> = [
  {
    value: "approval",
    label: "审批",
    description: "审核人可以通过或驳回本节点。",
  },
  {
    value: "confirmation",
    label: "确认",
    description: "审核人只能确认完成，没有驳回入口。",
  },
];

const defaultEmailNotification = (kind: NodeKind): StoredNodeEmailNotification => ({
  enabled: false,
  notifyReviewers: kind === "approval",
  notifyInitiator: kind === "end",
  extraUserIds: [],
});

const normalizeEmailNotification = (
  kind: NodeKind,
  notification?: StoredNodeEmailNotification,
): StoredNodeEmailNotification => notification
  ? {
      enabled: Boolean(notification.enabled),
      notifyReviewers: kind === "approval" && Boolean(notification.notifyReviewers),
      notifyInitiator: kind === "end" && Boolean(notification.notifyInitiator),
      extraUserIds: [...(notification.extraUserIds ?? [])],
    }
  : defaultEmailNotification(kind);

const kindMeta: Record<
  NodeKind,
  { label: string; description: string; color: string; icon: React.ReactNode }
> = {
  start: {
    label: "开始",
    description: "配置发起流程权限组",
    color: "#18a67d",
    icon: <PlayCircleFilled />,
  },
  approval: {
    label: "审批",
    description: "配置审核组与可修改字段",
    color: "#4b6bfb",
    icon: <AuditOutlined />,
  },
  end: {
    label: "结束",
    description: "全部前置节点完成后结束",
    color: "#64748b",
    icon: <CheckCircleFilled />,
  },
};

const initialNodes: DesignerNode[] = [
  {
    id: "start-dcc",
    type: "processNode",
    position: { x: 52, y: 252 },
    data: {
      kind: "start",
      label: "文控发起",
      description: "上传受控 PDF 文件并提交",
      permissionGroups: ["PDF审核_文控_流程权限组"],
      editableFields: [],
    },
  },
  {
    id: "approval-rd",
    type: "processNode",
    position: { x: 350, y: 64 },
    data: {
      kind: "approval",
      label: "研发审核",
      description: "校验技术参数与变更合理性",
      permissionGroup: "PDF审核_研发_流程权限组",
      specifyAssignee: true,
      editableFields: ["技术版本", "变更摘要"],
      handlingMode: "approval",
      allowRepeatedEditing: false,
      emailNotification: defaultEmailNotification("approval"),
    },
  },
  {
    id: "approval-quality",
    type: "processNode",
    position: { x: 350, y: 252 },
    data: {
      kind: "approval",
      label: "质量审核",
      description: "确认质量要求与检验依据",
      permissionGroup: "PDF审核_质量_流程权限组",
      specifyAssignee: true,
      editableFields: ["文件等级", "检验依据"],
      handlingMode: "approval",
      allowRepeatedEditing: false,
      emailNotification: defaultEmailNotification("approval"),
    },
  },
  {
    id: "approval-production",
    type: "processNode",
    position: { x: 350, y: 440 },
    data: {
      kind: "approval",
      label: "生产审核",
      description: "确认现场执行与生效安排",
      permissionGroup: "PDF审核_生产_流程权限组",
      specifyAssignee: false,
      editableFields: ["生效日期", "现场备注"],
      handlingMode: "approval",
      allowRepeatedEditing: false,
      emailNotification: defaultEmailNotification("approval"),
    },
  },
  {
    id: "end-approved",
    type: "processNode",
    position: { x: 684, y: 252 },
    data: {
      kind: "end",
      label: "审核完成",
      description: "全部节点通过或确认后，流程结束",
      editableFields: [],
      emailNotification: defaultEmailNotification("end"),
    },
  },
];

const edgeDefaults = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, color: "#8b98ad", width: 16, height: 16 },
  style: { stroke: "#8b98ad", strokeWidth: 1.7 },
};

const initialEdges: DesignerEdge[] = [
  { id: "e-start-rd", source: "start-dcc", target: "approval-rd", ...edgeDefaults },
  {
    id: "e-start-quality",
    source: "start-dcc",
    target: "approval-quality",
    ...edgeDefaults,
  },
  {
    id: "e-start-production",
    source: "start-dcc",
    target: "approval-production",
    ...edgeDefaults,
  },
  { id: "e-rd-end", source: "approval-rd", target: "end-approved", ...edgeDefaults },
  {
    id: "e-quality-end",
    source: "approval-quality",
    target: "end-approved",
    ...edgeDefaults,
  },
  {
    id: "e-production-end",
    source: "approval-production",
    target: "end-approved",
    ...edgeDefaults,
  },
];

const genericInitialMeta: FlowMeta = {
  name: "流程设计",
  code: "—",
  version: "V1",
  basedOn: "全新流程",
  status: "校验未通过",
  rejectionHandling: "resubmit-or-close",
  lastSavedAt: "尚未保存",
};

const createGenericDraft = (starterGroups: string[]): Pick<StoredDraft, "nodes" | "edges"> => ({
  nodes: [
    {
      id: "start-default",
      type: "processNode",
      position: { x: 64, y: 220 },
      data: {
        kind: "start",
        label: "流程发起",
        description: "填写初始表单并提交",
        permissionGroups: starterGroups,
        editableFields: [],
      },
    },
    {
      id: "approval-default",
      type: "processNode",
      position: { x: 370, y: 220 },
      data: {
        kind: "approval",
        label: "审批节点",
        description: "配置流程权限组和可修改字段",
        specifyAssignee: true,
        editableFields: [],
        handlingMode: "approval",
        allowRepeatedEditing: false,
        emailNotification: defaultEmailNotification("approval"),
      },
    },
    {
      id: "end-default",
      type: "processNode",
      position: { x: 680, y: 220 },
      data: {
        kind: "end",
        label: "流程结束",
        description: "全部前置节点通过或确认后结束",
        editableFields: [],
        emailNotification: defaultEmailNotification("end"),
      },
    },
  ],
  edges: [
    { id: "e-start-default", source: "start-default", target: "approval-default", ...edgeDefaults },
    { id: "e-approval-default", source: "approval-default", target: "end-default", ...edgeDefaults },
  ],
});

const formatTime = () =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

const readStoredDraft = (
  storageKey: string,
  fallbackMeta: FlowMeta,
  fallbackTopology: Pick<StoredDraft, "nodes" | "edges">,
): StoredDraft => {
  if (typeof window === "undefined") {
    return { ...fallbackTopology, meta: fallbackMeta };
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return { ...fallbackTopology, meta: fallbackMeta };
    const parsed = JSON.parse(stored) as Partial<StoredDraft>;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !parsed.meta) {
      return { ...fallbackTopology, meta: fallbackMeta };
    }
    if (
      parsed.nodes.some(
        (node) => (node.data as Record<string, unknown> | undefined)?.kind === "parallel",
      )
    ) {
      return { ...fallbackTopology, meta: fallbackMeta };
    }
    return {
      nodes: parsed.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          permissionGroups: node.data.kind === "start"
            ? node.data.permissionGroups ?? (node.data.permissionGroup ? [node.data.permissionGroup] : [])
            : node.data.permissionGroups,
          editableFields: node.data.editableFields ?? [],
          handlingMode: node.data.kind === "approval" ? node.data.handlingMode ?? "approval" : node.data.handlingMode,
          allowRepeatedEditing: node.data.kind === "approval"
            ? Boolean(node.data.allowRepeatedEditing && node.data.editableFields?.length)
            : false,
          emailNotification: node.data.kind === "approval" || node.data.kind === "end"
            ? normalizeEmailNotification(node.data.kind, node.data.emailNotification)
            : undefined,
        },
      })),
      edges: parsed.edges,
      meta: {
        ...parsed.meta,
        ...fallbackMeta,
        rejectionHandling:
          parsed.meta.rejectionHandling ?? fallbackMeta.rejectionHandling,
      },
    } as StoredDraft;
  } catch {
    return { ...fallbackTopology, meta: fallbackMeta };
  }
};

const ProcessNode = ({ data, selected }: NodeProps<DesignerNode>) => {
  const meta = kindMeta[data.kind];
  const showTarget = data.kind !== "start";
  const showSource = data.kind !== "end";
  const groups = data.kind === "start" ? data.permissionGroups : data.permissionGroup ? [data.permissionGroup] : [];
  const groupLabel = groups?.join("、");

  return (
    <div className={`process-node process-node--${data.kind} ${selected ? "is-selected" : ""}`}>
      {showTarget && <Handle type="target" position={Position.Left} className="process-node__handle" />}
      <div className="process-node__icon" style={{ color: meta.color, background: `${meta.color}14` }}>
        {meta.icon}
      </div>
      <div className="process-node__content">
        <div className="process-node__title-row">
          <span className="process-node__title">{data.label}</span>
          {data.kind === "approval" && data.specifyAssignee && (
            <Tooltip title="发起时可指定该权限组中的一人">
              <TeamOutlined className="process-node__assignee" />
            </Tooltip>
          )}
          {data.kind === "approval" && data.handlingMode === "confirmation" ? (
            <Tooltip title="该节点只能确认完成，不能驳回">
              <Tag variant="filled" color="cyan">确认</Tag>
            </Tooltip>
          ) : null}
          {data.kind === "approval" && data.activationCondition?.rules.length ? (
            <Tooltip title={`${data.activationCondition.mode === "all" ? "全部" : "任一"}条件满足时执行`}>
              <Tag variant="filled" color="purple">条件</Tag>
            </Tooltip>
          ) : null}
          {(data.kind === "approval" || data.kind === "end") && data.emailNotification?.enabled ? (
            <Tooltip title="该节点已启用邮件通知">
              <MailOutlined className="process-node__mail" />
            </Tooltip>
          ) : null}
        </div>
        <span className="process-node__description">
          {groupLabel || data.description}
        </span>
      </div>
      {showSource && <Handle type="source" position={Position.Right} className="process-node__handle" />}
    </div>
  );
};

const nodeTypes = { processNode: ProcessNode };

const runValidation = (
  nodes: DesignerNode[],
  edges: DesignerEdge[],
  editableOptions: EditableFieldOption[],
  conditionFields: ConditionFieldOption[],
): ValidationResult[] => {
  const starts = nodes.filter((node) => node.data.kind === "start");
  const ends = nodes.filter((node) => node.data.kind === "end");
  const approvals = nodes.filter((node) => node.data.kind === "approval");

  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  nodes.forEach((node) => {
    adjacency.set(node.id, []);
    reverseAdjacency.set(node.id, []);
  });
  edges.forEach((edge) => {
    adjacency.get(edge.source)?.push(edge.target);
    reverseAdjacency.get(edge.target)?.push(edge.source);
  });

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

  const reachableFromStart = visit(starts[0]?.id, adjacency);
  const canReachEnd = visit(ends[0]?.id, reverseAdjacency);
  const disconnected = nodes.filter(
    (node) => !reachableFromStart.has(node.id) || !canReachEnd.has(node.id),
  );

  const missingGroups = [...starts, ...approvals].filter((node) =>
    node.data.kind === "start"
      ? !node.data.permissionGroups?.length
      : !node.data.permissionGroup?.trim(),
  );
  const editableLabelByValue = new Map(editableOptions.map((option) => [option.value, option.label]));
  const conditionFieldById = new Map(conditionFields.map((field) => [field.value, field]));
  const invalidConditions = approvals.filter((node) => {
    const condition = node.data.activationCondition;
    if (!condition) return false;
    if (!condition.rules.length) return true;
    return condition.rules.some((rule) => {
      const field = conditionFieldById.get(rule.fieldId);
      const supported = field?.type === "checkbox"
        ? ["contains", "not-contains", "empty", "not-empty"]
        : field?.type === "text"
          ? ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not-empty"]
          : ["eq", "neq", "empty", "not-empty"];
      return !field || !supported.includes(rule.operator) || (!["empty", "not-empty"].includes(rule.operator) && (rule.value === undefined || rule.value === ""));
    });
  });
  const requiredReviewerFields = conditionFields.filter((field) => field.inputStage === "reviewer" && field.required);
  const unassignedReviewerFields = requiredReviewerFields.filter((field) => !approvals.some((node) => node.data.editableFields.includes(field.value)));
  const invalidRepeatedEditing = approvals.filter((node) => node.data.allowRepeatedEditing && !node.data.editableFields.length);
  const invalidEmailNodes = nodes.filter((node) => {
    if (node.data.kind !== "approval" && node.data.kind !== "end") return false;
    const notification = node.data.emailNotification;
    return Boolean(notification?.enabled
      && !notification.notifyReviewers
      && !notification.notifyInitiator
      && !(notification.extraUserIds?.length ?? 0));
  });

  const splitNodes = nodes.filter((node) => (adjacency.get(node.id)?.length ?? 0) >= 2);
  const joinNodes = nodes.filter((node) => (reverseAdjacency.get(node.id)?.length ?? 0) >= 2);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const invalidSplits: string[] = [];
  const conflictMessages: string[] = [];
  splitNodes.forEach((splitNode) => {
    const branchRootIds = adjacency.get(splitNode.id) ?? [];
    const invalidTargets = branchRootIds
      .map((id) => nodeById.get(id))
      .filter((node) => node?.data.kind !== "approval");

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
    const commonJoin = joinNodes
      .filter((node) => branchDistances.every((distances) => distances.has(node.id)))
      .sort((left, right) => {
        const leftDistance = branchDistances.reduce(
          (sum, distances) => sum + (distances.get(left.id) ?? Number.MAX_SAFE_INTEGER),
          0,
        );
        const rightDistance = branchDistances.reduce(
          (sum, distances) => sum + (distances.get(right.id) ?? Number.MAX_SAFE_INTEGER),
          0,
        );
        return leftDistance - rightDistance;
      })[0];

    if (invalidTargets.length || !commonJoin) {
      invalidSplits.push(splitNode.data.label);
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
        if (node?.data.kind === "approval") {
          node.data.editableFields.forEach((field) => {
            fieldOwners.set(field, [
              ...(fieldOwners.get(field) ?? []),
              { branch, label: node.data.label },
            ]);
          });
        }
        adjacency.get(current)?.forEach((next) => queue.push(next));
      }
    });
    fieldOwners.forEach((owners, field) => {
      if (new Set(owners.map((owner) => owner.branch)).size > 1) {
        conflictMessages.push(
          `${editableLabelByValue.get(field) ?? field}（${[...new Set(owners.map((owner) => owner.label))].join("、")}）`,
        );
      }
    });
  });

  const uniqueTerminals = starts.length === 1 && ends.length === 1;
  const connected = uniqueTerminals && disconnected.length === 0;

  return [
    {
      key: "terminal",
      title: "开始与结束节点唯一",
      detail: uniqueTerminals
        ? "已检测到 1 个开始节点和 1 个结束节点"
        : `当前开始节点 ${starts.length} 个，结束节点 ${ends.length} 个`,
      pass: uniqueTerminals,
    },
    {
      key: "connected",
      title: "流程连通性",
      detail: connected
        ? `全部 ${nodes.length} 个节点均可由开始到达并最终流向结束`
        : disconnected.length
          ? `未连通节点：${disconnected.map((node) => node.data.label).join("、")}`
          : "请先修正开始与结束节点",
      pass: connected,
    },
    {
      key: "groups",
      title: "流程权限组",
      detail: missingGroups.length
        ? `未配置：${missingGroups.map((node) => node.data.label).join("、")}`
        : `发起节点及 ${approvals.length} 个审批节点均已配置权限组`,
      pass: missingGroups.length === 0,
    },
    {
      key: "parallel-topology",
      title: "并行与汇聚拓扑",
      detail: invalidSplits.length
        ? `${invalidSplits.join("、")} 的多条分支需要直接连接审批节点并汇聚到同一后续节点`
        : splitNodes.length
          ? `已自动识别 ${splitNodes.length} 处并行、${joinNodes.length} 处汇聚`
          : "当前为串行流程，无需配置并行节点",
      pass: invalidSplits.length === 0,
    },
    {
      key: "field-conflict",
      title: "并行可修改字段冲突",
      detail: conflictMessages.length
        ? `发现冲突：${conflictMessages.join("；")}`
        : "各并行路径中的审批节点可修改字段互不重叠",
      pass: conflictMessages.length === 0,
    },
    {
      key: "conditions",
      title: "审批执行条件",
      detail: invalidConditions.length
        ? `条件配置不完整：${invalidConditions.map((node) => node.data.label).join("、")}`
        : "所有条件均引用有效字段并已完整配置",
      pass: invalidConditions.length === 0,
    },
    {
      key: "reviewer-required",
      title: "审核人必填字段",
      detail: unassignedReviewerFields.length
        ? `尚未分配负责节点：${unassignedReviewerFields.map((field) => field.label).join("、")}`
        : "审核人必填字段均已分配到至少一个审批节点",
      pass: unassignedReviewerFields.length === 0,
    },
    {
      key: "repeated-editing",
      title: "重复修改配置",
      detail: invalidRepeatedEditing.length
        ? `请先配置可修改字段：${invalidRepeatedEditing.map((node) => node.data.label).join("、")}`
        : "重复修改仅用于已授权字段",
      pass: invalidRepeatedEditing.length === 0,
    },
    {
      key: "email-notification",
      title: "邮件通知收件人",
      detail: invalidEmailNodes.length
        ? `已启用邮件但未选择收件人：${invalidEmailNodes.map((node) => node.data.label).join("、")}`
        : "所有已启用邮件均已配置收件人",
      pass: invalidEmailNodes.length === 0,
    },
  ];
};

interface DesignerWorkspaceProps {
  initialDraft: StoredDraft;
  definitionId: string;
  versionId: string;
  editableFieldOptions: EditableFieldOption[];
  conditionFieldOptions: ConditionFieldOption[];
  starterGroups: string[];
}

const DesignerWorkspace = ({ initialDraft, definitionId, versionId, editableFieldOptions, conditionFieldOptions, starterGroups }: DesignerWorkspaceProps) => {
  const navigate = useNavigate();
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const users = useIdentityStore((state) => state.users);
  const starterGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("发起"))
    .map((group) => ({ value: group.id, label: group.name }));
  const approvalGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("审批"))
    .map((group) => ({ value: group.id, label: group.name }));
  const extraEmailUserOptions = users.map((user) => {
    const email = "email" in user ? String(user.email ?? "").trim() : "";
    const unavailable = user.status !== "启用" || !email;
    return {
      value: user.id,
      label: `${user.name} · ${email || "未维护邮箱"}${user.status !== "启用" ? " · 已停用" : ""}`,
      disabled: unavailable,
      email,
    };
  });
  const versionBasic = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === definitionId)?.versions.find((item) => item.id === versionId)?.basic,
  );
  const updateVersionBasic = useProcessDefinitionStore((state) => state.updateVersionBasic);
  const updateVersionFlowSnapshot = useProcessDefinitionStore((state) => state.updateVersionFlowSnapshot);
  const [nodes, setNodes, onNodesChange] = useNodesState<DesignerNode>(initialDraft.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DesignerEdge>(initialDraft.edges);
  const [meta, setMeta] = useState<FlowMeta>(initialDraft.meta);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    initialDraft.nodes.find((node) => node.data.kind === "approval")?.id ?? null,
  );
  const [propertyMode, setPropertyMode] = useState<"flow" | "node">("node");
  const [validationOpen, setValidationOpen] = useState(false);
  const [autoSaved, setAutoSaved] = useState(true);
  const skipDirtyEffect = useRef(true);
  const { fitView, screenToFlowPosition } = useReactFlow<DesignerNode, DesignerEdge>();

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  );
  const selectedEmailNotification = selectedNode && (selectedNode.data.kind === "approval" || selectedNode.data.kind === "end")
    ? normalizeEmailNotification(selectedNode.data.kind, selectedNode.data.emailNotification)
    : undefined;
  const validationResults = useMemo(
    () => runValidation(nodes, edges, editableFieldOptions, conditionFieldOptions),
    [conditionFieldOptions, edges, editableFieldOptions, nodes],
  );
  const parallelRegionCount = useMemo(() => {
    const outgoingCount = new Map<string, number>();
    edges.forEach((edge) =>
      outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1),
    );
    return [...outgoingCount.values()].filter((count) => count >= 2).length;
  }, [edges]);
  const allValidationPassed = validationResults.every((result) => result.pass);

  useEffect(() => {
    if (skipDirtyEffect.current) {
      skipDirtyEffect.current = false;
      return;
    }
    setAutoSaved(false);
  }, [edges, meta, nodes]);

  useEffect(() => {
    const allowed = new Set(editableFieldOptions.map((option) => option.value));
    const labelToValue = new Map(editableFieldOptions.map((option) => [option.label, option.value]));
    setNodes((currentNodes) => currentNodes.map((node) => {
      const normalizedFields = node.data.editableFields
        .map((field) => allowed.has(field) ? field : labelToValue.get(field))
        .filter((field): field is string => Boolean(field));
      const nextStarterGroups = node.data.kind === "start" ? starterGroups : node.data.permissionGroups;
      const nextRepeatedEditing = node.data.kind === "approval" && normalizedFields.length
        ? Boolean(node.data.allowRepeatedEditing)
        : false;
      const nextHandlingMode = node.data.kind === "approval" ? node.data.handlingMode ?? "approval" : node.data.handlingMode;
      const nextEmailNotification = node.data.kind === "approval" || node.data.kind === "end"
        ? normalizeEmailNotification(node.data.kind, node.data.emailNotification)
        : undefined;
      const emailNotificationUnchanged = nextEmailNotification === undefined && node.data.emailNotification === undefined
        || Boolean(nextEmailNotification
          && node.data.emailNotification
          && nextEmailNotification.enabled === node.data.emailNotification.enabled
          && nextEmailNotification.notifyReviewers === Boolean(node.data.emailNotification.notifyReviewers)
          && nextEmailNotification.notifyInitiator === Boolean(node.data.emailNotification.notifyInitiator)
          && nextEmailNotification.extraUserIds.join("|") === (node.data.emailNotification.extraUserIds ?? []).join("|"));
      return normalizedFields.join("|") === node.data.editableFields.join("|")
        && (nextStarterGroups ?? []).join("|") === (node.data.permissionGroups ?? []).join("|")
        && nextRepeatedEditing === Boolean(node.data.allowRepeatedEditing)
        && nextHandlingMode === node.data.handlingMode
        && emailNotificationUnchanged
        ? node
        : { ...node, data: {
            ...node.data,
            editableFields: normalizedFields,
            permissionGroups: nextStarterGroups,
            handlingMode: nextHandlingMode,
            allowRepeatedEditing: nextRepeatedEditing,
            emailNotification: nextEmailNotification,
          } };
    }));
  }, [editableFieldOptions, setNodes, starterGroups]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((currentEdges) =>
        addEdge(
          {
            ...connection,
            id: `edge-${Date.now()}`,
            ...edgeDefaults,
          },
          currentEdges,
        ),
      );
    },
    [setEdges],
  );

  const onDragStart = (event: DragEvent<HTMLDivElement>, kind: NodeKind) => {
    event.dataTransfer.setData("application/flowpilot-node", kind);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/flowpilot-node") as NodeKind;
      if (!kindMeta[kind]) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = `${kind}-${Date.now()}`;
      const node: DesignerNode = {
        id,
        type: "processNode",
        position,
        data: {
          kind,
          label: kind === "approval" ? "新审批节点" : kindMeta[kind].label,
          description: kindMeta[kind].description,
          permissionGroup: undefined,
          permissionGroups: kind === "start" ? starterGroups : undefined,
          specifyAssignee: kind === "approval",
          editableFields: [],
          handlingMode: kind === "approval" ? "approval" : undefined,
          allowRepeatedEditing: false,
          activationCondition: undefined,
          emailNotification: kind === "approval" || kind === "end"
            ? defaultEmailNotification(kind)
            : undefined,
        },
      };
      setNodes((currentNodes) => [...currentNodes, node]);
      setSelectedNodeId(id);
      setPropertyMode("node");
    },
    [screenToFlowPosition, setNodes, starterGroups],
  );

  const updateSelectedNode = (changes: Partial<FlowNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNodeId
          ? { ...node, data: { ...node.data, ...changes } }
          : node,
      ),
    );
  };

  const updateSelectedEmailNotification = (changes: Partial<StoredNodeEmailNotification>) => {
    if (!selectedNode || !selectedEmailNotification) return;
    updateSelectedNode({
      emailNotification: {
        ...selectedEmailNotification,
        ...changes,
        extraUserIds: changes.extraUserIds ?? selectedEmailNotification.extraUserIds,
      },
    });
  };

  const updateStarterGroups = (permissionGroups: string[]) => {
    updateSelectedNode({ permissionGroups });
  };

  const updateFlowName = (name: string) => {
    setMeta((current) => ({ ...current, name }));
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) return;
    setNodes((currentNodes) => currentNodes.filter((node) => node.id !== selectedNode.id));
    setEdges((currentEdges) =>
      currentEdges.filter(
        (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
      ),
    );
    setSelectedNodeId(null);
    setPropertyMode("flow");
    message.success(`已删除节点“${selectedNode.data.label}”`);
  };

  const autoLayout = () => {
    const levels = buildFlowLevels(nodes, edges);
    const positioned = new Map<string, { x: number; y: number }>();
    levels.forEach((ids, level) => {
      const totalHeight = Math.max(0, ids.length - 1) * 172;
      ids.forEach((id, index) => {
        positioned.set(id, { x: 64 + level * 310, y: 300 - totalHeight / 2 + index * 172 });
      });
    });
    setNodes((currentNodes) => currentNodes.map((node) => ({
      ...node,
      position: positioned.get(node.id) ?? node.position,
    })));
    window.setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1.08, duration: 320 }), 0);
    message.success("已按连线层级自动整理节点");
  };

  const saveVersion = () => {
    const nextMeta = { ...meta, lastSavedAt: formatTime() };
    skipDirtyEffect.current = true;
    setMeta(nextMeta);
    const startGroups = nodes.find((node) => node.data.kind === "start")?.data.permissionGroups ?? starterGroups;
    if (versionBasic) updateVersionBasic(definitionId, versionId, { ...versionBasic, name: nextMeta.name, starterGroups: startGroups });
    const saved = updateVersionFlowSnapshot(definitionId, versionId, { nodes, edges, meta: { rejectionHandling: nextMeta.rejectionHandling } } as StoredFlowDesignerSnapshot);
    if (saved) {
      setAutoSaved(true);
      message.success("版本已保存，并已自动更新校验结果");
    } else {
      message.error("该版本当前不可编辑，请返回版本记录确认状态");
    }
    return saved;
  };

  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty: !autoSaved,
    onSave: saveVersion,
    title: "审批流程尚未保存",
    description: "可以先保存节点、连线和流程规则再离开，也可以放弃本次修改。",
  });

  const goPrevious = () => {
    if (!autoSaved && !saveVersion()) return;
    allowNextNavigation();
    navigate(`/admin/processes/${definitionId}/form?versionId=${versionId}`);
  };

  const goNext = () => {
    if (!autoSaved && !saveVersion()) return;
    if (!allValidationPassed) {
      message.warning("流程结构校验未通过，版本已保留，可在发布页面查看问题并返回修改");
    }
    allowNextNavigation();
    navigate(`/admin/processes/${definitionId}/publish?versionId=${versionId}`);
  };

  return (
    <div className="flow-designer-page">
      {guard}
      <header className="flow-designer-toolbar">
        <div className="flow-designer-toolbar__identity">
          <div className="flow-designer-toolbar__icon">
            <FilePdfOutlined />
          </div>
          <div>
            <div className="flow-designer-toolbar__title-row">
              <Title level={4}>{meta.name}</Title>
              <StatusPill status={meta.status} />
            </div>
            <Space size={8} split={<span className="flow-designer-toolbar__dot">·</span>}>
              <Text type="secondary">{meta.code}</Text>
              <Text type="secondary">正式版本 {meta.version}</Text>
              <Text type="secondary">{meta.basedOn === "全新流程" ? "首次创建" : `来源 ${meta.basedOn}`}</Text>
            </Space>
          </div>
        </div>
        <div className="flow-designer-toolbar__actions">
          <span className={`flow-designer-save-state ${autoSaved ? "is-saved" : ""}`}>
            <span className="flow-designer-save-state__dot" />
            {autoSaved ? `版本已保存 · ${meta.lastSavedAt}` : "有未保存修改"}
          </span>
          <ProcessWizardPreviousButton step="初始表单" onClick={goPrevious} />
          <Button icon={<ApartmentOutlined />} onClick={autoLayout}>
            自动布局
          </Button>
          <Button icon={<SaveOutlined />} onClick={saveVersion}>
            保存
          </Button>
          <Button icon={<SafetyCertificateOutlined />} onClick={() => setValidationOpen(true)}>
            查看校验结果
          </Button>
          <ProcessWizardNextButton step="发布" onClick={goNext} />
        </div>
      </header>

      <div className="flow-wizard-steps">
        <ProcessWizardSteps workflowType="approval" current={2} />
      </div>

      <div className="flow-designer-workspace">
        <aside className="flow-designer-palette">
          <div className="designer-panel-heading">
            <div>
              <Text strong>节点库</Text>
              <Text type="secondary">拖到画布后连线</Text>
            </div>
            <Tooltip title="拖拽节点到画布，然后从节点右侧连接点拖线">
              <InfoCircleOutlined />
            </Tooltip>
          </div>

          <div className="flow-designer-palette__list">
            {(Object.keys(kindMeta) as NodeKind[]).map((kind) => {
              const nodeMeta = kindMeta[kind];
              return (
                <div
                  key={kind}
                  className="palette-node"
                  draggable
                  onDragStart={(event) => onDragStart(event, kind)}
                >
                  <span
                    className="palette-node__icon"
                    style={{ color: nodeMeta.color, background: `${nodeMeta.color}12` }}
                  >
                    {nodeMeta.icon}
                  </span>
                  <span className="palette-node__content">
                    <Text strong>{nodeMeta.label}</Text>
                    <Text type="secondary">{nodeMeta.description}</Text>
                  </span>
                  <PlusOutlined className="palette-node__add" />
                </div>
              );
            })}
          </div>

          <div className="flow-designer-palette__tip">
            <ApartmentOutlined />
            <div>
              <Text strong>并行审核规则</Text>
              <Text type="secondary">
                同一节点引出多条审核连线时自动并行；多条连线汇入同一节点时，等待全部前置通过或确认后继续。
              </Text>
            </div>
          </div>
        </aside>

        <main className="flow-designer-canvas" onDrop={onDrop} onDragOver={onDragOver}>
          <div className="flow-designer-canvas__status">
            <Tag>{nodes.length} 个节点</Tag>
            <Tag>{edges.length} 条连线</Tag>
            <Tag color={parallelRegionCount ? "purple" : "default"}>
              {parallelRegionCount ? `已识别 ${parallelRegionCount} 处并行` : "串行流程"}
            </Tag>
            <Tag color={allValidationPassed ? "success" : "warning"}>
              {allValidationPassed ? "规则校验通过" : "存在待处理项"}
            </Tag>
          </div>
          <ReactFlow<DesignerNode, DesignerEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setPropertyMode("node");
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setPropertyMode("flow");
            }}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedNodeId)) {
                setSelectedNodeId(null);
                setPropertyMode("flow");
              }
            }}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1.08 }}
            minZoom={0.45}
            maxZoom={1.5}
            snapToGrid
            snapGrid={[16, 16]}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cbd3df" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => kindMeta[(node.data as FlowNodeData).kind].color}
              maskColor="rgba(241, 245, 249, 0.76)"
            />
          </ReactFlow>
        </main>

        <aside className="flow-designer-properties">
          <div className="designer-panel-heading designer-panel-heading--properties">
            <div>
              <Text strong>属性面板</Text>
              <Text type="secondary">
                {propertyMode === "node" && selectedNode
                  ? selectedNode.data.label
                  : `${meta.name} · ${meta.version}`}
              </Text>
            </div>
            <SettingOutlined />
          </div>

          <div className="property-panel-switcher">
            <Segmented
              block
              value={propertyMode}
              options={[
                { label: "流程属性", value: "flow" },
                { label: "节点属性", value: "node", disabled: !selectedNode },
              ]}
              onChange={(value) => setPropertyMode(value as "flow" | "node")}
            />
          </div>

          {propertyMode === "node" && selectedNode ? (
            <div className="property-form">
              <div className="property-node-summary">
                <span
                  className="property-node-summary__icon"
                  style={{
                    color: kindMeta[selectedNode.data.kind].color,
                    background: `${kindMeta[selectedNode.data.kind].color}12`,
                  }}
                >
                  {kindMeta[selectedNode.data.kind].icon}
                </span>
                <div>
                  <Text strong>{selectedNode.data.label}</Text>
                  <Text type="secondary">节点 ID · {selectedNode.id}</Text>
                </div>
              </div>

              <label className="property-field">
                <span className="property-field__label">节点名称</span>
                <Input
                  value={selectedNode.data.label}
                  maxLength={30}
                  onChange={(event) => updateSelectedNode({ label: event.target.value })}
                />
              </label>

              <label className="property-field">
                <span className="property-field__label">节点说明</span>
                <Input.TextArea
                  value={selectedNode.data.description}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  maxLength={80}
                  onChange={(event) => updateSelectedNode({ description: event.target.value })}
                />
              </label>

              {(selectedNode.data.kind === "start" || selectedNode.data.kind === "approval") && (
                <label className="property-field">
                  <span className="property-field__label">
                    {selectedNode.data.kind === "start" ? "发起流程权限组" : "审核流程权限组"}
                    <Text type="danger"> *</Text>
                  </span>
                  {selectedNode.data.kind === "start" ? (
                    <Select
                      mode="multiple"
                      value={selectedNode.data.permissionGroups}
                      placeholder="请选择一个或多个发起流程权限组"
                      showSearch
                      allowClear
                      maxTagCount="responsive"
                      options={starterGroupOptions}
                      onChange={updateStarterGroups}
                    />
                  ) : (
                    <Select
                      value={selectedNode.data.permissionGroup}
                      placeholder="请选择审核流程权限组"
                      showSearch
                      allowClear
                      options={approvalGroupOptions}
                      onChange={(permissionGroup) => updateSelectedNode({ permissionGroup })}
                    />
                  )}
                  <Text type="secondary" className="property-field__help">
                    成员变更立即影响运行中的待办；权限组停用不影响已有流程。
                  </Text>
                </label>
              )}

              {selectedNode.data.kind === "approval" && (
                <>
                  <div className="property-field">
                    <span className="property-field__label">处理方式</span>
                    <Text type="secondary" className="property-field__help property-field__help--above">
                      确认与通过具有相同的正向流转效果，但确认节点没有驳回入口。
                    </Text>
                    <Radio.Group
                      className="handling-mode-options"
                      value={selectedNode.data.handlingMode ?? "approval"}
                      onChange={(event) => updateSelectedNode({ handlingMode: event.target.value as ApprovalHandlingMode })}
                    >
                      {handlingModeOptions.map((option) => (
                        <Radio key={option.value} value={option.value}>
                          <span className="handling-mode-option__content">
                            <Text strong>{option.label}</Text>
                            <Text type="secondary">{option.description}</Text>
                          </span>
                        </Radio>
                      ))}
                    </Radio.Group>
                  </div>

                  <Divider />

                  <div className="property-switch-row">
                    <div>
                      <Text strong>发起时指定人员</Text>
                      <Text type="secondary">
                        指定人显示在“我的待办”，同组其他人员可在“可代办”处理。
                      </Text>
                    </div>
                    <Switch
                      checked={selectedNode.data.specifyAssignee}
                      onChange={(specifyAssignee) => updateSelectedNode({ specifyAssignee })}
                    />
                  </div>

                  <Divider />

                  <div className="property-field">
                    <span className="property-field__label">审核人可修改字段</span>
                    <Text type="secondary" className="property-field__help property-field__help--above">
                      修改内容与审核结果原子提交。并行路径之间不允许选择同一字段。
                    </Text>
                    <Checkbox.Group
                      value={selectedNode.data.editableFields}
                      options={editableFieldOptions}
                      onChange={(values) => {
                        const editableFields = values.map(String);
                        updateSelectedNode({
                          editableFields,
                          allowRepeatedEditing: editableFields.length ? selectedNode.data.allowRepeatedEditing : false,
                        });
                      }}
                      className="editable-field-options"
                    />
                    {!editableFieldOptions.length && (
                      <Alert
                        type="info"
                        showIcon
                        message="初始表单中暂无审核可修改字段"
                        description="请返回初始表单，将普通字段或表格列开启“允许审核人修改”后再选择。"
                      />
                    )}
                    <div className="property-switch-row repeated-editing-row">
                      <div>
                        <Text strong>允许重复修改</Text>
                        <Text type="secondary">处理结果提交后，审核人仍可反复修改本节点授权字段。</Text>
                      </div>
                      <Switch
                        checked={Boolean(selectedNode.data.allowRepeatedEditing)}
                        disabled={!selectedNode.data.editableFields.length}
                        onChange={(allowRepeatedEditing) => updateSelectedNode({ allowRepeatedEditing })}
                      />
                    </div>
                    {!selectedNode.data.editableFields.length ? (
                      <Text type="secondary" className="property-field__help">请先选择至少一个审核人可修改字段。</Text>
                    ) : null}
                  </div>

                  <Divider />

                  <div className="property-field condition-editor">
                    <div className="property-switch-row">
                      <div>
                        <Text strong>按条件执行</Text>
                        <Text type="secondary">条件不满足时自动跳过该节点，并视为已满足汇聚条件。</Text>
                      </div>
                      <Switch
                        checked={Boolean(selectedNode.data.activationCondition)}
                        onChange={(checked) => updateSelectedNode({ activationCondition: checked ? {
                          mode: "all",
                          rules: [{ id: `condition-${Date.now()}`, fieldId: conditionFieldOptions[0]?.value ?? "", operator: "eq", value: "" }],
                        } : undefined })}
                      />
                    </div>
                    {selectedNode.data.activationCondition ? (
                      <>
                        <Segmented
                          block
                          value={selectedNode.data.activationCondition.mode}
                          options={[{ label: "全部满足（AND）", value: "all" }, { label: "任一满足（OR）", value: "any" }]}
                          onChange={(mode) => updateSelectedNode({ activationCondition: { ...selectedNode.data.activationCondition!, mode: mode as "all" | "any" } })}
                        />
                        <div className="condition-rule-list">
                          {selectedNode.data.activationCondition.rules.map((rule) => {
                            const field = conditionFieldOptions.find((item) => item.value === rule.fieldId);
                            const operators: ConditionOperator[] = field?.type === "checkbox"
                              ? ["contains", "not-contains", "empty", "not-empty"]
                              : field?.type === "text"
                                ? ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not-empty"]
                                : ["eq", "neq", "empty", "not-empty"];
                            const updateRule = (patch: Partial<typeof rule>) => updateSelectedNode({ activationCondition: {
                              ...selectedNode.data.activationCondition!,
                              rules: selectedNode.data.activationCondition!.rules.map((item) => item.id === rule.id ? { ...item, ...patch } : item),
                            } });
                            return <div className="condition-rule" key={rule.id}>
                              <Select showSearch value={rule.fieldId || undefined} placeholder="选择字段" options={conditionFieldOptions} onChange={(fieldId) => updateRule({ fieldId, operator: "eq", value: "" })} />
                              <Select value={rule.operator} options={operators.map((operator) => ({ value: operator, label: conditionOperatorLabel(operator) }))} onChange={(operator) => updateRule({ operator })} />
                              {!["empty", "not-empty"].includes(rule.operator) && (field?.options?.length
                                ? <Select value={typeof rule.value === "string" ? rule.value || undefined : undefined} placeholder="选择比较值" options={field.options.map((value) => ({ value, label: value }))} onChange={(value) => updateRule({ value })} />
                                : <Input value={typeof rule.value === "string" ? rule.value : ""} placeholder="输入比较值" onChange={(event) => updateRule({ value: event.target.value })} />)}
                              <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除条件" onClick={() => updateSelectedNode({ activationCondition: { ...selectedNode.data.activationCondition!, rules: selectedNode.data.activationCondition!.rules.filter((item) => item.id !== rule.id) } })} />
                            </div>;
                          })}
                        </div>
                        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => updateSelectedNode({ activationCondition: {
                          ...selectedNode.data.activationCondition,
                          mode: selectedNode.data.activationCondition?.mode ?? "all",
                          rules: [...(selectedNode.data.activationCondition?.rules ?? []), { id: `condition-${Date.now()}`, fieldId: conditionFieldOptions[0]?.value ?? "", operator: "eq", value: "" }],
                        } })}>添加条件</Button>
                      </>
                    ) : null}
                  </div>
                </>
              )}

              {selectedNode.data.kind === "end" && (
                <Alert
                  type="success"
                  showIcon
                  message="结束条件"
                  description="存在多个前置节点时，系统会自动按 AND 汇聚处理：全部前置节点通过、确认或因条件不满足而跳过后才会到达。"
                />
              )}

              {(selectedNode.data.kind === "approval" || selectedNode.data.kind === "end") && selectedEmailNotification ? (
                <>
                  <Divider />
                  <div className="property-field email-notification-editor">
                    <div className="property-switch-row">
                      <div>
                        <Text strong><MailOutlined /> 邮件通知</Text>
                        <Text type="secondary">
                          {selectedNode.data.kind === "approval" ? "进入本节点并激活待办后发送。" : "流程到达结束节点时发送。"}
                        </Text>
                      </div>
                      <Switch
                        checked={selectedEmailNotification.enabled}
                        onChange={(enabled) => updateSelectedEmailNotification({ enabled })}
                      />
                    </div>
                    {selectedEmailNotification.enabled ? (
                      <div className="email-recipient-settings">
                        <Text strong>通知对象</Text>
                        <div className="email-recipient-options">
                          {selectedNode.data.kind === "approval" ? (
                            <Checkbox
                              checked={selectedEmailNotification.notifyReviewers}
                              onChange={(event) => updateSelectedEmailNotification({ notifyReviewers: event.target.checked })}
                            >
                              本节点审核人
                            </Checkbox>
                          ) : (
                            <Checkbox
                              checked={selectedEmailNotification.notifyInitiator}
                              onChange={(event) => updateSelectedEmailNotification({ notifyInitiator: event.target.checked })}
                            >
                              流程发起人
                            </Checkbox>
                          )}
                        </div>
                        <label className="property-field email-extra-users">
                          <span className="property-field__label">额外通知用户</span>
                          <Select
                            mode="multiple"
                            showSearch
                            allowClear
                            optionFilterProp="label"
                            maxTagCount="responsive"
                            placeholder="按姓名或邮箱选择用户"
                            value={selectedEmailNotification.extraUserIds}
                            options={extraEmailUserOptions}
                            onChange={(extraUserIds) => updateSelectedEmailNotification({ extraUserIds })}
                          />
                          <Text type="secondary" className="property-field__help">邮件发送到用户资料中维护的邮箱；停用或无邮箱用户不可新增。</Text>
                        </label>
                        {!selectedEmailNotification.notifyReviewers
                          && !selectedEmailNotification.notifyInitiator
                          && !selectedEmailNotification.extraUserIds.length ? (
                            <Alert type="warning" showIcon message="请至少选择一类邮件收件人" />
                          ) : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div className="property-form__footer">
                <Button danger icon={<DeleteOutlined />} onClick={deleteSelectedNode}>
                  删除此节点
                </Button>
              </div>
            </div>
          ) : (
            <div className="property-form">
              <label className="property-field">
                <span className="property-field__label">流程名称</span>
                <Input
                  value={meta.name}
                  onChange={(event) => updateFlowName(event.target.value)}
                />
              </label>
              <label className="property-field">
                <span className="property-field__label">流程编号</span>
                <Input value={meta.code} disabled />
                <Text type="secondary" className="property-field__help">
                  流程编号由后台自动生成。
                </Text>
              </label>
              <Divider />
              <div className="property-field">
                <span className="property-field__label">驳回后的处理方式</span>
                <Text type="secondary" className="property-field__help property-field__help--above">
                  此规则随流程版本发布，新配置只影响之后发起的实例。
                </Text>
                <Radio.Group
                  className="rejection-rule-options"
                  value={meta.rejectionHandling}
                  onChange={(event) =>
                    setMeta((current) => ({
                      ...current,
                      rejectionHandling: event.target.value as FlowMeta["rejectionHandling"],
                    }))
                  }
                >
                  {rejectionHandlingOptions.map((option) => (
                    <Radio key={option.value} value={option.value}>
                      <span className="rejection-rule-option__content">
                        <Text strong>{option.label}</Text>
                        <Text type="secondary">{option.description}</Text>
                      </span>
                    </Radio>
                  ))}
                </Radio.Group>
              </div>
              <div className="property-version-card">
                <span>
                  <Text type="secondary">当前版本</Text>
                  <Text strong>{meta.version}</Text>
                </span>
                <span>
                  <Text type="secondary">来源版本</Text>
                  <Text strong>{meta.basedOn}</Text>
                </span>
              </div>
              <Alert
                type="info"
                showIcon
                message="正在编辑完整版本快照"
                description="未发布且没有流程实例的版本可以直接保存；发布后需先取消发布，已有实例后则只能复制新建版本。"
              />
            </div>
          )}
        </aside>
      </div>

      <Drawer
        title="流程检查结果"
        width={480}
        open={validationOpen}
        onClose={() => setValidationOpen(false)}
        footer={
          <div className="validation-drawer__footer">
            <Text type={allValidationPassed ? "success" : "danger"}>
              {allValidationPassed ? `${validationResults.length} 项规则全部通过` : "请先修正未通过项"}
            </Text>
            <Space>
              <Button onClick={() => setValidationOpen(false)}>返回设计器</Button>
              <Button
                type="primary"
                disabled={!allValidationPassed}
                onClick={() => {
                  setValidationOpen(false);
                  goNext();
                }}
              >
                进入发布页面
              </Button>
            </Space>
          </div>
        }
      >
        <Alert
          type={allValidationPassed ? "success" : "warning"}
          showIcon
          message={allValidationPassed ? "流程结构校验通过" : "流程暂不满足发布条件"}
          description="通过后进入统一发布页面，当前正在运行的流程实例不会受到影响。"
          className="validation-drawer__summary"
        />
        <div className="validation-list">
          {validationResults.map((result) => (
            <div
              key={result.key}
              className={`validation-item ${result.pass ? "is-pass" : "is-fail"}`}
            >
              <span className="validation-item__icon">
                {result.pass ? <CheckCircleFilled /> : <CloseCircleFilled />}
              </span>
              <div>
                <Text strong>{result.title}</Text>
                <Text type="secondary">{result.detail}</Text>
              </div>
            </div>
          ))}
        </div>
      </Drawer>

    </div>
  );
};

export const FlowDesignerPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { definitionId = "" } = useParams<{ definitionId: string }>();
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === definitionId),
  );
  const versionId = searchParams.get("versionId") ?? definition?.versions[0]?.id ?? "";
  const version = definition?.versions.find((item) => item.id === versionId);
  const editableFieldOptions = useMemo<EditableFieldOption[]>(() => {
    const fields = version?.snapshot.form.fields ?? [];
    return fields.flatMap((field) => field.type === "table"
      ? field.inputStage === "reviewer"
        ? [{ value: field.id, label: `${field.label}（整表）` }]
        : (field.columns ?? []).filter((column) => column.reviewEditable).map((column) => ({ value: `${field.id}.${column.id}`, label: `${field.label} / ${column.label}` }))
      : field.reviewEditable ? [{ value: field.id, label: field.label }] : []);
  }, [version?.snapshot.form.fields]);
  const conditionFieldOptions = useMemo<ConditionFieldOption[]>(() => (version?.snapshot.form.fields ?? [])
    .filter((field: StoredDesignerField) => !["attachment", "table", "richtext"].includes(field.type))
    .map((field) => ({ value: field.id, label: field.label, type: field.type, options: field.options, inputStage: field.inputStage ?? "initiator", required: field.required })), [version?.snapshot.form.fields]);
  const starterGroups = version?.basic.starterGroups ?? [];
  const fallbackMeta = useMemo<FlowMeta>(
    () => ({
      ...genericInitialMeta,
      name: version?.basic.name ?? definition?.name ?? genericInitialMeta.name,
      code: definition?.code ?? genericInitialMeta.code,
      version: version?.version ?? genericInitialMeta.version,
      basedOn: version?.basedOn ?? "全新流程",
      status: definition && version ? getVersionStatus(definition, version.id) : "校验未通过",
    }),
    [definition, version],
  );
  const initialDraft = useMemo(
    () => {
      const stored = version?.snapshot.flow;
      const fallbackTopology = createGenericDraft(starterGroups);
      if (!stored?.nodes.length) return { ...fallbackTopology, meta: fallbackMeta };
      return {
        nodes: stored.nodes.map((node, index) => ({
          id: node.id,
          type: "processNode" as const,
          position: node.position ?? { x: 80 + (index % 3) * 300, y: 120 + Math.floor(index / 3) * 190 },
          data: {
            kind: node.data?.kind ?? "approval",
            label: node.data?.label ?? "未命名节点",
            description: node.data?.description ?? "",
            permissionGroup: node.data?.permissionGroup,
            permissionGroups: node.data?.permissionGroups,
            specifyAssignee: node.data?.specifyAssignee,
            editableFields: node.data?.editableFields ?? [],
            handlingMode: (node.data?.kind ?? "approval") === "approval" ? node.data?.handlingMode ?? "approval" : node.data?.handlingMode,
            allowRepeatedEditing: (node.data?.kind ?? "approval") === "approval"
              ? Boolean(node.data?.allowRepeatedEditing && node.data?.editableFields?.length)
              : false,
            activationCondition: node.data?.activationCondition,
            emailNotification: (node.data?.kind ?? "approval") === "approval" || node.data?.kind === "end"
              ? normalizeEmailNotification(node.data?.kind ?? "approval", node.data?.emailNotification)
              : undefined,
          },
        })),
        edges: stored.edges.map((edge, index) => ({ id: edge.id ?? `edge-${index}`, source: edge.source, target: edge.target, ...edgeDefaults })),
        meta: { ...fallbackMeta, rejectionHandling: stored.meta?.rejectionHandling ?? "resubmit-or-close" },
      };
    },
    [fallbackMeta, starterGroups, version?.snapshot.flow],
  );

  if (!definition) {
    return (
      <div className="flow-designer-page flow-designer-page--empty">
        <Alert
          type="error"
          showIcon
          message="流程不存在"
          description="请返回流程管理重新选择需要编辑的流程。"
          action={<AppBackButton onClick={() => navigate("/admin/processes")} />}
        />
      </div>
    );
  }

  if (!version) {
    return (
      <div className="flow-designer-page flow-designer-page--empty">
        <Alert
          type="error"
          showIcon
          message="版本不存在"
          description="流程设计必须绑定到一个明确的正式版本。"
          action={<AppBackButton onClick={() => navigate(`/admin/processes/${definitionId}/versions`)} />}
        />
      </div>
    );
  }

  if (!canEditVersion(definition, version)) {
    return (
      <div className="flow-designer-page flow-designer-page--empty">
        <Alert
          type="info"
          showIcon
          message={`${version.version} 为只读版本`}
          description={definition.publishedVersionId === version.id
            ? "已发布版本不能直接修改。没有实例时可先在版本记录中取消发布；已有实例时请复制新建版本。"
            : "该版本已经创建过流程实例，只能查看或复制新建版本。"}
          action={<AppBackButton onClick={() => navigate(`/admin/processes/${definitionId}/versions`)} />}
        />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <DesignerWorkspace
        key={`${definitionId}-${versionId}`}
        initialDraft={initialDraft}
        definitionId={definitionId}
        versionId={versionId}
        editableFieldOptions={editableFieldOptions}
        conditionFieldOptions={conditionFieldOptions}
        starterGroups={starterGroups}
      />
    </ReactFlowProvider>
  );
};

export default FlowDesignerPage;
