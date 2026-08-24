// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SYSTEM_LIST_FIELDS,
  SYSTEM_LIST_FIELDS_STORAGE_KEY_PREFIX,
} from "../data/listFieldConfig";
import {
  FORM_DESIGNER_STORAGE_KEY_PREFIX,
  FLOW_DESIGNER_STORAGE_KEY_PREFIX,
  applyDesignerFieldVisibility,
  buildFlowLevels,
  captureWorkingDesignerSnapshot,
  clearDefinitionDesignerArtifacts,
  cloneCompleteDesignerSnapshot,
  conditionOperatorLabel,
  createProcessTitleField,
  ensureProcessTitleField,
  evaluateNodeCondition,
  getReviewEditableFieldOptions,
  normalizeDesignerFieldValue,
  normalizeDesignerFormValues,
  normalizeDesignerInputPermission,
  normalizeStoredCondition,
  readFlowDesignerSnapshot,
  readFormDesignerSnapshot,
  rejectionHandlingLabel,
  writeWorkingDesignerSnapshot,
  type CompleteDesignerSnapshot,
  type ConditionOperator,
  type StoredDesignerField,
  type StoredNodeCondition,
} from "./designerStorage";

const field = (
  value: Partial<StoredDesignerField> & Pick<StoredDesignerField, "id" | "type" | "label">,
): StoredDesignerField => value;

const formKey = (definitionId: string) => `${FORM_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`;
const flowKey = (definitionId: string) => `${FLOW_DESIGNER_STORAGE_KEY_PREFIX}-${definitionId}`;
const systemKey = (definitionId: string) => `${SYSTEM_LIST_FIELDS_STORAGE_KEY_PREFIX}:${definitionId}`;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("设计器旧数据归一化", () => {
  it("restores every fixed-title invariant without mutating the caller's snapshot", () => {
    const legacyTitle = field({
      id: "title",
      type: "attachment",
      label: "旧标题",
      description: "用于任务中心、流程清单和流程详情统一显示此流程实例",
      multiline: true,
      required: false,
      queryable: false,
      inputStage: "reviewer",
    });
    const source = [legacyTitle, field({ id: "body", type: "text", label: "正文" })];

    const normalized = ensureProcessTitleField(source);

    expect(normalized[0]).toMatchObject({
      id: "title",
      type: "text",
      label: "旧标题",
      description: "",
      multiline: false,
      required: true,
      queryable: true,
      listVisible: true,
      taskVisible: true,
      exportVisible: true,
      inputStage: "initiator",
    });
    expect(source[0]).toBe(legacyTitle);
    expect(source[0]).toMatchObject({ type: "attachment", required: false, inputStage: "reviewer" });

    const inserted = ensureProcessTitleField(undefined);
    expect(inserted).toEqual([createProcessTitleField()]);
  });

  it("maps legacy reviewEditable flags while preserving explicit modern permissions", () => {
    expect(normalizeDesignerInputPermission({ reviewEditable: true })).toBe("both");
    expect(normalizeDesignerInputPermission({ reviewEditable: false })).toBe("initiator");
    expect(normalizeDesignerInputPermission({ inputStage: "reviewer", reviewEditable: false })).toBe("reviewer");
    expect(normalizeDesignerInputPermission({ inputStage: "both", reviewEditable: false })).toBe("both");
  });

  it("filters damaged condition rules and fills safe defaults", () => {
    const normalized = normalizeStoredCondition({
      mode: "any",
      rules: [
        null,
        "damaged",
        { id: "", fieldId: 42, operator: undefined, value: undefined },
        { id: "kept", fieldId: "amount", operator: "gte", value: "100" },
      ],
    } as never);

    expect(normalized).toEqual({
      mode: "any",
      rules: [
        { id: "condition-1", fieldId: "", operator: "eq", value: "" },
        { id: "kept", fieldId: "amount", operator: "gte", value: "100" },
      ],
    });
    expect(normalizeStoredCondition("damaged" as never)).toBeUndefined();
  });

  it("normalizes legacy choice values in standalone fields, cascaders and table cells", () => {
    const checkbox = field({
      id: "departments",
      type: "checkbox",
      label: "部门",
      options: [{ id: "rd", label: "研发" }, { id: "qa", label: "质量" }],
    });
    const cascader = field({
      id: "organization",
      type: "cascader",
      label: "组织",
      options: [{ id: "china", label: "中国", children: [{ id: "shanghai", label: "上海" }] }],
    });
    const table = field({
      id: "detail",
      type: "table",
      label: "明细",
      columns: [
        { id: "severity", label: "严重度", type: "select", options: [{ id: "high", label: "高" }] },
        { id: "owners", label: "负责人", type: "checkbox", options: [{ id: "alice", label: "张三" }] },
        { id: "note", label: "备注", type: "text" },
      ],
    });

    expect(normalizeDesignerFieldValue(checkbox, ["研发", "qa"])).toEqual(["rd", "qa"]);
    expect(normalizeDesignerFieldValue(checkbox, "研发")).toEqual([]);
    expect(normalizeDesignerFieldValue(cascader, ["中国", "上海"])).toEqual(["china", "shanghai"]);
    expect(normalizeDesignerFieldValue(table, [
      { severity: "高", owners: ["张三"], note: "保留", unknown: "原值" },
      "damaged-row",
    ])).toEqual([
      { severity: "high", owners: ["alice"], note: "保留", unknown: "原值" },
      "damaged-row",
    ]);
    expect(normalizeDesignerFormValues([checkbox], { departments: ["质量"], unknown: "保留" })).toEqual({
      departments: ["qa"],
      unknown: "保留",
    });
  });

  it("loads a legacy form snapshot with stable option ids, condition references and bounded attachment settings", () => {
    window.localStorage.setItem(formKey("legacy-form"), JSON.stringify({
      savedAt: "2026-08-20 09:30",
      fields: [
        {
          id: "decision",
          type: "select",
          label: "处理结果",
          options: ["打开", "关闭"],
          defaultValue: "打开",
          reviewEditable: true,
        },
        {
          id: "reason",
          type: "text",
          label: "关闭原因",
          displayCondition: {
            mode: "all",
            rules: [{ id: "closed", fieldId: "decision", operator: "eq", value: "关闭" }],
          },
        },
        {
          id: "evidence",
          type: "attachment",
          label: "证据",
          attachment: {
            maxSizeMb: 999,
            maxCount: 99,
            inlinePdf: false,
            allowedExtensions: [".PDF", " xlsx ", "pdf", ""],
            excelToPdf: true,
            maxPreviewPages: 0,
          },
        },
        {
          id: "detail",
          type: "table",
          label: "明细",
          columns: [{ id: "priority", label: "优先级", type: "radio", options: ["高", "低"], defaultValue: "高" }],
        },
      ],
    }));

    const snapshot = readFormDesignerSnapshot("legacy-form");
    const decision = snapshot?.fields.find((item) => item.id === "decision");
    const reason = snapshot?.fields.find((item) => item.id === "reason");
    const evidence = snapshot?.fields.find((item) => item.id === "evidence");
    const priority = snapshot?.fields.find((item) => item.id === "detail")?.columns?.[0];
    const open = decision?.options?.find((option) => option.label === "打开");
    const closed = decision?.options?.find((option) => option.label === "关闭");
    const high = priority?.options?.find((option) => option.label === "高");

    expect(snapshot?.savedAt).toBe("2026-08-20 09:30");
    expect(snapshot?.fields[0]).toMatchObject({ id: "title", type: "text", required: true });
    expect(decision).toMatchObject({ defaultValue: open?.id, inputStage: "both" });
    expect(reason?.displayCondition?.rules[0].value).toBe(closed?.id);
    expect(evidence?.attachment).toEqual({
      maxSizeMb: 100,
      maxCount: 20,
      inlinePdf: false,
      allowedExtensions: ["pdf", "xlsx"],
      excelToPdf: false,
      maxPreviewPages: 1,
    });
    expect(priority?.defaultValue).toBe(high?.id);
  });

  it("returns undefined for missing, malformed JSON or malformed snapshot shapes", () => {
    expect(readFormDesignerSnapshot("missing")).toBeUndefined();

    window.localStorage.setItem(formKey("invalid-json"), "{");
    expect(readFormDesignerSnapshot("invalid-json")).toBeUndefined();

    window.localStorage.setItem(formKey("invalid-shape"), JSON.stringify({ fields: {} }));
    expect(readFormDesignerSnapshot("invalid-shape")).toBeUndefined();
  });

  it("normalizes legacy approval-node modes and disables repeat editing without authorized fields", () => {
    window.localStorage.setItem(flowKey("legacy-flow"), JSON.stringify({
      nodes: [
        { id: "start", data: { kind: "start", label: "开始" } },
        { id: "empty-review", data: { kind: "approval", label: "空审核", allowRepeatedEditing: true } },
        { id: "editable-review", data: { kind: "approval", label: "可编辑审核", allowRepeatedEditing: true, editableFields: ["comment"] } },
        { id: "end", data: { kind: "end", label: "结束" } },
      ],
      edges: [{ source: "start", target: "empty-review" }],
      meta: { rejectionHandling: "auto-close" },
    }));

    const snapshot = readFlowDesignerSnapshot("legacy-flow");

    expect(snapshot?.nodes.find((node) => node.id === "empty-review")?.data).toMatchObject({
      handlingMode: "approval",
      allowRepeatedEditing: false,
    });
    expect(snapshot?.nodes.find((node) => node.id === "editable-review")?.data).toMatchObject({
      handlingMode: "approval",
      allowRepeatedEditing: true,
    });
    expect(snapshot?.nodes.find((node) => node.id === "start")?.data).toEqual({ kind: "start", label: "开始" });
    expect(snapshot?.meta?.rejectionHandling).toBe("auto-close");
  });

  it("returns undefined for malformed flow artifacts", () => {
    expect(readFlowDesignerSnapshot("missing")).toBeUndefined();

    window.localStorage.setItem(flowKey("invalid-json"), "not-json");
    expect(readFlowDesignerSnapshot("invalid-json")).toBeUndefined();

    window.localStorage.setItem(flowKey("invalid-shape"), JSON.stringify({ nodes: [], edges: "broken" }));
    expect(readFlowDesignerSnapshot("invalid-shape")).toBeUndefined();
  });
});

describe("设计器条件求值与字段可见性", () => {
  const condition = (operator: ConditionOperator, value?: string | string[]): StoredNodeCondition => ({
    mode: "all",
    rules: [{ id: operator, fieldId: "source", operator, value }],
  });

  it.each([
    ["empty", [], undefined, true],
    ["not-empty", "已填写", undefined, true],
    ["contains", ["研发", "质量"], "质量", true],
    ["contains", "流程平台", "平台", true],
    ["not-contains", "流程平台", "财务", true],
    ["gt", "11", "10", true],
    ["gte", "10", "10", true],
    ["lt", "9", "10", true],
    ["lte", "10", "10", true],
    ["gt", "not-a-number", "10", false],
    ["eq", ["china", "shanghai"], "shanghai", true],
    ["eq", ["china", "shanghai"], "china/shanghai", true],
    ["neq", "草稿", "已发布", true],
  ] satisfies Array<[ConditionOperator, unknown, string | undefined, boolean]>) (
    "%s compares stored form values",
    (operator, actual, expected, matches) => {
      const result = evaluateNodeCondition(condition(operator, expected), { source: actual });

      expect(result.matches).toBe(matches);
      expect(result.results).toEqual([expect.objectContaining({ actual, matches })]);
    },
  );

  it("uses any/all semantics and treats an absent condition as visible", () => {
    const rules: StoredNodeCondition["rules"] = [
      { id: "first", fieldId: "status", operator: "eq", value: "已发布" },
      { id: "second", fieldId: "owner", operator: "empty" },
    ];

    expect(evaluateNodeCondition({ mode: "any", rules }, { status: "草稿", owner: "" }).matches).toBe(true);
    expect(evaluateNodeCondition({ mode: "all", rules }, { status: "草稿", owner: "" }).matches).toBe(false);
    expect(evaluateNodeCondition(undefined, {}).matches).toBe(true);
  });

  it("clears hidden array-backed values while retaining fields whose condition matches", () => {
    const hiddenWhenDisabled = (id: string, type: string): StoredDesignerField => field({
      id,
      type,
      label: id,
      displayCondition: {
        mode: "all",
        rules: [{ id: `${id}-visible`, fieldId: "enabled", operator: "eq", value: "yes" }],
      },
    });
    const fields = [
      field({ id: "enabled", type: "radio", label: "是否启用" }),
      hiddenWhenDisabled("checkbox", "checkbox"),
      hiddenWhenDisabled("cascader", "cascader"),
      hiddenWhenDisabled("attachment", "attachment"),
      hiddenWhenDisabled("table", "table"),
      field({
        id: "visible",
        type: "text",
        label: "保留字段",
        displayCondition: { mode: "all", rules: [{ id: "visible-rule", fieldId: "enabled", operator: "eq", value: "no" }] },
      }),
    ];

    expect(applyDesignerFieldVisibility(fields, {
      enabled: "no",
      checkbox: ["old"],
      cascader: ["old"],
      attachment: [{ id: "file" }],
      table: [{ id: "row" }],
      visible: "保留",
    })).toEqual({
      enabled: "no",
      checkbox: [],
      cascader: [],
      attachment: [],
      table: [],
      visible: "保留",
    });
  });
});

describe("设计器工作副本持久化", () => {
  const snapshot = (): CompleteDesignerSnapshot => ({
    form: { fields: [createProcessTitleField()], savedAt: "2026-08-20 11:00" },
    flow: {
      nodes: [{ id: "start", data: { kind: "start", label: "开始" } }],
      edges: [],
      meta: { rejectionHandling: "resubmit-only" },
    },
    systemFields: DEFAULT_SYSTEM_LIST_FIELDS.map((item) => ({ ...item })),
  });

  it("writes, captures and selectively clears all artifacts for one definition", () => {
    const source = snapshot();
    expect(writeWorkingDesignerSnapshot("definition-a", source)).toBe(true);
    window.localStorage.setItem("unrelated-key", "keep");

    const captured = captureWorkingDesignerSnapshot("definition-a");
    expect(captured.form.savedAt).toBe("2026-08-20 11:00");
    expect(captured.flow.meta?.rejectionHandling).toBe("resubmit-only");
    expect(captured.systemFields).toHaveLength(DEFAULT_SYSTEM_LIST_FIELDS.length);
    expect(window.localStorage.getItem(formKey("definition-a"))).not.toBeNull();
    expect(window.localStorage.getItem(flowKey("definition-a"))).not.toBeNull();
    expect(window.localStorage.getItem(systemKey("definition-a"))).not.toBeNull();

    clearDefinitionDesignerArtifacts("definition-a");

    expect(window.localStorage.getItem(formKey("definition-a"))).toBeNull();
    expect(window.localStorage.getItem(flowKey("definition-a"))).toBeNull();
    expect(window.localStorage.getItem(systemKey("definition-a"))).toBeNull();
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep");
  });

  it("returns safe defaults when no working artifacts exist", () => {
    const captured = captureWorkingDesignerSnapshot("new-definition");

    expect(captured.form.fields).toEqual([createProcessTitleField()]);
    expect(captured.flow).toEqual({ nodes: [], edges: [], meta: { rejectionHandling: "resubmit-or-close" } });
    expect(captured.systemFields).toEqual(DEFAULT_SYSTEM_LIST_FIELDS);
  });

  it("reports storage quota failures instead of leaking an exception", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(writeWorkingDesignerSnapshot("full-storage", snapshot())).toBe(false);
  });

  it("returns review-editable scalar, whole-table and selected-column options", () => {
    window.localStorage.setItem(formKey("editable"), JSON.stringify({
      fields: [
        { id: "summary", type: "text", label: "摘要", inputStage: "both" },
        { id: "review-note", type: "text", label: "审核意见", inputStage: "reviewer" },
        { id: "initiator-only", type: "text", label: "发起人字段", inputStage: "initiator" },
        { id: "review-table", type: "table", label: "审核明细", inputStage: "reviewer", columns: [] },
        {
          id: "shared-table",
          type: "table",
          label: "共享明细",
          inputStage: "both",
          columns: [
            { id: "quantity", label: "数量", type: "text", reviewEditable: true },
            { id: "price", label: "价格", type: "text", reviewEditable: false },
          ],
        },
      ],
    }));

    expect(getReviewEditableFieldOptions("editable")).toEqual([
      { value: "summary", label: "摘要" },
      { value: "review-note", label: "审核意见" },
      { value: "review-table", label: "审核明细（整表）" },
      { value: "shared-table.quantity", label: "共享明细 / 数量" },
    ]);
    expect(getReviewEditableFieldOptions("missing")).toEqual([]);
  });
});

describe("完整设计快照迁移", () => {
  it("creates an isolated default snapshot when no version exists", () => {
    const first = cloneCompleteDesignerSnapshot();
    const second = cloneCompleteDesignerSnapshot();

    first.form.fields[0].label = "被修改";
    expect(second.form.fields[0].label).toBe("标题");
    expect(second.flow.meta?.rejectionHandling).toBe("resubmit-or-close");
    expect(second.systemFields).toEqual(DEFAULT_SYSTEM_LIST_FIELDS);
  });

  it("migrates legacy title visibility, attachment limits, notifications and system exports", () => {
    const source: CompleteDesignerSnapshot = {
      form: {
        fields: [
          { ...createProcessTitleField(), inputStage: "reviewer" },
          {
            id: "evidence",
            type: "attachment",
            label: "附件",
            attachment: { inlinePdf: true, maxSizeMb: 0, maxCount: 8, allowedExtensions: undefined, excelToPdf: true, maxPreviewPages: 99 },
          },
        ],
      },
      flow: {
        nodes: [
          {
            id: "review",
            data: {
              kind: "approval",
              allowRepeatedEditing: true,
              editableFields: [],
              activationCondition: { mode: "all", rules: [{ id: "empty", fieldId: "title", operator: "empty", value: "legacy" }] },
              emailNotification: {
                enabled: true,
                notifyReviewers: true,
                notifyInitiator: true,
                extraUserIds: undefined,
              } as never,
            },
          },
          {
            id: "end",
            data: {
              kind: "end",
              emailNotification: {
                enabled: true,
                notifyReviewers: true,
                notifyInitiator: true,
                extraUserIds: ["observer"],
              },
            },
          },
          { id: "damaged" },
        ],
        edges: [],
      },
      systemFields: [
        {
          key: "title",
          label: "标题",
          description: "旧标题列",
          taskVisible: false,
          processListVisible: false,
          exportVisible: false,
        } as never,
        {
          key: "status",
          label: "状态",
          description: "状态",
          taskVisible: true,
          processListVisible: true,
          exportVisible: undefined,
        } as never,
      ],
    };

    const cloned = cloneCompleteDesignerSnapshot(source);
    const title = cloned.form.fields.find((item) => item.id === "title");
    const attachment = cloned.form.fields.find((item) => item.id === "evidence")?.attachment;
    const review = cloned.flow.nodes.find((node) => node.id === "review")?.data;
    const end = cloned.flow.nodes.find((node) => node.id === "end")?.data;

    expect(title).toMatchObject({ inputStage: "initiator", taskVisible: false, listVisible: false });
    expect(attachment).toEqual({
      maxSizeMb: 1,
      maxCount: 1,
      inlinePdf: true,
      allowedExtensions: ["pdf", "xlsx"],
      excelToPdf: true,
      maxPreviewPages: 50,
    });
    expect(review).toMatchObject({
      handlingMode: "approval",
      allowRepeatedEditing: false,
      activationCondition: { mode: "all", rules: [{ id: "empty", fieldId: "title", operator: "empty", value: "" }] },
      emailNotification: {
        enabled: true,
        notifyReviewers: true,
        notifyInitiator: false,
        extraUserIds: [],
      },
    });
    expect(end?.emailNotification).toEqual({
      enabled: true,
      notifyReviewers: false,
      notifyInitiator: true,
      extraUserIds: ["observer"],
    });
    expect(cloned.flow.nodes.find((node) => node.id === "damaged")?.data).toBeUndefined();
    expect(cloned.systemFields).toEqual([
      expect.objectContaining({ key: "status", exportVisible: true }),
    ]);
    expect(source.systemFields).toHaveLength(2);
  });
});

describe("流程展示工具", () => {
  it("provides stable Chinese labels with a safe rejection fallback", () => {
    expect(conditionOperatorLabel("gte")).toBe("大于等于");
    expect(conditionOperatorLabel("not-contains")).toBe("不包含");
    expect(rejectionHandlingLabel("resubmit-only")).toBe("仅允许重新提交");
    expect(rejectionHandlingLabel("unknown")).toBe("重新提交或关闭");
    expect(rejectionHandlingLabel()).toBe("重新提交或关闭");
  });

  it("builds deterministic parallel levels and ignores edges to deleted nodes", () => {
    expect(buildFlowLevels(
      [{ id: "start" }, { id: "left" }, { id: "right" }, { id: "end" }, { id: "orphan" }],
      [
        { source: "start", target: "left" },
        { source: "start", target: "right" },
        { source: "left", target: "end" },
        { source: "right", target: "end" },
        { source: "deleted", target: "end" },
      ],
    )).toEqual([["start", "orphan"], ["left", "right"], ["end"]]);

    expect(buildFlowLevels(
      [{ id: "cycle-a" }, { id: "cycle-b" }],
      [{ source: "cycle-a", target: "cycle-b" }, { source: "cycle-b", target: "cycle-a" }],
    )).toEqual([["cycle-a", "cycle-b"]]);
  });
});
