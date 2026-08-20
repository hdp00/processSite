import { cloneDefaultSystemListFields } from "../data/listFieldConfig";
import type { DomainRole, DomainUser, WorkflowPermissionGroup } from "../state/useIdentityStore";
import type { DefinitionType, ProcessBasicConfig, ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import {
  PROCESS_TITLE_FIELD_ID,
  createProcessTitleField,
  ensureProcessTitleField,
  normalizeDesignerInputPermission,
  type CompleteDesignerSnapshot,
  type ConditionOperator,
  type StoredDesignerField,
  type StoredFlowDesignerSnapshot,
  type StoredNodeCondition,
} from "./designerStorage";
import {
  designerChoiceOptionPaths,
  displayDesignerChoiceValue,
  normalizeDesignerChoiceOptions,
  normalizeDesignerChoiceValue,
} from "./designerOptions";

interface TransferIdentityContext {
  users: DomainUser[];
  roles: DomainRole[];
  workflowGroups: WorkflowPermissionGroup[];
}

export interface ImportedProcessVersion {
  version: string;
  sourceStatus: string;
  changeNote: string;
  basic: ProcessBasicConfig;
  snapshot: CompleteDesignerSnapshot;
}

export interface ImportedProcessDefinition {
  name: string;
  type: DefinitionType;
  description: string;
  versions: ImportedProcessVersion[];
}

export interface ProcessDefinitionImportPreview {
  definition: ImportedProcessDefinition;
  warnings: string[];
}

const fieldTypeLabels: Record<string, string> = {
  text: "文本框",
  richtext: "富文本编辑框",
  select: "下拉框",
  cascader: "多级下拉框",
  radio: "单选框",
  checkbox: "复选框",
  attachment: "附件上传",
  table: "表格",
};
const fieldTypeValues = Object.fromEntries(Object.entries(fieldTypeLabels).map(([value, label]) => [label, value]));
const nodeKindLabels = { start: "开始", approval: "审批", end: "结束" } as const;
const nodeKindValues = { 开始: "start", 审批: "approval", 结束: "end" } as const;
const inputPermissionLabels = { initiator: "发起人", both: "发起人/审核人", reviewer: "审核人" } as const;
const inputPermissionValues = { 发起人: "initiator", "发起人/审核人": "both", 审核人: "reviewer" } as const;
const handlingModeLabels = { approval: "审批（可通过或驳回）", confirmation: "确认（只能确认）" } as const;
const handlingModeValues = { "审批（可通过或驳回）": "approval", "确认（只能确认）": "confirmation" } as const;
const rejectionLabels = { "resubmit-or-close": "重新提交或关闭", "resubmit-only": "仅允许重新提交", "auto-close": "驳回后自动关闭" } as const;
const rejectionValues = { 重新提交或关闭: "resubmit-or-close", 仅允许重新提交: "resubmit-only", 驳回后自动关闭: "auto-close" } as const;
const conditionOperatorLabels: Record<ConditionOperator, string> = {
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
};
const conditionOperatorValues = Object.fromEntries(Object.entries(conditionOperatorLabels).map(([value, label]) => [label, value])) as Record<string, ConditionOperator>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const record = (value: unknown, message: string) => {
  if (!isRecord(value)) throw new Error(message);
  return value;
};
const stringValue = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const booleanValue = (value: unknown, fallback = false) => typeof value === "boolean" ? value : fallback;
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const nameList = (value: unknown) => typeof value === "string" && value ? [value] : stringList(value);
const valueList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string | number | boolean => ["string", "number", "boolean"].includes(typeof item)) : [];
const displayValue = (value: unknown) => Array.isArray(value) ? valueList(value) : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
const unique = <T,>(values: T[]) => [...new Set(values)];
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const displayNameMap = (values: Array<{ id: string; name: string }>) => new Map(values.map((value) => [value.id, value.name]));
const displayNames = (values: string[] | undefined, names: Map<string, string>) => unique((values ?? []).flatMap((value) => {
  const matched = names.get(value) ?? [...names.values()].find((name) => name === value);
  return matched ? [matched] : [];
}));

const readableReferences = (values: Array<{ id: string; label: string }>) => {
  const totals = new Map<string, number>();
  values.forEach((value) => totals.set(value.label, (totals.get(value.label) ?? 0) + 1));
  const occurrences = new Map<string, number>();
  return new Map(values.map((value) => {
    const occurrence = (occurrences.get(value.label) ?? 0) + 1;
    occurrences.set(value.label, occurrence);
    return [value.id, totals.get(value.label) === 1 ? value.label : `${value.label}（第${occurrence}个）`];
  }));
};

const versionStatusText = (definition: ProcessDefinition, version: ProcessVersion) =>
  definition.publishedVersionId === version.id ? "已发布" : version.validation.status === "通过" ? "校验通过" : "校验未通过";

const conditionForExport = (
  condition: StoredNodeCondition | undefined,
  fieldNames: Map<string, string>,
  fieldsById: Map<string, StoredDesignerField>,
) => condition?.rules.length ? {
  "规则关系": condition.mode === "any" ? "满足任意规则" : "满足全部规则",
  "规则": condition.rules.map((rule) => ({
    "字段": fieldNames.get(rule.fieldId) ?? "未识别字段",
    "比较方式": conditionOperatorLabels[rule.operator],
    "比较值": ["empty", "not-empty"].includes(rule.operator)
      ? ""
      : displayDesignerChoiceValue(fieldsById.get(rule.fieldId)?.options, rule.value) || displayValue(rule.value),
  })),
} : undefined;

const exportField = (field: StoredDesignerField, fieldNames: Map<string, string>, fieldsById: Map<string, StoredDesignerField>) => {
  const base: Record<string, unknown> = {
    "名称": field.label,
    ...(fieldNames.get(field.id) !== field.label ? { "引用名称": fieldNames.get(field.id) } : {}),
    "类型": fieldTypeLabels[field.type] ?? field.type,
    "字段说明": field.description ?? "",
    "提示文字": field.placeholder ?? "",
    "必填": Boolean(field.required),
    "默认值": ["select", "radio", "checkbox", "cascader"].includes(field.type)
      ? displayDesignerChoiceValue(field.options, field.defaultValue, { hierarchical: field.type === "cascader", separator: field.type === "cascader" ? "/" : "、" })
      : displayValue(field.defaultValue),
    "输入权限": inputPermissionLabels[normalizeDesignerInputPermission(field)],
    "任务中心显示": Boolean(field.taskVisible),
    "流程清单显示": Boolean(field.listVisible),
    "作为查询条件": Boolean(field.queryable),
    "Excel导出": Boolean(field.exportVisible),
  };
  if (field.type === "text") base["多行显示"] = Boolean(field.multiline);
  if (field.options?.length) base["选项"] = field.type === "cascader" ? designerChoiceOptionPaths(field.options) : field.options.map((option) => option.label);
  if (field.displayCondition?.rules.length) base["显示条件"] = conditionForExport(field.displayCondition, fieldNames, fieldsById);
  if (field.type === "attachment") base["附件设置"] = {
    "最多文件数": field.attachment?.maxCount ?? 20,
    "单个文件上限MB": field.attachment?.maxSizeMb ?? 100,
    "PDF页面内显示": field.attachment?.inlinePdf ?? true,
    "允许扩展名": (field.attachment?.allowedExtensions ?? []).join("、"),
    "Excel转PDF": field.attachment?.excelToPdf ?? false,
    "转换最大页数": field.attachment?.maxPreviewPages ?? 1,
  };
  if (field.type === "table") base["表格列"] = (field.columns ?? []).map((column) => ({
    "名称": column.label,
    "类型": fieldTypeLabels[column.type ?? "text"] ?? column.type ?? "文本框",
    "必填": Boolean(column.required),
    "默认值": column.type && column.type !== "text" ? displayDesignerChoiceValue(column.options, column.defaultValue) : displayValue(column.defaultValue),
    "列宽": column.width ?? 160,
    "对齐": column.align === "center" ? "居中" : column.align === "right" ? "右对齐" : "左对齐",
    "审核人可输入": Boolean(column.reviewEditable),
    ...column.options?.length ? { "选项": column.options.map((option) => option.label) } : {},
  }));
  return base;
};

const exportVersion = (
  definition: ProcessDefinition,
  version: ProcessVersion,
  identities: TransferIdentityContext,
  familyFieldNames: Map<string, string>,
) => {
  const groupNames = displayNameMap(identities.workflowGroups);
  const userNames = displayNameMap(identities.users);
  const roleNames = displayNameMap(identities.roles);
  const fieldNames = new Map(familyFieldNames);
  const fieldsById = new Map(version.snapshot.form.fields.map((field) => [field.id, field]));
  version.snapshot.form.fields.forEach((field) => {
    const fieldReference = fieldNames.get(field.id) ?? field.label;
    field.columns?.forEach((column) => {
      const key = `${field.id}.${column.id}`;
      if (!fieldNames.has(key)) fieldNames.set(key, `${fieldReference} / ${column.label}`);
    });
  });
  const nodeNames = readableReferences(version.snapshot.flow.nodes.map((node) => ({ id: node.id, label: node.data?.label || "未命名节点" })));
  return {
    "版本": version.version,
    "原版本状态": versionStatusText(definition, version),
    "变更说明": version.changeNote,
    "基本信息": {
      "流程名称": version.basic.name,
      "流程类型": version.basic.type === "free" ? "自由协作" : "固定审批",
      "流程说明": version.basic.description,
      "实例编号前缀": version.basic.instancePrefix,
      "发起权限组": displayNames(version.basic.starterGroups, groupNames),
      "关闭权限组": displayNames(version.basic.closeGroups, groupNames),
      "审批受理权限组": displayNames(version.basic.assigneeGroups, groupNames),
      "额外可见角色": displayNames(version.basic.visibleRoles, roleNames),
      "额外可见用户": displayNames(version.basic.visibleUsers, userNames),
    },
    "初始表单": {
      "字段": version.snapshot.form.fields.map((field) => exportField(field, fieldNames, fieldsById)),
      "系统列表字段": version.snapshot.systemFields.map((field) => ({
        "名称": field.label,
        "任务中心显示": field.taskVisible,
        "流程清单显示": field.processListVisible,
        "Excel导出": field.exportVisible,
      })),
    },
    "流程设计": version.basic.type === "free" ? {
      "类型": "自由协作",
      "说明": "处理人完成后选择下一位受理人，直到手动关闭。",
    } : {
      "类型": "固定审批",
      "驳回处理": rejectionLabels[version.snapshot.flow.meta?.rejectionHandling ?? "resubmit-or-close"],
      "节点": version.snapshot.flow.nodes.map((node) => {
        const kind = node.data?.kind ?? "approval";
        return {
          "名称": node.data?.label || "未命名节点",
          ...(nodeNames.get(node.id) !== (node.data?.label || "未命名节点") ? { "连接引用": nodeNames.get(node.id) } : {}),
          "类型": nodeKindLabels[kind],
          "节点说明": node.data?.description ?? "",
          ...kind === "start" ? { "发起权限组": displayNames(node.data?.permissionGroups, groupNames) } : {},
          ...kind === "approval" ? {
            "执行权限组": displayNames(node.data?.permissionGroup ? [node.data.permissionGroup] : [], groupNames)[0] ?? "",
            "发起时可指定人员": Boolean(node.data?.specifyAssignee),
            "处理方式": handlingModeLabels[node.data?.handlingMode ?? "approval"],
            "可修改字段": (node.data?.editableFields ?? []).map((field) => fieldNames.get(field)).filter((name): name is string => Boolean(name)),
            "允许重复修改": Boolean(node.data?.allowRepeatedEditing),
            "执行条件": conditionForExport(node.data?.activationCondition, fieldNames, fieldsById),
          } : {},
          ...(kind === "approval" || kind === "end") && node.data?.emailNotification ? {
            "邮件通知": {
              "启用": Boolean(node.data.emailNotification.enabled),
              "通知审核人": Boolean(node.data.emailNotification.notifyReviewers),
              "通知发起人": Boolean(node.data.emailNotification.notifyInitiator),
              "额外通知用户": displayNames(node.data.emailNotification.extraUserIds, userNames),
            },
          } : {},
        };
      }),
      "连接": version.snapshot.flow.edges.flatMap((edge) => {
        const source = nodeNames.get(edge.source);
        const target = nodeNames.get(edge.target);
        return source && target ? [{ "从": source, "到": target }] : [];
      }),
    },
  };
};

export const createProcessDefinitionExport = (
  definition: ProcessDefinition,
  identities: TransferIdentityContext,
) => {
  const uniqueFields = new Map<string, string>();
  definition.versions.slice().reverse().forEach((version) => version.snapshot.form.fields.forEach((field) => {
    if (!uniqueFields.has(field.id)) uniqueFields.set(field.id, field.label);
  }));
  const familyFieldNames = readableReferences([...uniqueFields].map(([id, label]) => ({ id, label })));
  definition.versions.slice().reverse().forEach((version) => version.snapshot.form.fields.forEach((field) => {
    const fieldReference = familyFieldNames.get(field.id) ?? field.label;
    field.columns?.forEach((column) => {
      const key = `${field.id}.${column.id}`;
      if (!familyFieldNames.has(key)) familyFieldNames.set(key, `${fieldReference} / ${column.label}`);
    });
  }));
  return ({
  "文件类型": "FlowPilot 流程定义",
  "格式版本": "1.0",
  "导出时间": new Date().toLocaleString("zh-CN", { hour12: false }),
  "流程定义": {
    "名称": definition.name,
    "类型": definition.type === "free" ? "自由协作" : "固定审批",
    "说明": definition.description,
    "原状态": definition.disabled ? "已停用" : definition.publishedVersionId ? "已发布" : "未发布",
    "版本": [...definition.versions]
      .sort((left, right) => Number(left.version.slice(1)) - Number(right.version.slice(1)))
      .map((version) => exportVersion(definition, version, identities, familyFieldNames)),
  },
  });
};

const resolveNames = <T extends { id: string; name: string }>(
  names: string[],
  values: T[],
  label: string,
  warnings: string[],
) => unique(names.flatMap((name) => {
  const matched = values.find((value) => value.name === name);
  if (matched) return [matched.id];
  warnings.push(`${label}“${name}”不存在，已省略`);
  return [];
}));

const importCondition = (
  value: unknown,
  fieldIds: Map<string, string>,
  warnings: string[],
): StoredNodeCondition | undefined => {
  if (!isRecord(value)) return undefined;
  const rules = Array.isArray(value["规则"]) ? value["规则"].flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const fieldName = stringValue(item["字段"]);
    const fieldId = fieldIds.get(fieldName);
    if (!fieldId) {
      warnings.push(`条件字段“${fieldName}”不存在，已省略该规则`);
      return [];
    }
    return [{
      id: makeId(`condition-${index + 1}`),
      fieldId,
      operator: conditionOperatorValues[stringValue(item["比较方式"])] ?? "eq",
      value: displayValue(item["比较值"]) as string | string[],
    }];
  }) : [];
  return rules.length ? { mode: value["规则关系"] === "满足任意规则" ? "any" : "all", rules } : undefined;
};

interface ImportFieldIdentity {
  id: string;
  type: string;
}

interface ImportFormIdentityRegistry {
  fields: Map<string, ImportFieldIdentity>;
  columns: Map<string, ImportFieldIdentity>;
}

const importForm = (value: unknown, warnings: string[], registry: ImportFormIdentityRegistry) => {
  const source = record(value, "初始表单格式不正确");
  const rawFields = Array.isArray(source["字段"]) ? source["字段"].filter(isRecord) : [];
  const fieldIds = new Map<string, string>();
  const fields = rawFields.map((raw, index): StoredDesignerField => {
    const label = stringValue(raw["名称"], `未命名字段 ${index + 1}`);
    const reference = stringValue(raw["引用名称"], label);
    const type = fieldTypeValues[stringValue(raw["类型"])] ?? "text";
    const previousIdentity = registry.fields.get(reference);
    const id = label === "标题" && !fieldIds.has("标题")
      ? PROCESS_TITLE_FIELD_ID
      : previousIdentity?.type === type
        ? previousIdentity.id
        : makeId("field");
    if (previousIdentity && previousIdentity.type !== type) warnings.push(`字段“${reference}”在不同版本中类型不兼容，已按新字段导入`);
    registry.fields.set(reference, { id, type });
    fieldIds.set(reference, id);
    if (!fieldIds.has(label)) fieldIds.set(label, id);
    const columns = type === "table" && Array.isArray(raw["表格列"]) ? raw["表格列"].filter(isRecord).map((column, columnIndex) => {
      const columnLabel = stringValue(column["名称"], `未命名列 ${columnIndex + 1}`);
      const columnType = (fieldTypeValues[stringValue(column["类型"])] ?? "text") as "text" | "radio" | "checkbox" | "select";
      const columnReference = `${reference} / ${columnLabel}`;
      const previousColumnIdentity = registry.columns.get(columnReference);
      const columnId = previousColumnIdentity?.type === columnType ? previousColumnIdentity.id : makeId("column");
      if (previousColumnIdentity && previousColumnIdentity.type !== columnType) warnings.push(`表格列“${columnReference}”在不同版本中类型不兼容，已按新列导入`);
      registry.columns.set(columnReference, { id: columnId, type: columnType });
      const columnOptions = columnType === "text" ? undefined : normalizeDesignerChoiceOptions(column["选项"], `${id}.${columnId}`);
      const rawColumnDefault = displayValue(column["默认值"]);
      const columnDefault = columnType === "checkbox"
        ? normalizeDesignerChoiceValue(columnOptions, Array.isArray(rawColumnDefault) ? rawColumnDefault : String(rawColumnDefault ?? "").split("、").filter(Boolean), { multiple: true })
        : columnType === "select" || columnType === "radio"
          ? normalizeDesignerChoiceValue(columnOptions, rawColumnDefault)
          : rawColumnDefault;
      fieldIds.set(`${reference} / ${columnLabel}`, `${id}.${columnId}`);
      if (!fieldIds.has(`${label} / ${columnLabel}`)) fieldIds.set(`${label} / ${columnLabel}`, `${id}.${columnId}`);
      return {
        id: columnId,
        label: columnLabel,
        type: columnType,
        required: booleanValue(column["必填"]),
        defaultValue: columnDefault as string | string[],
        width: typeof column["列宽"] === "number" ? column["列宽"] : 160,
        align: column["对齐"] === "居中" ? "center" as const : column["对齐"] === "右对齐" ? "right" as const : "left" as const,
        reviewEditable: booleanValue(column["审核人可输入"]),
        options: columnOptions,
      };
    }) : undefined;
    const attachment = type === "attachment" && isRecord(raw["附件设置"]) ? {
      maxCount: typeof raw["附件设置"]["最多文件数"] === "number" ? raw["附件设置"]["最多文件数"] as number : 20,
      maxSizeMb: typeof raw["附件设置"]["单个文件上限MB"] === "number" ? raw["附件设置"]["单个文件上限MB"] as number : 100,
      inlinePdf: booleanValue(raw["附件设置"]["PDF页面内显示"], true),
      allowedExtensions: String(displayValue(raw["附件设置"]["允许扩展名"])).split(/[、,，\s]+/).map((value) => value.replace(/^\./, "").toLowerCase()).filter(Boolean),
      excelToPdf: booleanValue(raw["附件设置"]["Excel转PDF"]),
      maxPreviewPages: typeof raw["附件设置"]["转换最大页数"] === "number" ? raw["附件设置"]["转换最大页数"] as number : 1,
    } : undefined;
    const options = ["select", "radio", "checkbox", "cascader"].includes(type)
      ? normalizeDesignerChoiceOptions(raw["选项"], id, type === "cascader")
      : undefined;
    const rawDefault = displayValue(raw["默认值"]);
    const defaultValue = type === "checkbox"
      ? normalizeDesignerChoiceValue(options, Array.isArray(rawDefault) ? rawDefault : String(rawDefault ?? "").split("、").filter(Boolean), { multiple: true })
      : type === "cascader"
        ? normalizeDesignerChoiceValue(options, Array.isArray(rawDefault) ? rawDefault : String(rawDefault ?? "").split("/").filter(Boolean), { hierarchical: true })
        : type === "select" || type === "radio"
          ? normalizeDesignerChoiceValue(options, rawDefault)
          : rawDefault;
    return {
      id,
      label,
      type,
      description: stringValue(raw["字段说明"]),
      placeholder: stringValue(raw["提示文字"]),
      multiline: booleanValue(raw["多行显示"]),
      required: booleanValue(raw["必填"]),
      defaultValue: defaultValue as string | string[],
      inputStage: inputPermissionValues[stringValue(raw["输入权限"]) as keyof typeof inputPermissionValues] ?? "initiator",
      taskVisible: booleanValue(raw["任务中心显示"]),
      listVisible: booleanValue(raw["流程清单显示"]),
      queryable: booleanValue(raw["作为查询条件"]),
      exportVisible: booleanValue(raw["Excel导出"]),
      options,
      attachment,
      columns,
    };
  });
  rawFields.forEach((raw, index) => {
    fields[index].displayCondition = importCondition(raw["显示条件"], fieldIds, warnings);
  });
  const systemFields = cloneDefaultSystemListFields();
  const rawSystemFields = Array.isArray(source["系统列表字段"]) ? source["系统列表字段"].filter(isRecord) : [];
  rawSystemFields.forEach((raw) => {
    const target = systemFields.find((field) => field.label === stringValue(raw["名称"]));
    if (!target) return;
    target.taskVisible = booleanValue(raw["任务中心显示"]);
    target.processListVisible = booleanValue(raw["流程清单显示"]);
    target.exportVisible = booleanValue(raw["Excel导出"]);
  });
  return { fields: ensureProcessTitleField(fields.length ? fields : [createProcessTitleField()]), fieldIds, systemFields };
};

const importFlow = (
  value: unknown,
  type: DefinitionType,
  fieldIds: Map<string, string>,
  identities: TransferIdentityContext,
  warnings: string[],
): StoredFlowDesignerSnapshot => {
  if (type === "free") return { nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } };
  const source = record(value, "流程设计格式不正确");
  const rawNodes = Array.isArray(source["节点"]) ? source["节点"].filter(isRecord) : [];
  const nodeIds = new Map<string, string>();
  const nodes = rawNodes.map((raw, index) => {
    const label = stringValue(raw["名称"], `未命名节点 ${index + 1}`);
    const reference = stringValue(raw["连接引用"], label);
    const id = makeId("node");
    nodeIds.set(reference, id);
    if (!nodeIds.has(label)) nodeIds.set(label, id);
    const kind = nodeKindValues[stringValue(raw["类型"]) as keyof typeof nodeKindValues] ?? "approval";
    const email = isRecord(raw["邮件通知"]) ? raw["邮件通知"] : undefined;
    const permissionGroup = resolveNames(nameList(raw["执行权限组"]), identities.workflowGroups, "流程权限组", warnings)[0];
    return {
      id,
      position: { x: 80 + (index % 3) * 300, y: 120 + Math.floor(index / 3) * 190 },
      data: {
        kind,
        label,
        description: stringValue(raw["节点说明"]),
        permissionGroups: kind === "start" ? resolveNames(stringList(raw["发起权限组"]), identities.workflowGroups, "流程权限组", warnings) : undefined,
        permissionGroup: kind === "approval" ? permissionGroup : undefined,
        specifyAssignee: kind === "approval" ? booleanValue(raw["发起时可指定人员"]) : undefined,
        handlingMode: kind === "approval" ? handlingModeValues[stringValue(raw["处理方式"]) as keyof typeof handlingModeValues] ?? "approval" : undefined,
        editableFields: kind === "approval" ? stringList(raw["可修改字段"]).flatMap((name) => {
          const idValue = fieldIds.get(name);
          if (idValue) return [idValue];
          warnings.push(`可修改字段“${name}”不存在，已省略`);
          return [];
        }) : [],
        allowRepeatedEditing: kind === "approval" ? booleanValue(raw["允许重复修改"]) : false,
        activationCondition: kind === "approval" ? importCondition(raw["执行条件"], fieldIds, warnings) : undefined,
        emailNotification: kind === "approval" || kind === "end" ? {
          enabled: booleanValue(email?.["启用"]),
          notifyReviewers: kind === "approval" && booleanValue(email?.["通知审核人"]),
          notifyInitiator: kind === "end" && booleanValue(email?.["通知发起人"]),
          extraUserIds: resolveNames(stringList(email?.["额外通知用户"]), identities.users, "用户", warnings),
        } : undefined,
      },
    };
  });
  const rawEdges = Array.isArray(source["连接"]) ? source["连接"].filter(isRecord) : [];
  const edges = rawEdges.flatMap((raw) => {
    const from = stringValue(raw["从"]);
    const to = stringValue(raw["到"]);
    const sourceId = nodeIds.get(from);
    const targetId = nodeIds.get(to);
    if (sourceId && targetId) return [{ id: makeId("edge"), source: sourceId, target: targetId }];
    warnings.push(`连接“${from} → ${to}”找不到同名节点，已省略`);
    return [];
  });
  return {
    nodes,
    edges,
    meta: { rejectionHandling: rejectionValues[stringValue(source["驳回处理"]) as keyof typeof rejectionValues] ?? "resubmit-or-close" },
  };
};

export const parseProcessDefinitionImport = (
  text: string,
  identities: TransferIdentityContext,
): ProcessDefinitionImportPreview => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("导入文件无法解析，请检查文件内容是否完整");
  }
  const root = record(parsed, "导入文件格式不正确");
  if (root["文件类型"] !== "FlowPilot 流程定义") throw new Error("这不是 FlowPilot 流程定义导出文件");
  const source = record(root["流程定义"], "导入文件缺少流程定义");
  const name = stringValue(source["名称"]).trim();
  if (!name) throw new Error("导入文件缺少流程名称");
  const type: DefinitionType = source["类型"] === "自由协作" ? "free" : "approval";
  const rawVersions = Array.isArray(source["版本"]) ? source["版本"].filter(isRecord) : [];
  if (!rawVersions.length) throw new Error("导入文件没有可用版本");
  const warnings: string[] = [];
  const groupIds = (value: unknown) => resolveNames(stringList(value), identities.workflowGroups, "流程权限组", warnings);
  const userIds = (value: unknown) => resolveNames(stringList(value), identities.users, "用户", warnings);
  const roleIds = (value: unknown) => resolveNames(stringList(value), identities.roles, "角色", warnings);
  const formIdentityRegistry: ImportFormIdentityRegistry = { fields: new Map(), columns: new Map() };
  const versions = rawVersions.map((raw, index): ImportedProcessVersion => {
    const basicSource = record(raw["基本信息"], `第 ${index + 1} 个版本缺少基本信息`);
    const form = importForm(raw["初始表单"], warnings, formIdentityRegistry);
    const versionType: DefinitionType = basicSource["流程类型"] === "自由协作" ? "free" : type;
    const basic: ProcessBasicConfig = {
      name: stringValue(basicSource["流程名称"], name),
      code: "导入后自动生成",
      instancePrefix: stringValue(basicSource["实例编号前缀"]),
      type: versionType,
      description: stringValue(basicSource["流程说明"], stringValue(source["说明"])),
      starterGroups: groupIds(basicSource["发起权限组"]),
      closeGroups: groupIds(basicSource["关闭权限组"]),
      assigneeGroups: groupIds(basicSource["审批受理权限组"]),
      visibleRoles: roleIds(basicSource["额外可见角色"]),
      visibleUsers: userIds(basicSource["额外可见用户"]),
    };
    return {
      version: /^V\d+$/.test(stringValue(raw["版本"]).toUpperCase()) ? stringValue(raw["版本"]).toUpperCase() : `V${index + 1}`,
      sourceStatus: stringValue(raw["原版本状态"], "未发布"),
      changeNote: stringValue(raw["变更说明"], "从导入文件创建"),
      basic,
      snapshot: {
        form: { fields: form.fields },
        flow: importFlow(raw["流程设计"], versionType, form.fieldIds, identities, warnings),
        systemFields: form.systemFields,
      },
    };
  });
  return {
    definition: { name, type, description: stringValue(source["说明"]), versions },
    warnings: unique(warnings),
  };
};
