import {
  useCallback,
  useEffect,
  useMemo,
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
// @ts-ignore -- Vite resolves package CSS side-effect imports at build time.
import "@xyflow/react/dist/style.css";
import {
  ApartmentOutlined,
  AuditOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  FilePdfOutlined,
  InfoCircleOutlined,
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
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import {
  ProcessWizardNextButton,
  ProcessWizardPreviousButton,
} from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { workflowPermissionGroupOptions } from "../data/workflowPermissionGroups";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  FLOW_DESIGNER_STORAGE_KEY_PREFIX,
  buildFlowLevels,
  getReviewEditableFieldOptions,
  type EditableFieldOption,
} from "../utils/designerStorage";
// @ts-ignore -- Vite resolves local CSS side-effect imports at build time.
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
}

type DesignerNode = Node<FlowNodeData, "processNode">;
type DesignerEdge = Edge;

interface FlowMeta {
  name: string;
  code: string;
  version: string;
  basedOn: string;
  status: "草稿" | "已发布";
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
    label: "重新发布或关闭",
    description: "进入驳回待处理，由发布方修改后重新发布，或直接关闭流程。",
  },
  {
    value: "resubmit-only",
    label: "仅允许重新发布",
    description: "进入驳回待处理，发布方修改后必须重新发布，不能在此状态关闭。",
  },
  {
    value: "auto-close",
    label: "自动关闭流程",
    description: "驳回结果提交后立即关闭流程，不再等待发布方处理。",
  },
];

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
    },
  },
  {
    id: "end-approved",
    type: "processNode",
    position: { x: 684, y: 252 },
    data: {
      kind: "end",
      label: "审核完成",
      description: "全部审核通过，流程结束",
      editableFields: [],
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
  status: "草稿",
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
      },
    },
    {
      id: "end-default",
      type: "processNode",
      position: { x: 680, y: 220 },
      data: {
        kind: "end",
        label: "流程结束",
        description: "全部前置审批通过后结束",
        editableFields: [],
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
  ];
};

interface DesignerWorkspaceProps {
  initialDraft: StoredDraft;
  definitionId: string;
  editableFieldOptions: EditableFieldOption[];
  starterGroups: string[];
}

const DesignerWorkspace = ({ initialDraft, definitionId, editableFieldOptions, starterGroups }: DesignerWorkspaceProps) => {
  const navigate = useNavigate();
  const markFlowConfigured = useProcessDefinitionStore((state) => state.markFlowConfigured);
  const draftBasic = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === definitionId)?.draft?.basic,
  );
  const updateDraftBasic = useProcessDefinitionStore((state) => state.updateDraftBasic);
  const storageKey = `${FLOW_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`;
  const [nodes, setNodes, onNodesChange] = useNodesState<DesignerNode>(initialDraft.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DesignerEdge>(initialDraft.edges);
  const [meta, setMeta] = useState<FlowMeta>(initialDraft.meta);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    initialDraft.nodes.find((node) => node.data.kind === "approval")?.id ?? null,
  );
  const [propertyMode, setPropertyMode] = useState<"flow" | "node">("node");
  const [validationOpen, setValidationOpen] = useState(false);
  const [autoSaved, setAutoSaved] = useState(true);
  const { fitView, screenToFlowPosition } = useReactFlow<DesignerNode, DesignerEdge>();

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  );
  const validationResults = useMemo(
    () => runValidation(nodes, edges, editableFieldOptions),
    [edges, editableFieldOptions, nodes],
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
    setAutoSaved(false);
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(storageKey, JSON.stringify({ nodes, edges, meta }));
      setAutoSaved(true);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [edges, meta, nodes, storageKey]);

  useEffect(() => {
    const allowed = new Set(editableFieldOptions.map((option) => option.value));
    const labelToValue = new Map(editableFieldOptions.map((option) => [option.label, option.value]));
    setNodes((currentNodes) => currentNodes.map((node) => {
      const normalizedFields = node.data.editableFields
        .map((field) => allowed.has(field) ? field : labelToValue.get(field))
        .filter((field): field is string => Boolean(field));
      const nextStarterGroups = node.data.kind === "start" ? starterGroups : node.data.permissionGroups;
      return normalizedFields.join("|") === node.data.editableFields.join("|")
        && (nextStarterGroups ?? []).join("|") === (node.data.permissionGroups ?? []).join("|")
        ? node
        : { ...node, data: { ...node.data, editableFields: normalizedFields, permissionGroups: nextStarterGroups } };
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

  const updateStarterGroups = (permissionGroups: string[]) => {
    updateSelectedNode({ permissionGroups });
    if (draftBasic) updateDraftBasic(definitionId, { ...draftBasic, starterGroups: permissionGroups });
  };

  const updateFlowName = (name: string) => {
    setMeta((current) => ({ ...current, name }));
    if (draftBasic) updateDraftBasic(definitionId, { ...draftBasic, name });
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

  const saveDraft = () => {
    const nextMeta = { ...meta, status: "草稿" as const, lastSavedAt: formatTime() };
    setMeta(nextMeta);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ nodes, edges, meta: nextMeta }),
    );
    markFlowConfigured(definitionId, nodes.length);
    setAutoSaved(true);
    message.success("草稿已保存，刷新页面后仍会保留");
  };

  const goNext = () => {
    if (!allValidationPassed) {
      setValidationOpen(true);
      message.warning("进入发布页面前还有流程结构问题需要处理");
      return;
    }
    const nextMeta = { ...meta, status: "草稿" as const, lastSavedAt: formatTime() };
    setMeta(nextMeta);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ nodes, edges, meta: nextMeta }),
    );
    markFlowConfigured(definitionId, nodes.length);
    navigate(`/admin/processes/${definitionId}/publish`);
  };

  return (
    <div className="flow-designer-page">
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
              <Text type="secondary">草稿版本 {meta.version}</Text>
              <Text type="secondary">{meta.version === meta.basedOn ? `撤回后编辑 ${meta.version}` : `基于已发布 ${meta.basedOn}`}</Text>
            </Space>
          </div>
        </div>
        <div className="flow-designer-toolbar__actions">
          <span className={`flow-designer-save-state ${autoSaved ? "is-saved" : ""}`}>
            <span className="flow-designer-save-state__dot" />
            {autoSaved ? `已保存 ${meta.lastSavedAt}` : "正在保存…"}
          </span>
          <ProcessWizardPreviousButton step="初始表单" onClick={() => navigate(`/admin/processes/${definitionId}/form`)} />
          <Button icon={<ApartmentOutlined />} onClick={autoLayout}>
            自动布局
          </Button>
          <Button icon={<SaveOutlined />} onClick={saveDraft}>
            保存草稿
          </Button>
          <Button icon={<SafetyCertificateOutlined />} onClick={() => setValidationOpen(true)}>
            检查流程
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
                同一节点引出多条审核连线时自动并行；多条连线汇入同一节点时，等待全部前置通过后继续。
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
                      options={workflowPermissionGroupOptions}
                      onChange={updateStarterGroups}
                    />
                  ) : (
                    <Select
                      value={selectedNode.data.permissionGroup}
                      placeholder="请选择审核流程权限组"
                      showSearch
                      allowClear
                      options={workflowPermissionGroupOptions}
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
                      onChange={(values) =>
                        updateSelectedNode({ editableFields: values.map(String) })
                      }
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
                  </div>
                </>
              )}

              {selectedNode.data.kind === "end" && (
                <Alert
                  type="success"
                  showIcon
                  message="结束条件"
                  description="存在多个前置节点时，系统会自动按 AND 汇聚处理：全部前置审批通过后才会到达。"
                />
              )}

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
                  <Text type="secondary">当前草稿</Text>
                  <Text strong>{meta.version}</Text>
                </span>
                <span>
                  <Text type="secondary">{meta.version === meta.basedOn ? "编辑方式" : "来源版本"}</Text>
                  <Text strong>{meta.version === meta.basedOn ? "原版本号保持不变" : meta.basedOn}</Text>
                </span>
              </div>
              <Alert
                type="warning"
                showIcon
                message={meta.version === meta.basedOn ? "当前版本已撤回发布" : "发布后版本不可修改"}
                description={meta.version === meta.basedOn
                  ? "该版本尚无流程实例，重新发布后继续使用当前版本号；编辑期间流程暂停发起。"
                  : "已有实例的版本再次编辑时会基于当前已发布版本创建新草稿；新版本仅影响新发起的实例。"}
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
  const { definitionId = "" } = useParams<{ definitionId: string }>();
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === definitionId),
  );
  const editableFieldOptions = useMemo(() => getReviewEditableFieldOptions(definitionId), [definitionId]);
  const starterGroups = definition?.draft?.basic.starterGroups ?? [];
  const fallbackMeta = useMemo<FlowMeta>(
    () => ({
      ...genericInitialMeta,
      name: definition?.draft?.basic.name ?? definition?.name ?? genericInitialMeta.name,
      code: definition?.code ?? genericInitialMeta.code,
      version: definition?.draft?.version ?? genericInitialMeta.version,
      basedOn: definition?.draft?.basedOn ?? "全新流程",
    }),
    [definition],
  );
  const initialDraft = useMemo(
    () => {
      const fallbackTopology = definitionId === "pdf-review"
        ? { nodes: initialNodes, edges: initialEdges }
        : createGenericDraft(starterGroups);
      return readStoredDraft(
        `${FLOW_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`,
        fallbackMeta,
        fallbackTopology,
      );
    },
    [definitionId, fallbackMeta, starterGroups],
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

  return (
    <ReactFlowProvider>
      <DesignerWorkspace
        key={`${definitionId}-${definition.draft?.id ?? "no-draft"}`}
        initialDraft={initialDraft}
        definitionId={definitionId}
        editableFieldOptions={editableFieldOptions}
        starterGroups={starterGroups}
      />
    </ReactFlowProvider>
  );
};

export default FlowDesignerPage;
