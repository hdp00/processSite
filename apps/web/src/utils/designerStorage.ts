import {
  SYSTEM_LIST_FIELDS_STORAGE_KEY_PREFIX,
  cloneDefaultSystemListFields,
  loadSystemListFields,
  type SystemListFieldConfig,
} from "../data/listFieldConfig";

export const FORM_DESIGNER_STORAGE_KEY_PREFIX = "flowpilot-form-designer-draft-v2";
export const FLOW_DESIGNER_STORAGE_KEY_PREFIX = "flowpilot-flow-designer-v2";
export const DESIGNER_VERSION_SNAPSHOT_KEY_PREFIX = "flowpilot-designer-version-snapshot-v1";

interface DesignerArtifacts {
  form: string | null;
  flow: string | null;
  systemFields: string | null;
}

export interface CompleteDesignerSnapshot {
  form: StoredFormDesignerSnapshot;
  flow: StoredFlowDesignerSnapshot;
  systemFields: SystemListFieldConfig[];
}

const workingArtifactKeys = (definitionId: string) => ({
  form: `${FORM_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`,
  flow: `${FLOW_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`,
  systemFields: `${SYSTEM_LIST_FIELDS_STORAGE_KEY_PREFIX}:${definitionId}`,
});

const versionArtifactKey = (definitionId: string, versionId: string) =>
  `${DESIGNER_VERSION_SNAPSHOT_KEY_PREFIX}:${definitionId}:${versionId}`;

export function saveDesignerVersionSnapshot(definitionId: string, versionId: string) {
  if (typeof window === "undefined") return;
  const keys = workingArtifactKeys(definitionId);
  const snapshot: DesignerArtifacts = {
    form: window.localStorage.getItem(keys.form),
    flow: window.localStorage.getItem(keys.flow),
    systemFields: window.localStorage.getItem(keys.systemFields),
  };
  window.localStorage.setItem(versionArtifactKey(definitionId, versionId), JSON.stringify(snapshot));
}

export function restoreDesignerVersionSnapshot(definitionId: string, versionId: string) {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(versionArtifactKey(definitionId, versionId));
    if (!raw) return false;
    const snapshot = JSON.parse(raw) as DesignerArtifacts;
    const keys = workingArtifactKeys(definitionId);
    (["form", "flow", "systemFields"] as const).forEach((kind) => {
      const value = snapshot[kind];
      if (typeof value === "string") window.localStorage.setItem(keys[kind], value);
      else window.localStorage.removeItem(keys[kind]);
    });
    return true;
  } catch {
    return false;
  }
}

export function removeDesignerVersionSnapshot(definitionId: string, versionId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(versionArtifactKey(definitionId, versionId));
}

export function clearDefinitionDesignerArtifacts(definitionId: string) {
  if (typeof window === "undefined") return;
  const keys = workingArtifactKeys(definitionId);
  Object.values(keys).forEach((key) => window.localStorage.removeItem(key));
  const snapshotPrefix = `${DESIGNER_VERSION_SNAPSHOT_KEY_PREFIX}:${definitionId}:`;
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith(snapshotPrefix))
    .forEach((key) => window.localStorage.removeItem(key));
}

export interface StoredDesignerTableColumn {
  id: string;
  label: string;
  type?: "text" | "radio" | "checkbox" | "select";
  required?: boolean;
  defaultValue?: string | string[];
  width?: number;
  align?: "left" | "center" | "right";
  reviewEditable?: boolean;
  options?: string[];
}

export interface StoredDesignerField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | string[];
  listVisible?: boolean;
  taskVisible?: boolean;
  taskDisplayName?: string;
  taskOrder?: number;
  taskWidth?: number;
  queryable?: boolean;
  exportVisible?: boolean;
  reviewEditable?: boolean;
  inputStage?: DesignerInputPermission;
  options?: string[];
  attachment?: {
    maxSizeMb?: number;
    maxCount?: number;
    inlinePdf?: boolean;
  };
  columns?: StoredDesignerTableColumn[];
}

export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not-contains" | "empty" | "not-empty";

export interface StoredNodeConditionRule {
  id: string;
  fieldId: string;
  operator: ConditionOperator;
  value?: string | string[];
}

export interface StoredNodeCondition {
  mode: "all" | "any";
  rules: StoredNodeConditionRule[];
}

export type ApprovalHandlingMode = "approval" | "confirmation";

export interface StoredNodeEmailNotification {
  enabled: boolean;
  notifyReviewers?: boolean;
  notifyInitiator?: boolean;
  extraUserIds: string[];
}

export const PROCESS_TITLE_FIELD_ID = "title";
export type DesignerInputPermission = "initiator" | "both" | "reviewer";

const LEGACY_TITLE_DESCRIPTION = "用于任务中心、流程清单和流程详情统一显示此流程实例";

export const normalizeDesignerInputPermission = (
  field: Pick<StoredDesignerField, "inputStage" | "reviewEditable">,
): DesignerInputPermission => {
  if (field.inputStage === "both" || field.inputStage === "reviewer") return field.inputStage;
  return field.reviewEditable ? "both" : "initiator";
};

export const createProcessTitleField = (): StoredDesignerField => ({
  id: PROCESS_TITLE_FIELD_ID,
  type: "text",
  label: "标题",
  description: "",
  placeholder: "请输入标题",
  required: true,
  defaultValue: "",
  listVisible: true,
  taskVisible: true,
  queryable: true,
  exportVisible: true,
  reviewEditable: false,
  inputStage: "initiator",
});

export const ensureProcessTitleField = (fields?: StoredDesignerField[]): StoredDesignerField[] => {
  const source = structuredClone(fields ?? []);
  const titleIndex = source.findIndex((field) => field.id === PROCESS_TITLE_FIELD_ID);
  if (titleIndex < 0) return [createProcessTitleField(), ...source];
  source[titleIndex] = {
    ...source[titleIndex],
    id: PROCESS_TITLE_FIELD_ID,
    type: "text",
    required: true,
    listVisible: source[titleIndex].listVisible ?? true,
    taskVisible: source[titleIndex].taskVisible ?? true,
    exportVisible: source[titleIndex].exportVisible ?? source[titleIndex].listVisible ?? true,
    description: source[titleIndex].description === LEGACY_TITLE_DESCRIPTION ? "" : source[titleIndex].description,
    inputStage: normalizeDesignerInputPermission(source[titleIndex]) === "reviewer" ? "initiator" : normalizeDesignerInputPermission(source[titleIndex]),
  };
  return source;
};

export interface StoredFormDesignerSnapshot {
  fields: StoredDesignerField[];
  savedAt?: string;
}

export interface EditableFieldOption {
  value: string;
  label: string;
}

export interface StoredFlowNodeSnapshot {
  id: string;
  position?: { x: number; y: number };
  data?: {
    kind?: "start" | "approval" | "end";
    label?: string;
    description?: string;
    permissionGroup?: string;
    permissionGroups?: string[];
    specifyAssignee?: boolean;
    editableFields?: string[];
    handlingMode?: ApprovalHandlingMode;
    allowRepeatedEditing?: boolean;
    activationCondition?: StoredNodeCondition;
    emailNotification?: StoredNodeEmailNotification;
  };
}

export interface StoredFlowEdgeSnapshot {
  id?: string;
  source: string;
  target: string;
}

export interface StoredFlowDesignerSnapshot {
  nodes: StoredFlowNodeSnapshot[];
  edges: StoredFlowEdgeSnapshot[];
  meta?: {
    rejectionHandling?: "resubmit-or-close" | "resubmit-only" | "auto-close";
  };
}

export const readFormDesignerSnapshot = (definitionId: string): StoredFormDesignerSnapshot | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(`${FORM_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredFormDesignerSnapshot>;
    return Array.isArray(parsed.fields)
      ? {
          fields: ensureProcessTitleField(parsed.fields).map((field) => ({
            ...field,
            inputStage: normalizeDesignerInputPermission(field),
          })),
          savedAt: parsed.savedAt,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

export const readFlowDesignerSnapshot = (definitionId: string): StoredFlowDesignerSnapshot | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(`${FLOW_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredFlowDesignerSnapshot>;
    return Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)
      ? {
          nodes: parsed.nodes.map((node) => ({
            ...node,
            data: node.data?.kind === "approval"
              ? {
                  ...node.data,
                  handlingMode: node.data.handlingMode ?? "approval",
                  allowRepeatedEditing: Boolean(node.data.allowRepeatedEditing && node.data.editableFields?.length),
                }
              : node.data,
          })),
          edges: parsed.edges,
          meta: parsed.meta,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

export const captureWorkingDesignerSnapshot = (definitionId: string): CompleteDesignerSnapshot => ({
  form: readFormDesignerSnapshot(definitionId) ?? { fields: [createProcessTitleField()] },
  flow: readFlowDesignerSnapshot(definitionId) ?? { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } },
  systemFields: loadSystemListFields(definitionId),
});

export const writeWorkingDesignerSnapshot = (definitionId: string, snapshot: CompleteDesignerSnapshot) => {
  if (typeof window === "undefined") return false;
  try {
    const keys = workingArtifactKeys(definitionId);
    window.localStorage.setItem(keys.form, JSON.stringify(snapshot.form));
    window.localStorage.setItem(keys.flow, JSON.stringify(snapshot.flow));
    window.localStorage.setItem(keys.systemFields, JSON.stringify(snapshot.systemFields));
    return true;
  } catch {
    return false;
  }
};

export const cloneCompleteDesignerSnapshot = (snapshot?: CompleteDesignerSnapshot): CompleteDesignerSnapshot => {
  if (!snapshot) return {
    form: { fields: [createProcessTitleField()] },
    flow: { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } },
    systemFields: cloneDefaultSystemListFields(),
  };
  const legacyTitleConfig = snapshot.systemFields.find((field) => String(field.key) === "title");
  const fields = ensureProcessTitleField(snapshot.form.fields).map((field) => ({
    ...field,
    exportVisible: field.exportVisible ?? field.listVisible ?? false,
    inputStage: field.id === PROCESS_TITLE_FIELD_ID && normalizeDesignerInputPermission(field) === "reviewer"
      ? "initiator"
      : normalizeDesignerInputPermission(field),
    ...(field.id === PROCESS_TITLE_FIELD_ID && legacyTitleConfig
      ? { taskVisible: legacyTitleConfig.taskVisible, listVisible: legacyTitleConfig.processListVisible }
      : {}),
  }));
  const flow = structuredClone(snapshot.flow);
  flow.nodes = flow.nodes.map((node) => ({
    ...node,
    data: node.data ? {
      ...node.data,
      ...(node.data.kind === "approval" ? {
        handlingMode: node.data.handlingMode ?? "approval",
        allowRepeatedEditing: Boolean(node.data.allowRepeatedEditing && node.data.editableFields?.length),
      } : {}),
      ...(node.data.kind === "approval" || node.data.kind === "end" ? {
        emailNotification: node.data.emailNotification
          ? {
              enabled: Boolean(node.data.emailNotification.enabled),
              notifyReviewers: node.data.kind === "approval" && Boolean(node.data.emailNotification.notifyReviewers),
              notifyInitiator: node.data.kind === "end" && Boolean(node.data.emailNotification.notifyInitiator),
              extraUserIds: [...(node.data.emailNotification.extraUserIds ?? [])],
            }
          : undefined,
      } : {}),
    } : node.data,
  }));
  return {
    form: { ...structuredClone(snapshot.form), fields },
    flow,
    systemFields: structuredClone(snapshot.systemFields.filter((field) => String(field.key) !== "title").map((field) => ({
      ...field,
      exportVisible: field.exportVisible ?? field.processListVisible,
    }))),
  };
};

export const getReviewEditableFieldOptions = (definitionId: string): EditableFieldOption[] => {
  const snapshot = readFormDesignerSnapshot(definitionId);
  if (!snapshot) return [];
  return snapshot.fields.flatMap((field) => {
    const inputStage = normalizeDesignerInputPermission(field);
    if (field.type === "table") {
      if (inputStage === "reviewer") return [{ value: field.id, label: `${field.label}（整表）` }];
      if (inputStage !== "both") return [];
      return (field.columns ?? [])
        .filter((column) => column.reviewEditable)
        .map((column) => ({ value: `${field.id}.${column.id}`, label: `${field.label} / ${column.label}` }));
    }
    return inputStage === "both" || inputStage === "reviewer"
      ? [{ value: field.id, label: field.label }]
      : [];
  });
};

const emptyValue = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export const conditionOperatorLabel = (operator: ConditionOperator) => ({
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  contains: "包含",
  "not-contains": "不包含",
  empty: "为空",
  "not-empty": "不为空",
}[operator]);

export const evaluateNodeCondition = (
  condition: StoredNodeCondition | undefined,
  values: Record<string, unknown>,
) => {
  if (!condition?.rules.length) return { matches: true, results: [] as Array<{ rule: StoredNodeConditionRule; actual: unknown; matches: boolean }> };
  const results = condition.rules.map((rule) => {
    const actual = values[rule.fieldId];
    const expected = rule.value;
    let matches = false;
    if (rule.operator === "empty") matches = emptyValue(actual);
    else if (rule.operator === "not-empty") matches = !emptyValue(actual);
    else if (rule.operator === "contains" || rule.operator === "not-contains") {
      const contains = Array.isArray(actual) ? actual.map(String).includes(String(expected ?? "")) : String(actual ?? "").includes(String(expected ?? ""));
      matches = rule.operator === "contains" ? contains : !contains;
    } else if (["gt", "gte", "lt", "lte"].includes(rule.operator)) {
      const left = Number(actual);
      const right = Number(expected);
      if (Number.isFinite(left) && Number.isFinite(right)) {
        matches = rule.operator === "gt" ? left > right : rule.operator === "gte" ? left >= right : rule.operator === "lt" ? left < right : left <= right;
      }
    } else {
      const equal = Array.isArray(actual)
        ? actual.map(String).includes(String(expected ?? "")) || actual.map(String).join("/") === String(expected ?? "")
        : String(actual ?? "") === String(expected ?? "");
      matches = rule.operator === "eq" ? equal : !equal;
    }
    return { rule, actual, matches };
  });
  return { matches: condition.mode === "any" ? results.some((item) => item.matches) : results.every((item) => item.matches), results };
};

export const rejectionHandlingLabel = (value?: string) => ({
  "resubmit-or-close": "重新提交或关闭",
  "resubmit-only": "仅允许重新提交",
  "auto-close": "自动关闭流程",
}[value ?? ""] ?? "重新提交或关闭");

export const buildFlowLevels = (
  nodes: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }>,
) => {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  edges.forEach((edge) => {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) return;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const levelById = new Map(queue.map((id) => [id, 0]));
  const pendingIndegree = new Map(indegree);
  while (queue.length) {
    const source = queue.shift()!;
    const sourceLevel = levelById.get(source) ?? 0;
    (outgoing.get(source) ?? []).forEach((target) => {
      levelById.set(target, Math.max(levelById.get(target) ?? 0, sourceLevel + 1));
      pendingIndegree.set(target, (pendingIndegree.get(target) ?? 1) - 1);
      if (pendingIndegree.get(target) === 0) queue.push(target);
    });
  }
  nodes.forEach((node) => {
    if (!levelById.has(node.id)) levelById.set(node.id, 0);
  });
  const maxLevel = Math.max(0, ...levelById.values());
  return Array.from({ length: maxLevel + 1 }, (_, level) =>
    nodes.filter((node) => levelById.get(node.id) === level).map((node) => node.id),
  );
};
