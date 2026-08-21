import { describe, expect, it } from "vitest";
import type { WorkflowPermissionGroup } from "../state/useIdentityStore";
import {
  createProcessTitleField,
  type CompleteDesignerSnapshot,
  type StoredDesignerField,
  type StoredFlowEdgeSnapshot,
  type StoredFlowNodeSnapshot,
} from "./designerStorage";
import { validateApprovalFlow, validateProcessSnapshot } from "./processDefinitionValidation";

const workflowGroup = (
  id: string,
  name: string,
  purposes: WorkflowPermissionGroup["purposes"],
  status: WorkflowPermissionGroup["status"] = "启用",
): WorkflowPermissionGroup => ({
  id,
  code: id,
  name,
  processes: [],
  purposes,
  directMembers: [],
  linkedRoles: [],
  status,
  referenced: false,
  openTasks: 0,
  updatedAt: "2026-08-20 10:00",
});

const groups = [
  workflowGroup("starter", "发起组", ["发起"]),
  workflowGroup("reviewer", "审核组", ["审批/受理"]),
  workflowGroup("closer", "关闭组", ["关闭"]),
];

const context = {
  workflowGroups: groups,
  effectiveMemberIds: (groupId: string) => groupId === "empty" ? [] : ["user-1"],
};

const flowNode = (
  id: string,
  kind: "start" | "approval" | "end",
  overrides: Partial<NonNullable<StoredFlowNodeSnapshot["data"]>> = {},
): StoredFlowNodeSnapshot => ({
  id,
  data: {
    kind,
    label: id,
    permissionGroups: kind === "start" ? ["starter"] : undefined,
    permissionGroup: kind === "approval" ? "reviewer" : undefined,
    editableFields: kind === "approval" ? [] : undefined,
    ...overrides,
  },
});

const serialNodes = () => [
  flowNode("start", "start", { label: "开始" }),
  flowNode("review", "approval", { label: "审核" }),
  flowNode("end", "end", { label: "结束" }),
];

const serialEdges: StoredFlowEdgeSnapshot[] = [
  { source: "start", target: "review" },
  { source: "review", target: "end" },
];

const check = (checks: ReturnType<typeof validateApprovalFlow>, key: string) => {
  const result = checks.find((item) => item.key === key);
  expect(result, `缺少 ${key} 校验项`).toBeDefined();
  return result!;
};

const validApprovalSnapshot = (): CompleteDesignerSnapshot => ({
  form: { fields: [createProcessTitleField()] },
  flow: { nodes: serialNodes(), edges: serialEdges },
  systemFields: [],
});

describe("流程发布校验边界", () => {
  it("accepts a complete approval process and resolves permission groups by display name", () => {
    const snapshot = validApprovalSnapshot();
    snapshot.flow.nodes[0].data!.permissionGroups = ["发起组"];
    snapshot.flow.nodes[1].data = {
      ...snapshot.flow.nodes[1].data,
      permissionGroup: "审核组",
      activationCondition: {
        mode: "all",
        rules: [{ id: "title-present", fieldId: "title", operator: "not-empty" }],
      },
      emailNotification: {
        enabled: true,
        notifyReviewers: true,
        extraUserIds: [],
      },
    };
    snapshot.flow.nodes[2].data = {
      ...snapshot.flow.nodes[2].data,
      emailNotification: {
        enabled: true,
        notifyInitiator: true,
        extraUserIds: [],
      },
    };

    const result = validateProcessSnapshot({
      name: "变更审批",
      instancePrefix: "CHANGE_2026",
      type: "approval",
      starterGroups: ["发起组"],
      closeGroups: ["关闭组"],
    }, snapshot, context);

    expect(result).toMatchObject({ status: "通过", issues: [] });
    expect(result.checks).toHaveLength(9);
    expect(result.checks.every((item) => item.pass)).toBe(true);
  });

  it("returns a precise connectivity reason for every malformed graph class", () => {
    const cases: Array<{
      name: string;
      nodes: StoredFlowNodeSnapshot[];
      edges: StoredFlowEdgeSnapshot[];
      detail: string;
    }> = [
      {
        name: "cycle",
        nodes: [
          flowNode("start", "start"),
          flowNode("a", "approval"),
          flowNode("b", "approval"),
          flowNode("end", "end"),
        ],
        edges: [
          { source: "start", target: "a" },
          { source: "a", target: "b" },
          { source: "b", target: "a" },
          { source: "b", target: "end" },
        ],
        detail: "流程中存在循环连线",
      },
      {
        name: "dangling edge",
        nodes: serialNodes(),
        edges: [{ source: "start", target: "review" }, { source: "review", target: "deleted" }],
        detail: "存在连接到已删除节点的连线",
      },
      {
        name: "duplicate edge",
        nodes: serialNodes(),
        edges: [...serialEdges, { source: "start", target: "review" }],
        detail: "存在自连接或重复连线",
      },
      {
        name: "invalid terminal direction",
        nodes: serialNodes(),
        edges: [{ source: "review", target: "start" }, { source: "start", target: "end" }],
        detail: "节点出入方向不完整：开始、审核",
      },
      {
        name: "disconnected unknown node",
        nodes: [...serialNodes(), { id: "orphan", data: { label: "孤岛" } }],
        edges: serialEdges,
        detail: "未连通节点：孤岛",
      },
      {
        name: "missing terminals",
        nodes: [],
        edges: [],
        detail: "请先修正开始与结束节点",
      },
    ];

    cases.forEach(({ name, nodes, edges, detail }) => {
      const connected = check(validateApprovalFlow(nodes, edges, [createProcessTitleField()]), "connected");
      expect(connected.pass, name).toBe(false);
      expect(connected.detail, name).toBe(detail);
    });
  });

  it("rejects missing, unknown, wrong-purpose and memberless node permission groups", () => {
    const nodes = [
      flowNode("start", "start", { label: "发起", permissionGroups: [] }),
      flowNode("missing", "approval", { label: "未选审批", permissionGroup: "" }),
      flowNode("unknown", "approval", { label: "未知审批", permissionGroup: "not-found" }),
      flowNode("wrong", "approval", { label: "用途错误", permissionGroup: "starter" }),
      flowNode("empty", "approval", { label: "无人审批", permissionGroup: "empty" }),
      flowNode("end", "end"),
    ];
    const permissionContext = {
      workflowGroups: [...groups, workflowGroup("empty", "空审核组", ["审批/受理"])],
      effectiveMemberIds: context.effectiveMemberIds,
    };

    const groupsCheck = check(validateApprovalFlow(nodes, [], [createProcessTitleField()], permissionContext), "groups");

    expect(groupsCheck.pass).toBe(false);
    expect(groupsCheck.detail).toContain("发起：未选择发起流程权限组");
    expect(groupsCheck.detail).toContain("未选审批：未选择流程权限组");
    expect(groupsCheck.detail).toContain("流程权限组“not-found”不存在");
    expect(groupsCheck.detail).toContain("流程权限组“发起组”不具备“审批/受理”用途");
    expect(groupsCheck.detail).toContain("流程权限组“空审核组”没有有效成员");
  });

  it("rejects incomplete execution rules, unowned reviewer fields, unsafe repeat editing and recipientless email", () => {
    const fields: StoredDesignerField[] = [
      createProcessTitleField(),
      {
        id: "departments",
        type: "checkbox",
        label: "涉及部门",
        options: [{ id: "rd", label: "研发" }],
      },
      {
        id: "decision",
        type: "select",
        label: "结论",
        options: [{ id: "pass", label: "通过" }],
      },
      { id: "review-comment", type: "text", label: "审核意见", inputStage: "reviewer", required: true },
    ];
    const nodes = [
      flowNode("start", "start"),
      flowNode("checkbox-rule", "approval", {
        activationCondition: {
          mode: "all",
          rules: [{ id: "bad-checkbox", fieldId: "departments", operator: "eq", value: "rd" }],
        },
        allowRepeatedEditing: true,
        editableFields: [],
        emailNotification: { enabled: true, extraUserIds: [] },
      }),
      flowNode("missing-option", "approval", {
        activationCondition: {
          mode: "all",
          rules: [{ id: "bad-option", fieldId: "decision", operator: "eq", value: "removed" }],
        },
      }),
      flowNode("missing-field", "approval", {
        activationCondition: {
          mode: "all",
          rules: [{ id: "bad-field", fieldId: "deleted", operator: "eq", value: "x" }],
        },
      }),
      flowNode("end", "end", {
        emailNotification: { enabled: true, extraUserIds: [] },
      }),
    ];

    const checks = validateApprovalFlow(nodes, [], fields);

    expect(check(checks, "conditions")).toMatchObject({
      pass: false,
      detail: "条件配置不完整：checkbox-rule、missing-option、missing-field",
    });
    expect(check(checks, "reviewer-required")).toMatchObject({
      pass: false,
      detail: "尚未分配负责节点：审核意见",
    });
    expect(check(checks, "repeated-editing")).toMatchObject({
      pass: false,
      detail: "请先配置可修改字段：checkbox-rule",
    });
    expect(check(checks, "email-notification")).toMatchObject({
      pass: false,
      detail: "已启用邮件但未选择收件人：checkbox-rule、end",
    });
  });

  it("accepts supported checkbox, numeric text and stable option conditions", () => {
    const fields: StoredDesignerField[] = [
      createProcessTitleField(),
      { id: "departments", type: "checkbox", label: "部门", options: [{ id: "rd", label: "研发" }] },
      { id: "amount", type: "text", label: "金额" },
      { id: "decision", type: "radio", label: "结论", options: [{ id: "pass", label: "通过" }] },
      { id: "comment", type: "text", label: "意见", inputStage: "reviewer", required: true },
    ];
    const nodes = [
      flowNode("start", "start"),
      flowNode("department-review", "approval", {
        activationCondition: { mode: "all", rules: [{ id: "department", fieldId: "departments", operator: "contains", value: "rd" }] },
      }),
      flowNode("amount-review", "approval", {
        activationCondition: { mode: "all", rules: [{ id: "amount", fieldId: "amount", operator: "gte", value: "1000" }] },
      }),
      flowNode("decision-review", "approval", {
        editableFields: ["comment"],
        activationCondition: { mode: "all", rules: [{ id: "decision", fieldId: "decision", operator: "eq", value: "pass" }] },
        allowRepeatedEditing: true,
        emailNotification: { enabled: true, extraUserIds: ["auditor"] },
      }),
      flowNode("end", "end"),
    ];
    const edges = [
      { source: "start", target: "department-review" },
      { source: "department-review", target: "amount-review" },
      { source: "amount-review", target: "decision-review" },
      { source: "decision-review", target: "end" },
    ];

    const checks = validateApprovalFlow(nodes, edges, fields);

    expect(check(checks, "conditions").pass).toBe(true);
    expect(check(checks, "reviewer-required").pass).toBe(true);
    expect(check(checks, "repeated-editing").pass).toBe(true);
    expect(check(checks, "email-notification").pass).toBe(true);
  });

  it("rejects branches that do not start with approvals or share a common join", () => {
    const invalidDirectTarget = validateApprovalFlow(
      [flowNode("start", "start"), flowNode("review", "approval"), flowNode("end", "end")],
      [
        { source: "start", target: "review" },
        { source: "start", target: "end" },
        { source: "review", target: "end" },
      ],
      [createProcessTitleField()],
    );
    expect(check(invalidDirectTarget, "parallel-topology")).toMatchObject({
      pass: false,
      detail: "start 的多条分支需要直接连接审批节点并汇聚到同一后续节点",
    });

    const noCommonJoin = validateApprovalFlow(
      [
        flowNode("start", "start"),
        flowNode("left", "approval"),
        flowNode("right", "approval"),
        flowNode("left-end", "end"),
        flowNode("right-end", "end"),
      ],
      [
        { source: "start", target: "left" },
        { source: "start", target: "right" },
        { source: "left", target: "left-end" },
        { source: "right", target: "right-end" },
      ],
      [createProcessTitleField()],
    );
    expect(check(noCommonJoin, "parallel-topology").pass).toBe(false);
  });

  it("names a conflicting review-editable table column across parallel branches", () => {
    const table: StoredDesignerField = {
      id: "detail",
      type: "table",
      label: "明细",
      inputStage: "both",
      columns: [{ id: "quantity", label: "数量", type: "text", reviewEditable: true }],
    };
    const nodes = [
      flowNode("start", "start"),
      flowNode("left", "approval", { label: "研发审核", editableFields: ["detail.quantity"] }),
      flowNode("right", "approval", { label: "质量审核", editableFields: ["detail.quantity"] }),
      flowNode("join", "approval"),
      flowNode("end", "end"),
    ];
    const checks = validateApprovalFlow(nodes, [
      { source: "start", target: "left" },
      { source: "start", target: "right" },
      { source: "left", target: "join" },
      { source: "right", target: "join" },
      { source: "join", target: "end" },
    ], [createProcessTitleField(), table]);

    expect(check(checks, "parallel-topology").pass).toBe(true);
    expect(check(checks, "field-conflict")).toMatchObject({
      pass: false,
      detail: "发现冲突：明细 / 数量（研发审核、质量审核）",
    });
  });

  it("reports invalid basics, fixed-title corruption, option trees and display conditions without duplicates", () => {
    const snapshot: CompleteDesignerSnapshot = {
      form: {
        fields: [
          {
            ...createProcessTitleField(),
            inputStage: "reviewer",
            displayCondition: { mode: "all", rules: [{ id: "title-rule", fieldId: "choice", operator: "eq", value: "yes" }] },
          },
          {
            id: "choice",
            type: "cascader",
            label: "选择",
            options: [{ id: "root", label: "区域", children: [{ id: "duplicate", label: "" }] }],
          },
          {
            id: "detail",
            type: "table",
            label: "明细",
            columns: [{ id: "type", label: "类型", type: "select", options: [] }],
          },
        ],
      },
      flow: { nodes: [], edges: [] },
      systemFields: [],
    };

    const result = validateProcessSnapshot({
      name: " ",
      instancePrefix: "BAD PREFIX",
      type: "free",
      starterGroups: [],
      closeGroups: [],
      assigneeGroups: [],
    }, snapshot);

    expect(result.status).toBe("未通过");
    expect(result.checks).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      "流程名称不能为空",
      "实例编号前缀只能包含字母、数字、横线和下划线",
      "至少选择一个发起流程权限组",
      "至少选择一个关闭流程权限组",
      "至少选择一个受理流程权限组",
      "标题必须由发起人填写",
      "单选、复选、下拉或多级下拉存在空白、重复或缺失的选项",
      "初始表单存在无效或未填写完整的字段显示条件",
    ]));
    expect(new Set(result.issues).size).toBe(result.issues.length);
  });

  it("rejects missing or malformed fixed titles and forward, missing, unsupported display-condition sources", () => {
    const basics = {
      name: "自由协作",
      instancePrefix: "FREE",
      type: "free" as const,
      starterGroups: ["starter"],
      closeGroups: ["closer"],
      assigneeGroups: ["reviewer"],
    };
    const invalidFields: StoredDesignerField[][] = [
      [],
      [{ ...createProcessTitleField(), type: "radio", options: [{ id: "title-option", label: "标题" }] }],
      [
        createProcessTitleField(),
        { id: "dependent", type: "text", label: "依赖字段", displayCondition: { mode: "all", rules: [{ id: "forward", fieldId: "later", operator: "eq", value: "x" }] } },
        { id: "later", type: "text", label: "后置字段" },
      ],
      [
        createProcessTitleField(),
        { id: "dependent", type: "text", label: "依赖字段", displayCondition: { mode: "all", rules: [{ id: "missing", fieldId: "deleted", operator: "eq", value: "x" }] } },
      ],
      [
        createProcessTitleField(),
        { id: "table", type: "table", label: "明细" },
        { id: "dependent", type: "text", label: "依赖字段", displayCondition: { mode: "all", rules: [{ id: "table", fieldId: "table", operator: "eq", value: "x" }] } },
      ],
    ];

    const results = invalidFields.map((fields) => validateProcessSnapshot(basics, {
      form: { fields },
      flow: { nodes: [], edges: [] },
      systemFields: [],
    }, context));

    expect(results[0].issues).toContain("初始表单必须包含系统固定的标题文本框");
    expect(results[1].issues).toContain("初始表单必须包含系统固定的标题文本框");
    results.slice(2).forEach((result) => {
      expect(result.issues).toContain("初始表单存在无效或未填写完整的字段显示条件");
    });
  });

  it("accepts a free process with valid backward display conditions and no flow checks", () => {
    const snapshot: CompleteDesignerSnapshot = {
      form: {
        fields: [
          createProcessTitleField(),
          { id: "decision", type: "select", label: "是否需要", options: [{ id: "yes", label: "是" }] },
          {
            id: "reason",
            type: "text",
            label: "原因",
            displayCondition: { mode: "all", rules: [{ id: "decision-is-yes", fieldId: "decision", operator: "eq", value: "yes" }] },
          },
        ],
      },
      flow: { nodes: [], edges: [] },
      systemFields: [],
    };

    const result = validateProcessSnapshot({
      name: "自由协作",
      instancePrefix: "FREE-2026",
      type: "free",
      starterGroups: ["starter"],
      closeGroups: ["closer"],
      assigneeGroups: ["reviewer"],
    }, snapshot, context);

    expect(result).toEqual({ status: "通过", issues: [], checks: [] });
  });
});
