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
  reviewEditable?: boolean;
  options?: string[];
  attachment?: {
    maxSizeMb?: number;
    maxCount?: number;
    inlinePdf?: boolean;
  };
  columns?: StoredDesignerTableColumn[];
}

export const PROCESS_TITLE_FIELD_ID = "title";

export const createProcessTitleField = (): StoredDesignerField => ({
  id: PROCESS_TITLE_FIELD_ID,
  type: "text",
  label: "标题",
  description: "用于任务中心、流程清单和流程详情统一显示此流程实例",
  placeholder: "请输入标题",
  required: true,
  defaultValue: "",
  listVisible: true,
  taskVisible: true,
  queryable: true,
  reviewEditable: false,
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
      ? { fields: ensureProcessTitleField(parsed.fields), savedAt: parsed.savedAt }
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
      ? { nodes: parsed.nodes, edges: parsed.edges, meta: parsed.meta }
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
  const fields = ensureProcessTitleField(snapshot.form.fields).map((field) =>
    field.id === PROCESS_TITLE_FIELD_ID && legacyTitleConfig
      ? { ...field, taskVisible: legacyTitleConfig.taskVisible, listVisible: legacyTitleConfig.processListVisible }
      : field,
  );
  return {
    form: { ...structuredClone(snapshot.form), fields },
    flow: structuredClone(snapshot.flow),
    systemFields: structuredClone(snapshot.systemFields.filter((field) => String(field.key) !== "title")),
  };
};

export const getReviewEditableFieldOptions = (definitionId: string): EditableFieldOption[] => {
  const snapshot = readFormDesignerSnapshot(definitionId);
  if (!snapshot) return [];
  return snapshot.fields.flatMap((field) => {
    if (field.type === "table") {
      return (field.columns ?? [])
        .filter((column) => column.reviewEditable)
        .map((column) => ({ value: `${field.id}.${column.id}`, label: `${field.label} / ${column.label}` }));
    }
    return field.reviewEditable ? [{ value: field.id, label: field.label }] : [];
  });
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
