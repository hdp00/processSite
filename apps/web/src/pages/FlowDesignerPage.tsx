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
  RedoOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
  TeamOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Input,
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
import { cacheProcessVersion } from "../api/entityCache";
import { flowPilotApi } from "../api/flowPilotApi";
import {
  ProcessWizardNextButton,
  ProcessWizardPreviousButton,
} from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { useUndoRedoHistory } from "../hooks/useUndoRedoHistory";
import { effectiveGroupMemberIds, resolveWorkflowGroupLabels, useIdentityStore } from "../state/useIdentityStore";
import {
  canEditVersion,
  getVersionStatus,
  useProcessDefinitionStore,
  type VersionStatus,
} from "../state/useProcessDefinitionStore";
import {
  buildFlowLevels,
  conditionOperatorLabel,
  normalizeDesignerInputPermission,
  type DesignerInputPermission,
  type EditableFieldOption,
  type ApprovalHandlingMode,
  type ConditionOperator,
  type StoredDesignerField,
  type StoredFlowDesignerSnapshot,
  type StoredNodeCondition,
  type StoredNodeEmailNotification,
} from "../utils/designerStorage";
import { flattenDesignerChoiceOptions, type DesignerChoiceOption } from "../utils/designerOptions";
import { formatDisplayDateTime } from "../utils/domainTime";
import {
  validateApprovalFlow,
  type ProcessValidationContext,
} from "../utils/processDefinitionValidation";
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
  choiceOptions?: DesignerChoiceOption[];
  inputStage?: DesignerInputPermission;
  required?: boolean;
}

interface EmailUserOption {
  value: string;
  label: string;
  email: string;
  searchText: string;
  disabled: boolean;
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
    description: "进入驳回待处理，由发起方修改后重新提交；关闭权限组也可直接关闭流程。",
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

const normalizeActivationCondition = (
  condition?: StoredNodeCondition,
): StoredNodeCondition | undefined => {
  if (!condition || typeof condition !== "object") return undefined;
  const source = condition as Partial<StoredNodeCondition>;
  const rules = Array.isArray(source.rules)
    ? source.rules.filter((rule) => Boolean(rule && typeof rule === "object")).map((rule, index) => ({
        id: typeof rule.id === "string" && rule.id ? rule.id : `condition-${index + 1}`,
        fieldId: typeof rule.fieldId === "string" ? rule.fieldId : "",
        operator: rule.operator ?? "eq",
        value: rule.value ?? "",
      }))
    : [];
  return { mode: source.mode === "any" ? "any" : "all", rules };
};

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
        description: "",
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
        description: "",
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
        description: "",
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

const flowDraftFingerprint = (
  nodes: DesignerNode[],
  edges: DesignerEdge[],
  meta: FlowMeta,
) => JSON.stringify({
  name: meta.name,
  rejectionHandling: meta.rejectionHandling,
  nodes: nodes.map((node) => ({
    id: node.id,
    position: node.position,
    data: node.data,
  })),
  edges: edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  })),
});

const ProcessNode = ({ data, selected }: NodeProps<DesignerNode>) => {
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const meta = kindMeta[data.kind];
  const showTarget = data.kind !== "start";
  const showSource = data.kind !== "end";
  const groups = data.kind === "start" ? data.permissionGroups : data.permissionGroup ? [data.permissionGroup] : [];
  const groupLabel = resolveWorkflowGroupLabels(workflowGroups, groups ?? []).join("、");

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
          {data.kind === "approval" && normalizeActivationCondition(data.activationCondition)?.rules.length ? (
            <Tooltip title={`${normalizeActivationCondition(data.activationCondition)?.mode === "all" ? "全部" : "任一"}条件满足时执行`}>
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
  fields: StoredDesignerField[],
  context: ProcessValidationContext,
): ValidationResult[] => validateApprovalFlow(nodes, edges, fields, context);

interface DesignerWorkspaceProps {
  initialDraft: StoredDraft;
  definitionId: string;
  versionId: string;
  editableFieldOptions: EditableFieldOption[];
  conditionFieldOptions: ConditionFieldOption[];
  formFields: StoredDesignerField[];
  starterGroups: string[];
}

const DesignerWorkspace = ({ initialDraft, definitionId, versionId, editableFieldOptions, conditionFieldOptions, formFields, starterGroups }: DesignerWorkspaceProps) => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const users = useIdentityStore((state) => state.users);
  const [versionEtag, setVersionEtag] = useState<string>();
  const starterGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("发起"))
    .map((group) => ({ value: group.id, label: group.name }));
  const approvalGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("审批/受理"))
    .map((group) => ({ value: group.id, label: group.name }));
  const extraEmailUserOptions: EmailUserOption[] = users.map((user) => {
    const email = "email" in user ? String(user.email ?? "").trim() : "";
    const unavailable = user.status !== "启用" || !email;
    return {
      value: user.id,
      label: user.name,
      disabled: unavailable,
      email,
      searchText: `${user.name} ${email}`,
    };
  });
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
  const draftFingerprint = useMemo(
    () => flowDraftFingerprint(nodes, edges, meta),
    [edges, meta, nodes],
  );
  const savedFingerprint = useRef(draftFingerprint);
  const currentFingerprint = useRef(draftFingerprint);
  currentFingerprint.current = draftFingerprint;
  const designerHistoryValue = useMemo(
    () => ({
      nodes: nodes.map((node) => ({
        ...node,
        selected: undefined,
        dragging: undefined,
        measured: undefined,
      })),
      edges: edges.map((edge) => ({ ...edge, selected: undefined })),
      meta: { ...meta, lastSavedAt: "" },
    }),
    [edges, meta, nodes],
  );
  const { canUndo, canRedo, undo, redo } = useUndoRedoHistory(
    designerHistoryValue,
    (snapshot) => {
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      setMeta((current) => ({ ...snapshot.meta, lastSavedAt: current.lastSavedAt }));
      setSelectedNodeId((current) => snapshot.nodes.some((node) => node.id === current)
        ? current
        : snapshot.nodes.find((node) => node.data.kind === "approval")?.id ?? null);
    },
    { historyKey: `${definitionId}:${versionId}:flow` },
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  );
  const selectedEmailNotification = selectedNode && (selectedNode.data.kind === "approval" || selectedNode.data.kind === "end")
    ? normalizeEmailNotification(selectedNode.data.kind, selectedNode.data.emailNotification)
    : undefined;
  const selectedActivationCondition = selectedNode?.data.kind === "approval"
    ? normalizeActivationCondition(selectedNode.data.activationCondition)
    : undefined;
  const selectedExtraEmailUsers = selectedEmailNotification?.extraUserIds
    .map((userId) => extraEmailUserOptions.find((option) => option.value === userId))
    .filter((option): option is EmailUserOption => Boolean(option)) ?? [];
  const validationResults = useMemo(
    () => runValidation(nodes, edges, formFields, {
      workflowGroups,
      effectiveMemberIds: effectiveGroupMemberIds,
    }),
    [edges, formFields, nodes, workflowGroups],
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
    setAutoSaved(draftFingerprint === savedFingerprint.current);
  }, [draftFingerprint]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [redo, undo]);

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
      const nextActivationCondition = node.data.kind === "approval"
        ? normalizeActivationCondition(node.data.activationCondition)
        : undefined;
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
      const activationConditionUnchanged = nextActivationCondition === undefined && node.data.activationCondition === undefined
        || Boolean(nextActivationCondition
          && node.data.activationCondition
          && nextActivationCondition.mode === node.data.activationCondition.mode
          && nextActivationCondition.rules.length === node.data.activationCondition.rules?.length
          && nextActivationCondition.rules.every((rule, index) => {
            const current = node.data.activationCondition?.rules?.[index];
            return current
              && rule.id === current.id
              && rule.fieldId === current.fieldId
              && rule.operator === current.operator
              && JSON.stringify(rule.value) === JSON.stringify(current.value);
          }));
      return normalizedFields.join("|") === node.data.editableFields.join("|")
        && (nextStarterGroups ?? []).join("|") === (node.data.permissionGroups ?? []).join("|")
        && nextRepeatedEditing === Boolean(node.data.allowRepeatedEditing)
        && nextHandlingMode === node.data.handlingMode
        && activationConditionUnchanged
        && emailNotificationUnchanged
        ? node
        : { ...node, data: {
            ...node.data,
            editableFields: normalizedFields,
            permissionGroups: nextStarterGroups,
            handlingMode: nextHandlingMode,
            allowRepeatedEditing: nextRepeatedEditing,
            activationCondition: nextActivationCondition,
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
          description: "",
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

  useEffect(() => {
    let cancelled = false;
    void flowPilotApi.definitions.versionResource(definitionId, versionId).then((resource) => {
      if (cancelled) return;
      cacheProcessVersion(definitionId, resource.data);
      setVersionEtag(resource.etag);
    }).catch((error) => {
      if (!cancelled) message.error(error instanceof Error ? error.message : "流程版本加载失败");
    });
    return () => { cancelled = true; };
  }, [definitionId, versionId]);

  const saveVersion = async () => {
    const requestedSavedAt = new Date().toISOString();
    const nextSavedFingerprint = flowDraftFingerprint(nodes, edges, meta);
    const startGroups = nodes.find((node) => node.data.kind === "start")?.data.permissionGroups ?? starterGroups;
    try {
      if (!versionEtag) throw new Error("流程版本尚未加载完成，请稍后重试");
      const saved = await flowPilotApi.definitions.saveFlowDesignerResource(definitionId, versionId, {
        basicPatch: { name: meta.name, starterGroups: startGroups },
        flow: {
          nodes,
          edges,
          savedAt: requestedSavedAt,
          meta: { rejectionHandling: meta.rejectionHandling },
        } as StoredFlowDesignerSnapshot,
      }, versionEtag);
      cacheProcessVersion(definitionId, saved.data.version);
      setVersionEtag(saved.etag);
      setMeta((current) => ({
        ...current,
        lastSavedAt: formatDisplayDateTime(
          saved.data.version.snapshot.flow.savedAt ?? saved.data.version.updatedAt ?? requestedSavedAt,
          "尚未保存",
        ),
      }));
      savedFingerprint.current = nextSavedFingerprint;
      setAutoSaved(currentFingerprint.current === nextSavedFingerprint);
      message.success("版本已保存，并已自动更新校验结果");
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : "该版本当前不可编辑，请返回版本记录确认状态");
      return false;
    }
  };

  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty: !autoSaved,
    onSave: saveVersion,
    title: "审批流程尚未保存",
    description: "可以先保存节点、连线和流程规则再离开，也可以放弃本次修改。",
  });

  const goPrevious = async () => {
    if (!autoSaved && !await saveVersion()) return;
    allowNextNavigation();
    navigate(`/admin/processes/${definitionId}/form?versionId=${versionId}`);
  };

  const goNext = async () => {
    if (!autoSaved && !await saveVersion()) return;
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
          <span className={`flow-designer-save-state ${autoSaved && meta.lastSavedAt !== "尚未保存" ? "is-saved" : ""}`}>
            <span className="flow-designer-save-state__dot" />
            {!autoSaved
              ? "有未保存修改"
              : meta.lastSavedAt === "尚未保存"
                ? "尚未保存"
                : `版本已保存 · ${formatDisplayDateTime(meta.lastSavedAt)}`}
          </span>
          <ProcessWizardPreviousButton step="初始表单" onClick={goPrevious} />
          <Space.Compact>
            <Tooltip title="撤销（Ctrl+Z）">
              <Button aria-label="撤销" disabled={!canUndo} icon={<UndoOutlined />} onClick={undo} />
            </Tooltip>
            <Tooltip title="重做（Ctrl+Shift+Z / Ctrl+Y）">
              <Button aria-label="重做" disabled={!canRedo} icon={<RedoOutlined />} onClick={redo} />
            </Tooltip>
          </Space.Compact>
          <Button icon={<ApartmentOutlined />} onClick={autoLayout}>
            自动布局
          </Button>
          <Button icon={<SaveOutlined />} disabled={!versionEtag} onClick={saveVersion}>
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
                { label: "节点属性", value: "node", disabled: !selectedNode },
                { label: "流程属性", value: "flow" },
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

                  {editableFieldOptions.length ? (
                    <>
                      <div className="property-field">
                        <span className="property-field__label">审核人可输入字段</span>
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
                          <Text type="secondary" className="property-field__help">请先选择至少一个审核人可输入字段。</Text>
                        ) : null}
                      </div>

                      <Divider />
                    </>
                  ) : null}

                  <div className="property-field condition-editor">
                    <div className="property-switch-row">
                      <div>
                        <Text strong>按条件执行</Text>
                        <Text type="secondary">条件不满足时自动跳过该节点，并视为已满足汇聚条件。</Text>
                      </div>
                      <Switch
                        checked={Boolean(selectedActivationCondition)}
                        disabled={!conditionFieldOptions.length}
                        onChange={(checked) => updateSelectedNode({ activationCondition: checked ? {
                          mode: "all",
                          rules: [{ id: `condition-${Date.now()}`, fieldId: conditionFieldOptions[0]?.value ?? "", operator: "eq", value: "" }],
                        } : undefined })}
                      />
                    </div>
                    {!conditionFieldOptions.length ? (
                      <Text type="secondary" className="property-field__help">初始表单中没有可用于判断条件的字段。</Text>
                    ) : null}
                    {selectedActivationCondition ? (
                      <>
                        <Segmented
                          block
                          value={selectedActivationCondition.mode}
                          options={[{ label: "全部满足（AND）", value: "all" }, { label: "任一满足（OR）", value: "any" }]}
                          onChange={(mode) => updateSelectedNode({ activationCondition: { ...selectedActivationCondition, mode: mode as "all" | "any" } })}
                        />
                        <div className="condition-rule-list">
                          {selectedActivationCondition.rules.map((rule) => {
                            const field = conditionFieldOptions.find((item) => item.value === rule.fieldId);
                            const operators: ConditionOperator[] = field?.type === "checkbox"
                              ? ["contains", "not-contains", "empty", "not-empty"]
                              : field?.type === "text"
                                ? ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not-empty"]
                                : ["eq", "neq", "empty", "not-empty"];
                            const updateRule = (patch: Partial<typeof rule>) => updateSelectedNode({ activationCondition: {
                              ...selectedActivationCondition,
                              rules: selectedActivationCondition.rules.map((item) => item.id === rule.id ? { ...item, ...patch } : item),
                            } });
                            return <div className="condition-rule" key={rule.id}>
                              <Select
                                showSearch
                                title={field?.label}
                                value={rule.fieldId || undefined}
                                placeholder="选择字段"
                                popupMatchSelectWidth={360}
                                options={conditionFieldOptions}
                                optionRender={(option) => <span className="condition-field-option" title={String(option.label)}>{option.label}</span>}
                                onChange={(fieldId) => {
                                  const nextField = conditionFieldOptions.find((option) => option.value === fieldId);
                                  updateRule({ fieldId, operator: "eq", value: nextField?.choiceOptions?.[0]?.id ?? "" });
                                }}
                              />
                              <Select value={rule.operator} options={operators.map((operator) => ({ value: operator, label: conditionOperatorLabel(operator) }))} onChange={(operator) => updateRule({ operator })} />
                              {!["empty", "not-empty"].includes(rule.operator) && (field?.choiceOptions?.length
                                ? <Select value={typeof rule.value === "string" ? rule.value || undefined : undefined} placeholder="选择比较值" options={field.choiceOptions.map((option) => ({ value: option.id, label: option.label }))} onChange={(value) => updateRule({ value })} />
                                : <Input value={typeof rule.value === "string" ? rule.value : ""} placeholder="输入比较值" onChange={(event) => updateRule({ value: event.target.value })} />)}
                              <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除条件" onClick={() => updateSelectedNode({ activationCondition: { ...selectedActivationCondition, rules: selectedActivationCondition.rules.filter((item) => item.id !== rule.id) } })} />
                            </div>;
                          })}
                        </div>
                        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => updateSelectedNode({ activationCondition: {
                          ...selectedActivationCondition,
                          rules: [...selectedActivationCondition.rules, { id: `condition-${Date.now()}`, fieldId: conditionFieldOptions[0]?.value ?? "", operator: "eq", value: "" }],
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
                  title="结束条件"
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
                            optionFilterProp="searchText"
                            maxTagCount={2}
                            maxTagPlaceholder={(omittedValues) => `另 ${omittedValues.length} 人`}
                            placeholder="按姓名或邮箱选择用户"
                            value={selectedEmailNotification.extraUserIds}
                            options={extraEmailUserOptions}
                            optionRender={(option) => (
                              <div className="email-user-option">
                                <Text strong>{option.data.label}</Text>
                                <Text type="secondary" ellipsis>{option.data.email || "未维护邮箱"}</Text>
                              </div>
                            )}
                            onChange={(extraUserIds) => updateSelectedEmailNotification({ extraUserIds })}
                          />
                          <Text type="secondary" className="property-field__help">邮件发送到用户资料中维护的邮箱；停用或无邮箱用户不可新增。</Text>
                          {selectedExtraEmailUsers.length ? (
                            <div className="email-selected-users">
                              <div className="email-selected-users__summary">
                                <Text strong>已选择 {selectedExtraEmailUsers.length} 人</Text>
                                <Text type="secondary">姓名与邮箱</Text>
                              </div>
                              <div className="email-selected-users__list">
                                {selectedExtraEmailUsers.map((user) => (
                                  <div className="email-selected-user" key={user.value}>
                                    <Text strong>{user.label}</Text>
                                    <Text type="secondary" ellipsis={{ tooltip: user.email }}>{user.email}</Text>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </label>
                        {!selectedEmailNotification.notifyReviewers
                          && !selectedEmailNotification.notifyInitiator
                          && !selectedEmailNotification.extraUserIds.length ? (
                            <Alert type="warning" showIcon title="请至少选择一类邮件收件人" />
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
                title="正在编辑完整版本快照"
                description="未发布且没有流程实例的版本可以直接保存；发布后需先取消发布，已有实例后则只能复制新建版本。"
              />
            </div>
          )}
        </aside>
      </div>

      <Drawer
        title="流程检查结果"
        size={480}
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
          title={allValidationPassed ? "流程结构校验通过" : "流程暂不满足发布条件"}
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
      ? normalizeDesignerInputPermission(field) === "reviewer"
        ? [{ value: field.id, label: `${field.label}（整表）` }]
        : normalizeDesignerInputPermission(field) === "both"
          ? (field.columns ?? []).filter((column) => column.reviewEditable).map((column) => ({ value: `${field.id}.${column.id}`, label: `${field.label} / ${column.label}` }))
          : []
      : normalizeDesignerInputPermission(field) !== "initiator" ? [{ value: field.id, label: field.label }] : []);
  }, [version?.snapshot.form.fields]);
  const conditionFieldOptions = useMemo<ConditionFieldOption[]>(() => (version?.snapshot.form.fields ?? [])
    .filter((field: StoredDesignerField) => Boolean(field.id && field.label) && !["attachment", "table", "richtext"].includes(field.type))
    .map((field) => ({
      value: field.id,
      label: field.label,
      type: field.type,
      choiceOptions: flattenDesignerChoiceOptions(field.options),
      inputStage: normalizeDesignerInputPermission(field),
      required: field.required,
    })), [version?.snapshot.form.fields]);
  const starterGroups = version?.basic.starterGroups ?? [];
  const fallbackMeta = useMemo<FlowMeta>(
    () => ({
      ...genericInitialMeta,
      name: version?.basic.name ?? definition?.name ?? genericInitialMeta.name,
      code: definition?.code ?? genericInitialMeta.code,
      version: version?.version ?? genericInitialMeta.version,
      basedOn: version?.basedOn ?? "全新流程",
      status: definition && version ? getVersionStatus(definition, version.id) : "校验未通过",
      lastSavedAt: formatDisplayDateTime(
        version?.snapshot.flow.savedAt ?? version?.updatedAt,
        "尚未保存",
      ),
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
            activationCondition: normalizeActivationCondition(node.data?.activationCondition),
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
          title="流程不存在"
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
          title="版本不存在"
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
          title={`${version.version} 为只读版本`}
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
        formFields={version.snapshot.form.fields}
        starterGroups={starterGroups}
      />
    </ReactFlowProvider>
  );
};

export default FlowDesignerPage;
